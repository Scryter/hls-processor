# TrainLab private HLS gateway

This Worker serves only authorized HLS derivatives, preview assets, and 3D files under `exercises/<trainerId>/<uploadId>/<fileId>/` from an R2 binding. It rejects original uploads, legacy shared-batch directories, and every unknown object; validates an HMAC playback token; rewrites every HLS child URI with that token; and supports byte ranges and allowlisted CORS. Each uploaded file needs its own UUID directory because the processor writes HLS and preview derivatives next to the source. 3D objects are additionally listed by exact key in the token.

The HLS processor accepts private trainer sources only in the five-segment per-file UUID layout and only when the sanitized filename ends in one of `_mp4`, `_mov`, `_avi`, `_mkv`, or `_webm` (the upload API converts `treino.mp4` to `treino_mp4`). It restores the supported suffix for local FFmpeg input. Legacy shared-batch paths are deliberately skipped; migrate them before cutover rather than letting processing overwrite shared derivatives and delete a source that the Worker will reject.

The bearer token is carried in the HLS request query string so native HLS players can fetch child playlists and segments. The backend signs `iat` and `exp`; the Worker accepts at most 600 seconds between them and permits up to 30 seconds of future `iat` clock skew. Responses set `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`; production CDN, Worker, analytics, and application access logs must also omit or redact the `__tl_playback` query parameter. Do not enable request logging that records full URLs for this route.

## Local checks

Run the Worker unit checks with Node's built-in test runner:

```sh
node --test workers/r2-media-gateway/worker.test.mjs
```

`wrangler.toml` is deliberately bound only to the isolated `trainlab-security-audit-test` bucket. It has no route or production bucket binding. `PLAYBACK_TOKEN_SECRET` is unset by default, so private playback fails closed until configured locally.

## Production rollout prerequisites

The production route must be path-scoped to `r2.hidrasistemas.com.br/exercises/*`, not the whole hostname. `wrangler.production.toml` is a review-only candidate for that route and the `prd-trainlab` binding; it contains no playback secret and has not been deployed. That keeps `free-exercise/` and other public catalog prefixes outside the Worker while the Worker rejects unknown and original objects within `exercises/`. Before enabling the route, all existing trainer media in legacy shared-batch directories must be migrated to per-file UUID directories and database references updated; the candidate intentionally fails closed for legacy paths. The inventory preflight must flag folders with multiple distinct root source files as collisions: older processing wrote `hls/`, `thumb.jpg`, and `teaser.mp4` beside each source, so one source may have overwritten another's derivatives. Do not automatically copy or guess which derivative belongs to which exercise. Reprocess from a surviving original; if no original remains, require the trainer to upload the video again. Deploy against the production bucket only after reviewed migration/rollback plans, configure `PLAYBACK_TOKEN_SECRET` and exact TrainLab origins, and test with synthetic canary objects. Verify student entitlement, trainer ownership, HLS variant/segment playback, seeking, expiry, 3D preview, and denial from other origins.

The default test config remains bound only to `trainlab-security-audit-test`. The separate `wrangler.production.toml` is a review-only deployment candidate; no Worker, route, secret, or frontend/backend rollout has been applied.

Additional access-control prerequisite: the production cutover must also disable `r2.dev` and any other public alternate domain for the bucket. Cloudflare states that disabling one custom domain does not affect other domains or the `r2.dev` endpoint. Verify anonymous denial through every alternate endpoint after the Worker route is enabled; a path-scoped Worker route alone is not proof that the bucket has no other public path.
