'use strict'

function parseOriginalHeight(output) {
  const value = String(output ?? '').trim()
  if (!/^\d+$/.test(value)) throw new Error('Não foi possível validar a resolução do vídeo.')

  const height = Number(value)
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new Error('Não foi possível validar a resolução do vídeo.')
  }

  return height
}

function readOriginalHeight(mp4Path, tmpDir, ffprobe) {
  let output
  try {
    output = ffprobe(
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', mp4Path],
      { cwd: tmpDir, encoding: 'utf8' },
    )
  } catch {
    throw new Error('Não foi possível validar a resolução do vídeo.')
  }

  return parseOriginalHeight(output)
}

module.exports = { parseOriginalHeight, readOriginalHeight }
