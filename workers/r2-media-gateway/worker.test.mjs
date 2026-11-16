import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleRequest, signPlaybackToken } from './worker.mjs';

const secret = 'unit-test-only-secret-with-32-bytes-minimum';
const prefix = 'exercises/trainer-1/upload-1/11111111-1111-4111-8111-111111111111/';
const privateImageKey = 'exercise-images/trainer-1/33333333-3333-4333-8333-333333333333.webp';
const now = 1_800_000_000;
const allowedOrigins = 'https://trainlab.com.br,https://www.trainlab.com.br,https://trainlab-frontend.vercel.app,http://localhost:3000';

function makeBucket(objects = {}, contentTypes = {}) {
  const calls = [];
  return {
    calls,
    async head(key) {
      calls.push(['head', key]);
      const body = objects[key];
      const type = contentTypes[key] || (key.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : key.endsWith('.glb') ? 'model/gltf-binary' : key.endsWith('.webp') ? 'image/webp' : 'video/mp2t');
      return body === undefined ? null : { size: new TextEncoder().encode(body).length, httpMetadata: { contentType: type } };
    },
    async get(key, options) {
      calls.push(['get', key, options]);
      const source = objects[key];
      if (source === undefined) return null;
      const bytes = new TextEncoder().encode(source);
      const start = options?.range.offset ?? 0;
      const end = options ? start + options.range.length : bytes.length;
      const selected = bytes.slice(start, end);
      const type = contentTypes[key] || (key.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : key.endsWith('.glb') ? 'model/gltf-binary' : key.endsWith('.webp') ? 'image/webp' : 'video/mp2t');
      return { body: new Blob([selected]).stream(), httpEtag: '"etag"', httpMetadata: { contentType: type } };
    },
  };
}

async function envFor(objects) {
  return {
    MEDIA_BUCKET: makeBucket(objects),
    PLAYBACK_TOKEN_SECRET: secret,
    ALLOWED_ORIGINS: allowedOrigins,
  };
}

async function token(prefixes = [prefix], exp = now + 600) {
  return signPlaybackToken({ aud: 'trainlab-r2-hls', iat: now, exp, prefixes, modelKeys: [], objectKeys: [] }, secret);
}

async function imageToken(objectKeys = [privateImageKey], exp = now + 600) {
  return signPlaybackToken({ aud: 'trainlab-r2-hls', iat: now, exp, prefixes: [], modelKeys: [], objectKeys }, secret);
}

function request(url, { method = 'GET', origin = 'https://trainlab.com.br', headers = {} } = {}) {
  return new Request(url, { method, headers: { ...(origin ? { Origin: origin } : {}), ...headers } });
}

test('requires a valid signed token scoped to the requested upload', async () => {
  const env = await envFor({ [`${prefix}hls/master.m3u8`]: '#EXTM3U\n' });
  const absent = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8`), env, now);
  assert.equal(absent.status, 403);
  const wrongScope = await token(['exercises/trainer-2/upload-9/22222222-2222-4222-8222-222222222222/']);
  const denied = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8?__tl_playback=${wrongScope}`), env, now);
  assert.equal(denied.status, 403);
  const expired = await token([prefix], now);
  const expiredResponse = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8?__tl_playback=${expired}`), env, now);
  assert.equal(expiredResponse.status, 403);
});

test('rejects playback tokens with a lifetime greater than ten minutes', async () => {
  const env = await envFor({ [`${prefix}hls/master.m3u8`]: '#EXTM3U\n' });
  const longLived = await signPlaybackToken({ aud: 'trainlab-r2-hls', iat: now, exp: now + 601, prefixes: [prefix], modelKeys: [], objectKeys: [] }, secret);
  const response = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8?__tl_playback=${longLived}`), env, now);
  assert.equal(response.status, 403);
  assert.equal(env.MEDIA_BUCKET.calls.length, 0);
});

test('accepts a ten-minute token with small backend clock skew', async () => {
  const env = await envFor({ [`${prefix}hls/master.m3u8`]: '#EXTM3U\n' });
  const issuedAt = now + 1;
  const tokenWithSkew = await signPlaybackToken({ aud: 'trainlab-r2-hls', iat: issuedAt, exp: issuedAt + 600, prefixes: [prefix], modelKeys: [], objectKeys: [] }, secret);
  const response = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8?__tl_playback=${tokenWithSkew}`), env, now);
  assert.equal(response.status, 200);
});

test('accepts the Node HMAC/base64url token format emitted by the backend', async () => {
  const env = await envFor({ [`${prefix}hls/master.m3u8`]: '#EXTM3U\n' });
  const payload = Buffer.from(JSON.stringify({ aud: 'trainlab-r2-hls', iat: now, exp: now + 600, prefixes: [prefix], modelKeys: [], objectKeys: [] })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  const response = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8?__tl_playback=${payload}.${signature}`), env, now);
  assert.equal(response.status, 200);
});

