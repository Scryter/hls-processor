import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, signPlaybackToken } from './worker.mjs';

const secret = 'unit-test-only-secret-with-32-bytes-minimum';
const prefix = 'exercises/trainer-1/upload-1/11111111-1111-4111-8111-111111111111/';
const now = 1_800_000_000;
const allowedOrigins = 'https://trainlab.com.br,https://www.trainlab.com.br,https://trainlab-frontend.vercel.app,http://localhost:3000';

function makeBucket(objects = {}) {
  const calls = [];
  return {
    calls,
    async head(key) {
      calls.push(['head', key]);
      const body = objects[key];
      const type = key.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : key.endsWith('.glb') ? 'model/gltf-binary' : 'video/mp2t';
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
      const type = key.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : key.endsWith('.glb') ? 'model/gltf-binary' : 'video/mp2t';
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
  return signPlaybackToken({ aud: 'trainlab-r2-hls', iat: now, exp, prefixes, modelKeys: [] }, secret);
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
  const longLived = await signPlaybackToken({ aud: 'trainlab-r2-hls', iat: now, exp: now + 601, prefixes: [prefix], modelKeys: [] }, secret);
  const response = await handleRequest(request(`https://media.example/${prefix}hls/master.m3u8?__tl_playback=${longLived}`), env, now);
  assert.equal(response.status, 403);
  assert.equal(env.MEDIA_BUCKET.calls.length, 0);
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

test('allows only explicitly authorized 3D assets from the private upload scope', async () => {
  const key = `${prefix}model.glb`;
  const env = await envFor({ [key]: 'fake-glb' });
  const playbackToken = await signPlaybackToken({ aud: 'trainlab-r2-hls', iat: now, exp: now + 600, prefixes: [prefix], modelKeys: [key] }, secret);
  const response = await handleRequest(request(`https://media.example/${key}?__tl_playback=${playbackToken}`), env, now);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'model/gltf-binary');

  const sibling = `${prefix}sibling.glb`;
  const siblingResponse = await handleRequest(request(`https://media.example/${sibling}?__tl_playback=${playbackToken}`), env, now);
  assert.equal(siblingResponse.status, 403);
  assert.equal(env.MEDIA_BUCKET.calls.some(([method, objectKey]) => method === 'head' && objectKey === sibling), false);
});
