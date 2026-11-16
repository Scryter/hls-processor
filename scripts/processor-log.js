'use strict'

function itemLabel(index, total) {
  return `item ${index + 1}/${total}`
}

function variantLabel(index, total) {
  return `video variant ${index + 1}/${total}`
}

function safeErrorLabel(error) {
  const status = Number(error?.$metadata?.httpStatusCode)
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return `processing failed (HTTP ${status})`
  }
  return 'processing failed (details withheld)'
}

module.exports = { itemLabel, variantLabel, safeErrorLabel }
