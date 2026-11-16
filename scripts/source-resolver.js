'use strict'

const { toObjectKey } = require('./media-keys')
const { isSafeTrainerVideoSource } = require('./source-key-policy')

function mediaSourceKeys(media) {
  const keys = []
  for (const gender of ['male', 'female']) {
    const entry = media?.[gender]
    if (!entry || typeof entry !== 'object') continue
    const key = toObjectKey(entry.key) || toObjectKey(entry.url)
    if (key) keys.push([key, gender])
  }
  return keys
}

async function resolveSources(exercise, { objectExists, sourceMap }) {
  const mappedSlug = sourceMap[exercise.id]?.slug
  const sources = []
  const add = (key, gender, alreadyProcessed = false) => {
    if (!sources.some((item) => item.key === key)) sources.push({ key, gender, alreadyProcessed })
  }

  if (mappedSlug) {
    for (const gender of ['male', 'female']) {
      const key = `free-exercise/${mappedSlug}/${gender}/original.mp4`
      const folder = key.slice(0, key.lastIndexOf('/') + 1)
      if (await objectExists(key)) add(key, gender)
      else if (await objectExists(`${folder}hls/master.m3u8`)) add(key, gender, true)
    }
  }

  // Private trainer sources must use an isolated per-file directory. In
  // particular, never probe/process/delete legacy shared-folder sources.
  if (!sources.length) {
    const primary = toObjectKey(exercise.originalVideoKey)
    if (primary && isSafeTrainerVideoSource(primary) && await objectExists(primary)) {
      const parts = primary.split('/')
      const gender = ['male', 'female'].includes(parts.at(-2)) ? parts.at(-2) : null
      add(primary, gender)
    }
    for (const [key, gender] of mediaSourceKeys(exercise.media)) {
      if (isSafeTrainerVideoSource(key) && await objectExists(key)) add(key, gender)
    }
  }

  if (!sources.length) {
    const checked = mappedSlug
      ? ['male', 'female'].map((gender) => `free-exercise/${mappedSlug}/${gender}/original.mp4`)
      : [toObjectKey(exercise.originalVideoKey), ...mediaSourceKeys(exercise.media).map(([key]) => key)].filter(Boolean)
    throw new Error(`No safe source object found in R2. Checked: ${checked.join(', ') || '(no valid keys)'}`)
  }
  return sources
}

module.exports = { resolveSources }
