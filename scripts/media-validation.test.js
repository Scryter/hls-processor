'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readOriginalHeight } = require('./media-validation')

test('reads a positive integer video height from ffprobe', () => {
  const result = readOriginalHeight('input.mp4', '/tmp/job', () => '1080\n')
  assert.equal(result, 1080)
})

test('fails closed when ffprobe returns missing, malformed, or non-positive height', () => {
  for (const output of ['', 'N/A', '0', '-720', '720\n1080', '1.5']) {
    assert.throws(() => readOriginalHeight('input.mp4', '/tmp/job', () => output), /validar a resolução/i)
  }
})

test('fails closed when ffprobe exits with an error instead of assuming an uncapped height', () => {
  assert.throws(
    () => readOriginalHeight('input.mp4', '/tmp/job', () => { throw new Error('decoder detail') }),
    { message: 'Não foi possível validar a resolução do vídeo.' },
  )
})