test('rejects legacy shared-batch prefixes and tokens for a sibling file directory', async () => {
  const objects = {
    [`${prefix}hls/master.m3u8`]: '#EXTM3U\n',
  };
  const env = await envFor(objects);
  const legacy = await token(['exercises/trainer-1/upload-1/']);
  const legacyResponse = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8?__tl_playback=${legacy}`), env, now);
  assert.equal(legacyResponse.status, 403);

  const sibling = 'exercises/trainer-1/upload-1/22222222-2222-4222-8222-222222222222/';
  const siblingToken = await token([sibling]);
  const siblingResponse = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8?__tl_playback=${siblingToken}`), env, now);
  assert.equal(siblingResponse.status, 403);
});

test('rewrites all HLS child playlist and segment URLs with the same scoped token', async () => {
  const objects = {
    [`${prefix}hls/master.m3u8`]: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p/playlist.m3u8\n',
  };
  const env = await envFor(objects);
  const playbackToken = await token();
  const response = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8?__tl_playback=${playbackToken}`), env, now);
  assert.equal(response.status, 200);
  assert.match(await response.text(), new RegExp(`720p/playlist\\.m3u8\\?__tl_playback=${playbackToken}`));
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://trainlab.com.br');
});

test('rejects external or out-of-scope playlist references', async () => {
  for (const playlist of ['#EXTM3U\nhttps://evil.example/x.ts\n', '#EXTM3U\n../../other-upload/secret.ts\n']) {
    const env = await envFor({ [`${prefix}hls/master.m3u8`]: playlist });
    const playbackToken = await token();
    const response = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8?__tl_playback=${playbackToken}`), env, now);
    assert.equal(response.status, 502);
  }
});

test('rejects an oversized playlist instead of buffering its full body', async () => {
  const oversized = `#EXTM3U\n#${'x'.repeat(1024 * 1024)}`;
  const env = await envFor({ [`${prefix}hls/master.m3u8`]: oversized });
  const playbackToken = await token();
  const response = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8?__tl_playback=${playbackToken}`), env, now);

  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'Invalid playlist');
});

test('preserves byte ranges for video segments', async () => {
  const key = `${prefix}hls/720p/seg000.ts`;
  const env = await envFor({ [key]: '0123456789' });
  const playbackToken = await token();
  const response = await handleRequest(request(`https://media.example/${key}?__tl_playback=${playbackToken}`, { headers: { Range: 'bytes=2-5' } }), env, now);
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '2345');
  assert.equal(response.headers.get('Content-Range'), 'bytes 2-5/10');
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
});

test('answers authorized HEAD requests from object metadata without reading the object body', async () => {
  const key = `${prefix}model.glb`;
  const env = await envFor({ [key]: 'fake-glb' });
  const playbackToken = await signPlaybackToken({ aud: 'trainlab-r2-hls', iat: now, exp: now + 600, prefixes: [prefix], modelKeys: [key], objectKeys: [] }, secret);

  const response = await handleRequest(request(`https://media.example/${key}?__tl_playback=${playbackToken}`, { method: 'HEAD' }), env, now);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Length'), '8');
  assert.equal(await response.text(), '');
  assert.deepEqual(env.MEDIA_BUCKET.calls.map(([method]) => method), ['head']);
});

