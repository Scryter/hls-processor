'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { itemLabel, variantLabel, safeErrorLabel } = require('./processor-log')

test('log labels expose queue position without exercise names or identifiers', () => {
  assert.equal(itemLabel(2, 8), 'item 3/8')
  assert.equal(variantLabel(0, 2), 'video variant 1/2')
})

test('error summaries retain HTTP status but omit provider messages and object keys', () => {
  const secretKey = 'exercises/private-trainer/upload-123/original.mp4'
  assert.equal(safeErrorLabel({ message: `NoSuchKey ${secretKey}`, $metadata: { httpStatusCode: 404 } }), 'processing failed (HTTP 404)')
  assert.equal(safeErrorLabel({ message: `Failed for ${secretKey}` }), 'processing failed (details withheld)')
})

test('processor logs do not interpolate exercise names, ids, source keys, or raw errors', () => {
  const source = fs.readFileSync(path.join(__dirname, 'processor.js'), 'utf8')
  assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*(?:ex\.name|ex\.id|source\.key|err\.message)/)
  assert.doesNotMatch(source, /stdio:\s*'inherit'/)
})
