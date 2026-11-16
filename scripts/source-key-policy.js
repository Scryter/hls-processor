'use strict'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Accept only the current isolated per-file layout and formats exposed by the uploader. */
function sourceExtensionForKey(key) {
  if (typeof key !== 'string') return null
  const match = /[_.]([a-z0-9]+)$/i.exec(key.split('/').at(-1) || '')
  if (!match || !['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(match[1].toLowerCase())) return null
  return `.${match[1].toLowerCase()}`
}

function isSafeTrainerVideoSource(key) {
  if (typeof key !== 'string') return false
  const parts = key.split('/')
  return parts.length === 5
    && parts[0] === 'exercises'
    && /^[a-zA-Z0-9_-]{1,128}$/.test(parts[1])
    && UUID.test(parts[2])
    && UUID.test(parts[3])
    && /^[a-zA-Z0-9_-]{1,100}(?:_[a-zA-Z0-9]+|\.[a-zA-Z0-9]+)$/.test(parts[4])
    && sourceExtensionForKey(key) !== null
}

module.exports = { isSafeTrainerVideoSource, sourceExtensionForKey }
