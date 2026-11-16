const PRIVATE_ROOT = 'exercises';
const PLAYBACK_PARAM = '__tl_playback';
const MAX_TOKEN_BYTES = 4096;

function decodePath(pathname) {
  try {
    const parts = pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent);
    if (parts.some((part) => !part || part === '.' || part === '..' || /[\\/\x00-\x1f\x7f]/.test(part))) return null;
    return parts.join('/');
  } catch { return null; }
}

export function isPrivateTrainerObjectKey(key) {
  if (typeof key !== 'string') return false;
  const parts = key.split('/');
  return parts.length >= 5 && parts[0] === PRIVATE_ROOT && !!parts[1] && !!parts[2]
    && validPrefix(`${parts.slice(0, 4).join('/')}/`);
}

function isGatewayObjectKey(key) {
  if (!isPrivateTrainerObjectKey(key)) return false;
  const relative = key.split('/').slice(4).join('/');
  return (relative.startsWith('hls/') && /\.(m3u8|ts|m4s|mp4|key|aac)$/i.test(relative))
    || relative === 'thumb.jpg' || relative === 'teaser.mp4'
    || /\.(glb|gltf|fbx)$/i.test(relative);
}

function parseAllowedOrigins(value) {
  return new Set(String(value || '').split(',').map((origin) => origin.trim()).filter(Boolean));
}

function addVary(headers, value) {
  const values = new Set((headers.get('Vary') || '').split(',').map((item) => item.trim()).filter(Boolean));
  values.add(value);
  headers.set('Vary', [...values].join(', '));
}

function corsHeaders(origin, allowedOrigins) {
  const headers = new Headers();
  if (origin && allowedOrigins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Range');
    headers.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, ETag');
    headers.set('Access-Control-Max-Age', '600');
  }
  addVary(headers, 'Origin');
  return headers;
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function validPrefix(prefix) {
  const parts = typeof prefix === 'string' && prefix.endsWith('/') ? prefix.slice(0, -1).split('/') : [];
  const fileId = parts[3] || '';
  const validFileId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fileId);
  return parts.length === 4 && parts[0] === PRIVATE_ROOT && !!parts[1] && !!parts[2] && validFileId
    && !parts.some((part) => part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part));
}

function validModelKey(key, prefixes) {
  return typeof key === 'string' && isPrivateTrainerObjectKey(key)
    && prefixes.some((prefix) => key.startsWith(prefix))
    && /\.(glb|gltf|fbx)$/i.test(key)
    && !key.split('/').some((part) => part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part));
}

export async function signPlaybackToken(claims, secret) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return `${payload}.${bytesToBase64Url(signature)}`;
}

async function verifyToken(token, secret, objectKey, nowSeconds) {
  if (!token || typeof secret !== 'string' || new TextEncoder().encode(secret).length < 32 || token.length > MAX_TOKEN_BYTES) return null;
  const pieces = token.split('.');
  if (pieces.length !== 2) return null;
  try {
    const payloadBytes = base64UrlToBytes(pieces[0]);
    const signature = base64UrlToBytes(pieces[1]);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(pieces[0])));
    if (!equalBytes(signature, expected)) return null;
    const claims = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (claims.aud !== 'trainlab-r2-hls' || !Number.isInteger(claims.exp) || claims.exp <= nowSeconds) return null;
    if (!Array.isArray(claims.prefixes) || claims.prefixes.length < 1 || claims.prefixes.length > 5 || !claims.prefixes.every(validPrefix)) return null;
    if (!Array.isArray(claims.modelKeys) || claims.modelKeys.length > 10 || !claims.modelKeys.every((key) => validModelKey(key, claims.prefixes))) return null;
    if (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > nowSeconds + 30)) return null;
    if (!claims.prefixes.some((prefix) => objectKey.startsWith(prefix))) return null;
    if (/\.(glb|gltf|fbx)$/i.test(objectKey) && !claims.modelKeys.includes(objectKey)) return null;
    return claims;
  } catch { return null; }
}

function privateResponse(body, status, origin, allowedOrigins, extraHeaders = {}) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  });
  for (const [name, value] of corsHeaders(origin, allowedOrigins)) headers.set(name, value);
  return new Response(body, { status, headers });
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  let start; let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(size - suffix, 0); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

