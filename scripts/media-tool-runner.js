'use strict'

const { execFileSync } = require('node:child_process')
const os = require('node:os')

/**
 * Media files are untrusted input. Do not pass storage/API credentials to
 * FFmpeg or ffprobe, and invoke the binaries without a shell.
 */
function executarFerramenta(nome, argumentos, opcoes = {}, executor = execFileSync, ambienteOrigem = process.env) {
  const ambiente = {
    PATH: ambienteOrigem.PATH || ambienteOrigem.Path || '/usr/bin:/bin',
    HOME: os.tmpdir(),
    TMPDIR: os.tmpdir(),
  }
  return executor(nome, argumentos, { ...opcoes, shell: false, env: ambiente })
}

function executarFfmpeg(argumentos, opcoes = {}) {
  return executarFerramenta('ffmpeg', argumentos, opcoes)
}

function executarFfprobe(argumentos, opcoes = {}) {
  return executarFerramenta('ffprobe', argumentos, opcoes)
}

module.exports = { executarFerramenta, executarFfmpeg, executarFfprobe }
