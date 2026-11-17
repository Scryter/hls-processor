'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { isSafeTrainerVideoSource, sourceExtensionForKey } = require('./source-key-policy')

const uuid = '11111111-1111-4111-8111-111111111111'

test('accepts current per-file upload keys and detects the sanitized video extension', () => {
  for (const extension of ['mp4', 'mov', 'avi', 'mkv', 'webm']) {
    const key = `exercises/trainer/${uuid}/${uuid}/treino_${extension}`
    assert.equal(isSafeTrainerVideoSource(key), true)
    assert.equal(sourceExtensionForKey(key), `.${extension}`)
  }
  assert.equal(sourceExtensionForKey(`exercises/trainer/${uuid}/${uuid}/original.mp4`), '.mp4')
  assert.equal(isSafeTrainerVideoSource(`exercises/trainer/${uuid}/${uuid}/original.mp4`), true)
})

test('rejects legacy shared directories before the processor can delete the source', () => {
  assert.equal(isSafeTrainerVideoSource('exercises/trainer/old-batch/treino.mp4'), false)
})

test('rejects unsupported formats even when they use a per-file directory', () => {
  assert.equal(isSafeTrainerVideoSource(`exercises/trainer/${uuid}/${uuid}/treino_wmv`), false)
})

test('rejects malformed and traversal keys', () => {
  assert.equal(isSafeTrainerVideoSource(`exercises/../${uuid}/${uuid}/treino_mp4`), false)
  assert.equal(isSafeTrainerVideoSource(`exercises/trainer/${uuid}/../treino_mp4`), false)
  assert.equal(isSafeTrainerVideoSource(`exercises/trainer/${uuid}/${uuid}/../treino_mp4`), false)
})
