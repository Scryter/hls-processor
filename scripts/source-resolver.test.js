'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveSources } = require('./source-resolver')

const uuid = '11111111-1111-4111-8111-111111111111'

test('resolves a current sanitized private MP4 upload', async () => {
  const checked = []
  const result = await resolveSources({ id: 'exercise-1', originalVideoKey: `exercises/trainer/${uuid}/${uuid}/treino_mp4` }, {
    objectExists: async (key) => { checked.push(key); return true },
    sourceMap: {},
  })
  assert.deepEqual(result, [{ key: `exercises/trainer/${uuid}/${uuid}/treino_mp4`, gender: null, alreadyProcessed: false }])
  assert.deepEqual(checked, [`exercises/trainer/${uuid}/${uuid}/treino_mp4`])
})

test('does not inspect or accept a legacy shared source directory', async () => {
  const checked = []
  await assert.rejects(resolveSources({ id: 'legacy', originalVideoKey: 'exercises/trainer/old-batch/video.mp4' }, {
    objectExists: async (key) => { checked.push(key); return true }, sourceMap: {},
  }), /No safe source object found/i)
  assert.deepEqual(checked, [])
})

test('does not process an unsupported private video format', async () => {
  const checked = []
  await assert.rejects(resolveSources({ id: 'wmv', originalVideoKey: `exercises/trainer/${uuid}/${uuid}/treino_wmv` }, {
    objectExists: async (key) => { checked.push(key); return true }, sourceMap: {},
  }), /No safe source object found/i)
  assert.deepEqual(checked, [])
})

test('keeps explicitly mapped public catalog sources on their existing paths', async () => {
  const result = await resolveSources({ id: 'catalog-exercise' }, {
    objectExists: async (key) => key === 'free-exercise/squat/male/original.mp4',
    sourceMap: { 'catalog-exercise': { slug: 'squat' } },
  })
  assert.deepEqual(result, [{ key: 'free-exercise/squat/male/original.mp4', gender: 'male', alreadyProcessed: false }])
})
