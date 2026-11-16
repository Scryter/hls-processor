'use strict'

function validateExerciseId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error('Invalid exercise id')
  }
  return id
}

module.exports = { validateExerciseId }
