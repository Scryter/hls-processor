'use strict'

const R2_PUBLIC_HOST = 'r2.hidrasistemas.com.br'

function authenticatedVideoUrl(key) {
  return `/api/backend/videos/${key.split('/').map(encodeURIComponent).join('/')}`
}

function stripVideoApiPrefix(key) {
  if (key.startsWith('api/backend/videos/')) return key.slice('api/backend/videos/'.length)
  if (key.startsWith('api/videos/')) return key.slice('api/videos/'.length)
  return key
}

function toObjectKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const raw = value.trim()
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== R2_PUBLIC_HOST) return null
    return stripVideoApiPrefix(decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))) || null
  } catch {
    const key = raw.split(/[?#]/, 1)[0].replace(/^\/+/, '')
    try { return stripVideoApiPrefix(decodeURIComponent(key)) || null } catch { return null }
  }
}

module.exports = { authenticatedVideoUrl, toObjectKey }
