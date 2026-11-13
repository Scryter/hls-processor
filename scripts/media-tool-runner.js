'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Builds a narrow Docker invocation for processing one untrusted media file.
 * Only the per-video scratch directory is mounted; the container has no
 * network, credentials, writable root filesystem, or Linux capabilities.
 */
function construirArgumentosDoContainer(nome, argumentos, contexto) {
  if (nome !== 'ffmpeg' && nome !== 'ffprobe') throw new Error('Ferramenta de mídia inválida')
  if (!Array.isArray(argumentos) || argumentos.some(arg => typeof arg !== 'string')) {
    throw new Error('Argumentos de mídia inválidos')
  }

  const { workdir, image, uid, gid } = contexto ?? {}
  if (typeof workdir !== 'string' || !workdir || typeof image !== 'string' || !image ||
      !Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error('Configuração do contêiner de mídia inválida')
  }

  const scratchRoot = fs.realpathSync(os.tmpdir())
  const scratchDir = fs.realpathSync(workdir)
  const relativeToTmp = path.relative(scratchRoot, scratchDir)
  if (!relativeToTmp || relativeToTmp.startsWith(`..${path.sep}`) || relativeToTmp === '..' || path.isAbsolute(relativeToTmp) ||
      !path.basename(scratchDir).startsWith('processor-') || scratchDir.includes(',')) {
    throw new Error('Pasta de trabalho fora da pasta temporária do processador')
  }

  const traduzirCaminho = (valor) => {
    if (!path.isAbsolute(valor)) return valor
    const absoluto = path.resolve(valor)
    const relativo = path.relative(scratchDir, absoluto)
    if (relativo === '..' || relativo.startsWith(`..${path.sep}`) || path.isAbsolute(relativo)) {
      throw new Error('Caminho de mídia fora da pasta temporária')
    }
    return relativo ? `/work/${relativo.split(path.sep).join('/')}` : '/work'
  }

  return [
    'run', '--rm',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--pids-limit=128',
    '--memory=4g',
    '--cpus=2',
    '--user', `${uid}:${gid}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=256m',
    '--mount', `type=bind,src=${scratchDir},dst=/work`,
    '--workdir', '/work',
    image,
    nome,
    ...argumentos.map(traduzirCaminho),
  ]
}

function executarFerramenta(nome, argumentos, opcoes = {}, executor = execFileSync, ambienteOrigem = process.env, contexto = {}) {
  const workdir = opcoes.cwd
  const spawnOptions = { ...opcoes }
  delete spawnOptions.cwd

  const uid = contexto.uid ?? process.getuid?.()
  const gid = contexto.gid ?? process.getgid?.()
  const image = contexto.image ?? ambienteOrigem.PROCESSOR_MEDIA_IMAGE
  const argumentosDoContainer = construirArgumentosDoContainer(nome, argumentos, { workdir, image, uid, gid })

  const ambienteDocker = {
    PATH: ambienteOrigem.PATH || ambienteOrigem.Path || '/usr/local/bin:/usr/bin:/bin',
    HOME: os.tmpdir(),
    TMPDIR: os.tmpdir(),
  }
  return executor('docker', argumentosDoContainer, {
    ...spawnOptions,
    shell: false,
    env: ambienteDocker,
  })
}

function executarFfmpeg(argumentos, opcoes = {}) {
  return executarFerramenta('ffmpeg', argumentos, opcoes)
}

function executarFfprobe(argumentos, opcoes = {}) {
  return executarFerramenta('ffprobe', argumentos, opcoes)
}

module.exports = { construirArgumentosDoContainer, executarFerramenta, executarFfmpeg, executarFfprobe }
