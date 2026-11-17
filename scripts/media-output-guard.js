'use strict'

const fs = require('node:fs')
const path = require('node:path')

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function assertSafeWorkspace(workdir) {
  const rootInfo = fs.lstatSync(workdir)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('Media workspace is not a plain directory')
  }

  const root = fs.realpathSync(workdir)
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      const info = fs.lstatSync(candidate)
      if (info.isSymbolicLink()) throw new Error('Media workspace contains a symbolic link')
      if (info.isDirectory()) pending.push(candidate)
      else if (!info.isFile()) throw new Error('Media workspace contains a non-regular file')
    }
  }
}

function resolveRegularFile(workdir, filePath) {
  const rootInfo = fs.lstatSync(workdir)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Invalid media workspace')
  const root = fs.realpathSync(workdir)
  const candidate = path.resolve(filePath)
  if (!isWithin(root, candidate)) throw new Error('Media output is outside the workspace')

  const relative = path.relative(root, candidate)
  const parts = relative.split(path.sep)
  let current = root
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index])
    const info = fs.lstatSync(current)
    if (info.isSymbolicLink()) throw new Error('Media output path contains a symbolic link')
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error('Media output path is not a directory')
    if (index === parts.length - 1 && !info.isFile()) throw new Error('Media output is not a regular file')
  }

  const resolved = fs.realpathSync(current)
  if (!isWithin(root, resolved)) throw new Error('Resolved media output is outside the workspace')
  return resolved
}

function readRegularFile(workdir, filePath) {
  const resolved = resolveRegularFile(workdir, filePath)
  const noFollow = fs.constants.O_NOFOLLOW || 0
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow)
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Media output is not a regular file')
    // Resolve the opened descriptor, not just the pathname checked above. This
    // closes the parent-directory replacement race between lstat and open.
    let openedPath
    try {
      openedPath = fs.realpathSync(`/proc/self/fd/${descriptor}`)
    } catch {
      throw new Error('Cannot verify the opened media output path')
    }
    const root = fs.realpathSync(workdir)
    if (!isWithin(root, openedPath)) throw new Error('Opened media output is outside the workspace')
    return fs.readFileSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

module.exports = { assertSafeWorkspace, readRegularFile }