test('allows the permitted origin and rejects preflight from other origins', async () => {
  const env = await envFor({});
  for (const origin of ['https://trainlab.com.br', 'https://www.trainlab.com.br', 'https://trainlab-frontend.vercel.app']) {
    const good = await handleRequest(request('https://media.example/exercises/t/u/hls/master.m3u8', { method: 'OPTIONS', origin, headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' } }), env, now);
    assert.equal(good.status, 204, `preflight should allow ${origin}`);
    assert.equal(good.headers.get('Access-Control-Allow-Origin'), origin);
  }
  const bad = await handleRequest(request('https://media.example/exercises/t/u/hls/master.m3u8', { method: 'OPTIONS', origin: 'https://evil.example', headers: { 'Access-Control-Request-Method': 'GET' } }), env, now);
  assert.equal(bad.status, 403);
});

test('fails closed for non-media objects and unsupported methods', async () => {
  const env = await envFor({ [`${prefix}original.mp4`]: 'private source' });
  const deniedPath = await handleRequest(request(`https://media.example/${prefix}original.mp4`), env, now);
  assert.equal(deniedPath.status, 404);
  const method = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8`, { method: 'POST' }), env, now);
  assert.equal(method.status, 405);
  assert.equal(env.MEDIA_BUCKET.calls.length, 0);
});

test('rejects encoded path separators and decoded private roots; denies private image uploads', async () => {
  const encodedSlash = await token();
  const env = await envFor({ [`${prefix}hls/master.m3u8`]: '#EXTM3U\n' });
  const bypassAttempt = await handleRequest(request(
    `https://media.example/exercises%2Ftrainer-1%2Fupload-1%2F11111111-1111-4111-8111-111111111111%2Fhls%2Fmaster.m3u8?__tl_playback=${encodedSlash}`,
  ), env, now);
  assert.equal(bypassAttempt.status, 404);
  assert.equal(env.MEDIA_BUCKET.calls.length, 0);

  const encodedRoot = await handleRequest(request(
    'https://media.example/%65xercises/trainer-1/upload-1/11111111-1111-4111-8111-111111111111/hls/master.m3u8',
  ), env, now);
  assert.equal(encodedRoot.status, 403);
  assert.equal(env.MEDIA_BUCKET.calls.length, 0);

  const privateImage = await handleRequest(request('https://media.example/exercise-images/trainer-1/private.jpg'), env, now);
  assert.equal(privateImage.status, 404);
  assert.equal(env.MEDIA_BUCKET.calls.length, 0);
});

test('serves only the explicitly public exercise catalog prefixes', async () => {
  const catalogKey = 'free-exercise/squat/male/thumb.webp';
  const env = await envFor({ [catalogKey]: 'public-image' });
  const response = await handleRequest(request(`https://media.example/${catalogKey}`), env, now);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'public-image');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=3600');
  assert.equal(response.headers.get('Content-Type'), 'image/webp');

  const missing = await handleRequest(request('https://media.example/free-exercise/missing.webp'), env, now);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Cache-Control'), 'no-store');

  const unlisted = await handleRequest(request('https://media.example/unknown-prefix/object.bin'), env, now);
  assert.equal(unlisted.status, 404);

  const callsBeforeTestNamespace = env.MEDIA_BUCKET.calls.length;
  const testNamespace = await handleRequest(request('https://media.example/3d-test/model.glb'), env, now);
  assert.equal(testNamespace.status, 404);
  assert.equal(env.MEDIA_BUCKET.calls.length, callsBeforeTestNamespace);
});

test('serves a private exercise image only with an exact-object token', async () => {
  const env = await envFor({ [privateImageKey]: 'private-image' });
  const tokenForImage = await imageToken();
  const allowed = await handleRequest(request(`https://media.example/${privateImageKey}?__tl_playback=${tokenForImage}`), env, now);
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), 'private-image');
  assert.equal(allowed.headers.get('Cache-Control'), 'private, no-store, max-age=0');

  const otherImage = 'exercise-images/trainer-1/44444444-4444-4444-8444-444444444444.webp';
  const denied = await handleRequest(request(`https://media.example/${otherImage}?__tl_playback=${tokenForImage}`), env, now);
  assert.equal(denied.status, 403);
  assert.equal(env.MEDIA_BUCKET.calls.filter(([method]) => method === 'head').length, 1);
});

test('does not trust stored content type for media responses', async () => {
  const env = await envFor({});
  env.MEDIA_BUCKET = makeBucket({ [privateImageKey]: '<script>bad()</script>' }, { [privateImageKey]: 'text/html' });
  const tokenForImage = await imageToken();
  const response = await handleRequest(request(`https://media.example/${privateImageKey}?__tl_playback=${tokenForImage}`), env, now);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/webp');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');

  const head = await handleRequest(request(`https://media.example/${privateImageKey}?__tl_playback=${tokenForImage}`, { method: 'HEAD' }), env, now);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Type'), 'image/webp');
  assert.equal(head.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('allows only explicitly authorized 3D assets from the private upload scope', async () => {
  const key = `${prefix}model.glb`;
  const env = await envFor({ [key]: 'fake-glb' });
  const playbackToken = await signPlaybackToken({ aud: 'trainlab-r2-hls', iat: now, exp: now + 600, prefixes: [prefix], modelKeys: [key], objectKeys: [] }, secret);
  const response = await handleRequest(request(`https://media.example/${key}?__tl_playback=${playbackToken}`), env, now);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'model/gltf-binary');

  const sibling = `${prefix}sibling.glb`;
  const siblingResponse = await handleRequest(request(`https://media.example/${sibling}?__tl_playback=${playbackToken}`), env, now);
  assert.equal(siblingResponse.status, 403);
  assert.equal(env.MEDIA_BUCKET.calls.some(([method, objectKey]) => method === 'head' && objectKey === sibling), false);
});
