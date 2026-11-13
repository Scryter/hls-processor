'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const { executarFerramenta } = require('./media-tool-runner')

test('runs media binaries without inheriting API and storage credentials', () => {
  let chamada
  const origem = {
    PATH: '/usr/bin:/bin',
    R2_ACCOUNT_ID: 'account-secret',
    R2_ACCESS_KEY_ID: 'access-secret',
    R2_SECRET_ACCESS_KEY: 'secret-secret',
    PROCESSOR_API_KEY: 'processor-secret',
    STRIPE_SECRET_KEY: 'stripe-secret',
  }

  executarFerramenta('ffmpeg', ['-i', '/tmp/input ; harmless.mp4'], { stdio: 'inherit' }, (...args) => {
    chamada = args
    return Buffer.from('ok')
  }, origem)

  assert.equal(chamada[0], 'ffmpeg')
  assert.deepEqual(chamada[1], ['-i', '/tmp/input ; harmless.mp4'])
  assert.equal(chamada[2].stdio, 'inherit')
  assert.deepEqual(chamada[2].env, { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), TMPDIR: os.tmpdir() })
})

test('preserves a usable PATH on Windows without copying unrelated variables', () => {
  let chamada
  executarFerramenta('ffprobe', ['-version'], {}, (...args) => {
    chamada = args
  }, { Path: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\runner', PROCESSOR_API_KEY: 'secret' })

  assert.equal(chamada[2].env.PATH, 'C:\\Windows\\System32')
  assert.equal('USERPROFILE' in chamada[2].env, false)
  assert.equal('PROCESSOR_API_KEY' in chamada[2].env, false)
})

test('processor invokes media tools only through the isolated runner', () => {
  const source = fs.readFileSync(require.resolve('./processor.js'), 'utf8')

  assert.match(source, /require\('\.\/media-tool-runner'\)/)
  assert.doesNotMatch(source, /\b(?:execSync|execFileSync|spawnSync|spawn)\s*\(/)
})
