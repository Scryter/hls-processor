'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { executarFerramenta, construirArgumentosDoContainer } = require('./media-tool-runner')

test('runs media tools in a networkless, read-only container with only the per-video workspace mounted', () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-test-'))
  const image = 'trainlab-media-tools:test'
  const args = construirArgumentosDoContainer('ffmpeg', ['-i', path.join(workdir, 'input ; harmless.mp4'), path.join(workdir, 'out.mp4')], {
    workdir,
    image,
    uid: 1001,
    gid: 1001,
  })

  assert.equal(args[0], 'run')
  assert.ok(args.includes('--rm'))
  assert.ok(args.includes('--network=none'))
  assert.ok(args.includes('--read-only'))
  assert.ok(args.includes('--cap-drop=ALL'))
  assert.ok(args.includes('--security-opt=no-new-privileges:true'))
  assert.ok(args.includes('--pids-limit=128'))
  assert.ok(args.includes('--memory=4g'))
  assert.ok(args.includes('--cpus=2'))
  assert.ok(args.includes('--user'))
  assert.ok(args.includes('1001:1001'))
  assert.ok(args.includes(`type=bind,src=${workdir},dst=/work`))
  assert.ok(args.includes('--workdir'))
  assert.ok(args.includes('/work'))
  assert.equal(args.at(-4), 'ffmpeg')
  assert.equal(args.at(-3), '-i')
  assert.equal(args.at(-2), '/work/input ; harmless.mp4')
  assert.equal(args.at(-1), '/work/out.mp4')
  assert.ok(args.includes('/work/input ; harmless.mp4'))
  assert.ok(args.includes(image))
  fs.rmSync(workdir, { recursive: true, force: true })
})

test('rejects media paths outside the mounted per-video workspace', () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-test-'))
  assert.throws(() => construirArgumentosDoContainer('ffprobe', ['/etc/passwd'], {
    workdir,
    image: 'trainlab-media-tools:test',
    uid: 1001,
    gid: 1001,
  }), /fora da pasta temporária/)
  fs.rmSync(workdir, { recursive: true, force: true })
})

test('host Docker client also receives no API or storage credentials', () => {
  let chamada
  const origem = {
    PATH: '/usr/bin:/bin',
    R2_ACCOUNT_ID: 'account-secret',
    R2_ACCESS_KEY_ID: 'access-secret',
    R2_SECRET_ACCESS_KEY: 'secret-secret',
    PROCESSOR_API_KEY: 'processor-secret',
    STRIPE_SECRET_KEY: 'stripe-secret',
  }
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-test-'))

  executarFerramenta('ffmpeg', ['-i', path.join(workdir, 'input ; harmless.mp4')], { cwd: workdir, stdio: 'inherit', shell: true }, (...args) => {
    chamada = args
    return Buffer.from('ok')
  }, origem, { image: 'trainlab-media-tools:test', uid: 1001, gid: 1001 })

  assert.equal(chamada[0], 'docker')
  assert.ok(chamada[1].includes('--network=none'))
  assert.ok(chamada[1].includes('/work/input ; harmless.mp4'))
  assert.equal(chamada[2].stdio, 'inherit')
  assert.equal(chamada[2].shell, false)
  assert.deepEqual(chamada[2].env, { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), TMPDIR: os.tmpdir() })
  fs.rmSync(workdir, { recursive: true, force: true })
})

test('preserves a usable PATH on Windows without copying unrelated variables', () => {
  let chamada
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-test-'))
  executarFerramenta('ffprobe', ['-version'], { cwd: workdir }, (...args) => {
    chamada = args
  }, { Path: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\runner', PROCESSOR_API_KEY: 'secret' }, { image: 'trainlab-media-tools:test', uid: 1001, gid: 1001 })

  assert.equal(chamada[0], 'docker')
  assert.equal(chamada[2].env.PATH, 'C:\\Windows\\System32')
  assert.equal('USERPROFILE' in chamada[2].env, false)
  assert.equal('PROCESSOR_API_KEY' in chamada[2].env, false)
  fs.rmSync(workdir, { recursive: true, force: true })
})

test('processor invokes media tools only through the isolated runner', () => {
  const source = fs.readFileSync(require.resolve('./processor.js'), 'utf8')

  assert.match(source, /require\('\.\/media-tool-runner'\)/)
  assert.doesNotMatch(source, /\b(?:execSync|execFileSync|spawnSync|spawn)\s*\(/)
})
