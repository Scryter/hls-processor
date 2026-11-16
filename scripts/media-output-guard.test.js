'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { assertSafeWorkspace, readRegularFile } = require('./media-output-guard')

function withWorkspace(callback) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'media-output-guard-'))
  const workspace = path.join(parent, 'workspace')
  fs.mkdirSync(workspace)
  try {
    callback({ parent, workspace })
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
}

test('allows reading a regular media output inside the workspace', () => {
  withWorkspace(({ workspace }) => {
    const output = path.join(workspace, 'hls', 'playlist.m3u8')
    fs.mkdirSync(path.dirname(output))
    fs.writeFileSync(output, '#EXTM3U\n# synthetic fixture\n')

    assert.deepEqual(readRegularFile(workspace, output), Buffer.from('#EXTM3U\n# synthetic fixture\n'))
    assert.doesNotThrow(() => assertSafeWorkspace(workspace))
  })
})

test('rejects a media output symlink before the host can read it for upload', () => {
  withWorkspace(({ parent, workspace }) => {
    const outside = path.join(parent, 'synthetic-host-file')
    const output = path.join(workspace, 'secret.ts')
    fs.writeFileSync(outside, 'synthetic host marker')
    fs.symlinkSync(outside, output)

    assert.throws(() => readRegularFile(workspace, output), /symbolic link/i)
    assert.throws(() => assertSafeWorkspace(workspace), /symbolic link/i)
  })
})

test('rejects a parent-directory symlink swapped between validation and open', () => {
  withWorkspace(({ parent, workspace }) => {
    const mediaDirectory = path.join(workspace, 'hls')
    const output = path.join(mediaDirectory, 'playlist.m3u8')
    const outsideDirectory = path.join(parent, 'synthetic-outside')
    const originalDirectory = path.join(parent, 'original-hls')
    fs.mkdirSync(mediaDirectory)
    fs.mkdirSync(outsideDirectory)
    fs.writeFileSync(output, '# inside workspace')
    fs.writeFileSync(path.join(outsideDirectory, 'playlist.m3u8'), 'synthetic outside marker')

    const resolvedOutput = fs.realpathSync(output)
    const originalOpenSync = fs.openSync
    let swapped = false
    fs.openSync = function (target, ...args) {
      if (target === resolvedOutput && !swapped) {
        fs.renameSync(mediaDirectory, originalDirectory)
        fs.symlinkSync(outsideDirectory, mediaDirectory, 'dir')
        swapped = true
      }
      return originalOpenSync.call(fs, target, ...args)
    }

    try {
      assert.throws(() => readRegularFile(workspace, output), /outside the workspace/i)
      assert.equal(swapped, true)
    } finally {
      fs.openSync = originalOpenSync
    }
  })
})

test('rejects paths outside the workspace and special files', () => {
  withWorkspace(({ parent, workspace }) => {
    const outside = path.join(parent, 'outside.ts')
    fs.writeFileSync(outside, 'synthetic only')
    assert.throws(() => readRegularFile(workspace, outside), /outside the workspace/i)
  })
})
