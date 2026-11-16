'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { validateExerciseId } = require('./processor-id')

test('accepts ordinary persisted exercise identifiers', () => {
  assert.equal(validateExerciseId('cmwapt3qr0003h03nldqqngr1'), 'cmwapt3qr0003h03nldqqngr1')
  assert.equal(validateExerciseId('legacy_exercise-01'), 'legacy_exercise-01')
})

test('rejects identifiers that can escape the temporary directory prefix', () => {
  for (const id of ['../outside', '..\\outside', 'x/y', 'x\\y', '', null, 42, 'a'.repeat(129)]) {
    assert.throws(() => validateExerciseId(id), /Invalid exercise id/)
  }
})