function contentType(key, metadata) {
  if (metadata?.httpMetadata?.contentType) return metadata.httpMetadata.contentType;
  if (key.toLowerCase().endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (key.toLowerCase().endsWith('.ts')) return 'video/mp2t';
  if (key.toLowerCase().endsWith('.mp4')) return 'video/mp4';
  if (key.toLowerCase().endsWith('.jpg') || key.toLowerCase().endsWith('.jpeg')) return 'image/jpeg';
  if (key.toLowerCase().endsWith('.webp')) return 'image/webp';
  if (key.toLowerCase().endsWith('.glb')) return 'model/gltf-binary';
  if (key.toLowerCase().endsWith('.gltf')) return 'model/gltf+json';
  if (key.toLowerCase().endsWith('.fbx')) return 'application/octet-stream';
  return 'application/octet-stream';
}

async function getObject(bucket, key, request) {
  const metadata = await bucket.head(key);
  if (!metadata) return new Response('Not found', { status: 404 });
  const range = parseRange(request.headers.get('Range'), metadata.size);
  if (range?.invalid) return new Response('Invalid range', { status: 416, headers: { 'Content-Range': `bytes */${metadata.size}` } });
  if (range?.unsatisfiable) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${metadata.size}` } });
  const options = range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined;
  const object = await bucket.get(key, options);
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers({
    'Content-Type': contentType(key, object),
    'Accept-Ranges': 'bytes',
  });
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${metadata.size}`);
  headers.set('Content-Length', String(range ? range.end - range.start + 1 : metadata.size));
  const body = request.method === 'HEAD' ? null : object.body;
  return new Response(body, { status: range ? 206 : 200, headers });
}

function rewritePlaylist(text, manifestUrl, token, allowedPrefixes) {
  const sourceUrl = new URL(manifestUrl);
  const rewriteUri = (raw) => {
    const resolved = new URL(raw, sourceUrl);
    if (resolved.origin !== sourceUrl.origin || resolved.username || resolved.password) throw new Error('external playlist URI');
    const key = decodePath(resolved.pathname);
    if (!key || !isPrivateTrainerObjectKey(key) || !allowedPrefixes.some((prefix) => key.startsWith(prefix))) throw new Error('URI outside token scope');
    resolved.searchParams.delete(PLAYBACK_PARAM);
    resolved.searchParams.set(PLAYBACK_PARAM, token);
    resolved.hash = '';
    return resolved.toString();
  };
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (!trimmed.startsWith('#')) return rewriteUri(trimmed);
    if (!/\bURI=/i.test(trimmed)) return line;
    return line.replace(/\bURI=(['"])(.*?)\1/g, (_match, quote, uri) => `URI=${quote}${rewriteUri(uri)}${quote}`);
  }).join('\n');
}

export async function handleRequest(request, env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const url = new URL(request.url);
  const key = decodePath(url.pathname);
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') {
    const method = (request.headers.get('Access-Control-Request-Method') || '').toUpperCase();
    const headers = (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map((v) => v.trim()).filter(Boolean);
    if (!origin || !allowedOrigins.has(origin) || !['GET', 'HEAD'].includes(method) || headers.some((h) => h !== 'range')) {
      return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' } });
    }
    return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigins) });
  }
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS', 'Cache-Control': 'no-store' } });
  if (!key) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

  // This Worker is intended for the dedicated media hostname. Fail closed for
  // every object outside the HLS derivatives and their two preview assets.
  if (!isGatewayObjectKey(key)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const isPrivate = true;
  let claims = null;
  const token = url.searchParams.get(PLAYBACK_PARAM);
  if (isPrivate) {
    if (origin && !allowedOrigins.has(origin)) return privateResponse('Forbidden', 403, origin, allowedOrigins);
    claims = await verifyToken(token, env.PLAYBACK_TOKEN_SECRET, key, nowSeconds);
    if (!claims) return privateResponse('Forbidden', 403, origin, allowedOrigins);
  }

  const upstream = await getObject(env.MEDIA_BUCKET, key, request);
  if (isPrivate && request.method === 'GET' && key.toLowerCase().endsWith('.m3u8') && upstream.ok) {
    try {
      const body = rewritePlaylist(await upstream.text(), request.url, token, claims.prefixes);
      return privateResponse(body, upstream.status, origin, allowedOrigins, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      });
    } catch {
      return privateResponse('Invalid playlist', 502, origin, allowedOrigins);
    }
  }
  if (isPrivate) {
    const headers = new Headers(upstream.headers);
    for (const [name, value] of corsHeaders(origin, allowedOrigins)) headers.set(name, value);
    headers.set('Cache-Control', 'private, no-store, max-age=0');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  return upstream;
}

export default { fetch(request, env) { return handleRequest(request, env); } };
