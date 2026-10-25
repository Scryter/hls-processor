/**
 * Player.Action - Thumbnail, Teaser & Adaptive HLS Generator
 * Runs on GitHub Actions (ubuntu-latest) triggered by webhook after a video upload.
 *
 * Flow:
 *  1. Fetch exercises pending processing from the app API
 *  2. Download each MP4 from R2
 *  3. Generate thumb.jpg (frame at 1s) via FFmpeg
 *  4. Generate teaser.mp4 (first 10s, 720px wide) via FFmpeg
 *  5. Detect original resolution with ffprobe
 *  6. Generate multi-bitrate HLS for allowed quality heights (never upscaling)
 *  7. Upload thumb, teaser and all HLS files back to R2
 *  8. Delete the original MP4 from R2 (no longer needed - HLS replaces it)
 *  9. PATCH the app API to mark as processed (hlsProcessed=true)
 *
 * Quality heights are controlled per SaaS tier (videoQualityHeights field).
 * If empty, defaults to [720, 1080]. The processor never upscales beyond
 * the original video resolution.
 */
'use strict'

const { execSync, execFileSync } = require('child_process')
const { S3Client, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')
const fs   = require('fs')
const path = require('path')
const os   = require('os')
const RECOMMENDED_SOURCE_MAP = require('../config/recommended-source-map.json')
const NEEDS_SOURCE_REVIEW = new Set(require('../config/unresolved-source-ids.json'))
const R2_PUBLIC_BASE = 'https://r2.hidrasistemas.com.br'

const {
                R2_ACCOUNT_ID,
                R2_ACCESS_KEY_ID,
                R2_SECRET_ACCESS_KEY,
                R2_BUCKET_NAME,
                APP_URL,
                PROCESSOR_API_KEY,
} = process.env

if (!R2_ACCOUNT_ID || !PROCESSOR_API_KEY || !APP_URL) {
                console.error('X Missing required env vars. Check repository secrets.')
                process.exit(1)
}

const s3 = new S3Client({
                region: 'auto',
                endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
                credentials: {
                                            accessKeyId:     R2_ACCESS_KEY_ID,
                                            secretAccessKey: R2_SECRET_ACCESS_KEY,
                },
})

// --- Quality ladder config ----------------------------------------------------
// Defines ffmpeg parameters for each supported height
const QUALITY_CONFIG = {
                1080: { width: 1920, bandwidth: 4000000, bitrate: '4000k', maxrate: '4500k', bufsize: '9000k' },
                720:  { width: 1280, bandwidth: 1500000, bitrate: '1500k', maxrate: '1800k', bufsize: '3600k' },
                480:  { width:  854, bandwidth:  800000, bitrate:  '800k', maxrate: '1000k', bufsize: '2000k' },
                360:  { width:  640, bandwidth:  400000, bitrate:  '400k', maxrate:  '500k', bufsize: '1000k' },
}

const DEFAULT_HEIGHTS = [720, 1080]

// --- API helpers --------------------------------------------------------------

async function fetchPending() {
                const res = await fetch(`${APP_URL}/api/admin/video-processor`, {
                                            headers: { 'x-processor-key': PROCESSOR_API_KEY },
                })
                if (!res.ok) throw new Error(`Failed to fetch pending: ${res.status}`)
                const data = await res.json()
                return data.pending || []
}

async function updateProgress(id, progress) {
                try {
                                            await fetch(`${APP_URL}/api/admin/video-processor`, {
                                                                                        method: 'PATCH',
                                                                                        headers: {
                                                                                                                                                        'Content-Type': 'application/json',
                                                                                                                                                        'x-processor-key': PROCESSOR_API_KEY,
                                                                                                },
                                                                                        body: JSON.stringify({ id, processingProgress: progress }),
                                            })
                } catch {
                                            // Progress update failure is non-fatal - continue processing
                }
}

async function markDone({ id, originalVideoKey, media, hlsProcessed = true, derivedBytes, sourceDeleted }) {
                const res = await fetch(`${APP_URL}/api/admin/video-processor`, {
                                            method: 'PATCH',
                                            headers: {
                                                                                        'Content-Type': 'application/json',
                                                                                        'x-processor-key': PROCESSOR_API_KEY,
                                            },
                                            body: JSON.stringify({ id, hlsProcessed, originalVideoKey, media, processingProgress: hlsProcessed ? 100 : 99, ...(derivedBytes !== undefined ? { derivedBytes, sourceDeleted } : {}) }),
                })
                if (!res.ok) {
                                            const err = await res.json().catch(() => ({}))
                                            throw new Error(`PATCH failed for ${id}: ${err.error || res.status}`)
                }
}

function toObjectKey(value) {
                if (typeof value !== 'string' || !value.trim()) return null
                const raw = value.trim()
                try {
                                            const parsed = new URL(raw)
                                            if (!['r2.hidrasistemas.com.br'].includes(parsed.hostname.toLowerCase())) return null
                                            let key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
                                            if (key.startsWith('api/videos/')) key = key.slice('api/videos/'.length)
                                            return key || null
                } catch {
                                            let key = raw.split(/[?#]/, 1)[0].replace(/^\/+/, '')
                                            if (key.startsWith('api/videos/')) key = key.slice('api/videos/'.length)
                                            return key || null
                }
}

function mediaSourceKeys(media) {
                const keys = []
                for (const gender of ['male', 'female']) {
                                            const entry = media?.[gender]
                                            if (!entry || typeof entry !== 'object') continue
                                            const key = toObjectKey(entry.key) || toObjectKey(entry.url)
                                            if (key) keys.push(key)
                }
                return [...new Set(keys)]
}

async function objectExists(key) {
                try {
                                            await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
                                            return true
                } catch (error) {
                                            if (error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return false
                                            throw error
                }
}

async function retainExistingMedia(media) {
                if (!media || typeof media !== 'object' || Array.isArray(media)) return media
                const normalized = { ...media }
                for (const gender of ['male', 'female']) {
                                            const entry = media[gender]
                                            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
                                            const key = toObjectKey(entry.key) || toObjectKey(entry.url)
                                            // Keep external demo media unchanged. Remove only R2 variants
                                            // whose declared object key is verifiably absent.
                                            if (!key || !/\.mp4$/i.test(key)) continue
                                            if (await objectExists(key)) {
                                                                                        normalized[gender] = {
                                                                                                                    ...entry,
                                                                                                                    key,
                                                                                                                    url: `https://r2.hidrasistemas.com.br/${key}`,
                                                                                        }
                                            }
                                            else delete normalized[gender]
                }
                return normalized
}

async function resolveSources(exercise) {
                const mappedSlug = RECOMMENDED_SOURCE_MAP[exercise.id]?.slug
                const sources = []
                const add = (key, gender, alreadyProcessed = false) => {
                                            if (!sources.some((item) => item.key === key)) sources.push({ key, gender, alreadyProcessed })
                }

                if (mappedSlug) {
                                            for (const gender of ['male', 'female']) {
                                                                                        const key = `free-exercise/${mappedSlug}/${gender}/original.mp4`
                                                                                        const folder = key.slice(0, key.lastIndexOf('/') + 1)
                                                                                        if (await objectExists(key)) add(key, gender)
                                                                                        else if (await objectExists(`${folder}hls/master.m3u8`)) add(key, gender, true)
                                            }
                }

                // Preserve normal user uploads and any valid legacy source if this
                // record is not in the recovery map.
                if (!sources.length) {
                                            const primary = toObjectKey(exercise.originalVideoKey)
                                            if (primary && /\.mp4$/i.test(primary) && await objectExists(primary)) {
                                                                                        const parts = primary.split('/')
                                                                                        const gender = ['male', 'female'].includes(parts.at(-2)) ? parts.at(-2) : null
                                                                                        add(primary, gender)
                                            }
                                            for (const gender of ['male', 'female']) {
                                                                                        const entry = exercise.media?.[gender]
                                                                                        if (!entry || typeof entry !== 'object') continue
                                                                                        const key = toObjectKey(entry.key) || toObjectKey(entry.url)
                                                                                        if (key && /\.mp4$/i.test(key) && await objectExists(key)) add(key, gender)
                                            }
                }

                if (!sources.length) {
                                            const checked = mappedSlug
                                                                                        ? ['male', 'female'].map((g) => `free-exercise/${mappedSlug}/${g}/original.mp4`)
                                                                                        : [toObjectKey(exercise.originalVideoKey), ...mediaSourceKeys(exercise.media)].filter(Boolean)
                                            throw new Error(`No source object found in R2. Checked: ${checked.join(', ') || '(no valid keys)'}`)
                }
                return sources
}

// --- R2 helpers ---------------------------------------------------------------
async function downloadFromR2(key, destPath) {
                const { Body } = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
                await new Promise((resolve, reject) => {
                                            const out = fs.createWriteStream(destPath)
                                            Body.pipe(out)
                                            out.on('finish', resolve)
                                            out.on('error', reject)
                })
}

async function uploadToR2(key, filePath, contentType) {
                await s3.send(new PutObjectCommand({
                                            Bucket:      R2_BUCKET_NAME,
                                            Key:         key,
                                            Body:        fs.readFileSync(filePath),
                                            ContentType: contentType,
                }))
}

async function deleteFromR2(key) {
                await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
}

async function derivedFolderBytes(folder) {
                let bytes = 0
                let continuationToken
                do {
                                            const page = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET_NAME, Prefix: folder, ContinuationToken: continuationToken }))
                                            for (const object of page.Contents || []) {
                                                                                        const key = object.Key || ''
                                                                                        if (key === `${folder}thumb.jpg` || key === `${folder}teaser.mp4` || key.startsWith(`${folder}hls/`)) bytes += object.Size || 0
                                            }
                                            continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
                } while (continuationToken)
                return bytes
}

function localDerivedBytes(folder) {
                if (!fs.existsSync(folder)) return 0
                return fs.readdirSync(folder, { withFileTypes: true }).reduce((sum, entry) => {
                                            const file = path.join(folder, entry.name)
                                            return sum + (entry.isDirectory() ? localDerivedBytes(file) : fs.statSync(file).size)
                }, 0)
}

// --- HLS master playlist builder ----------------------------------------------

function buildMasterPlaylist(variants) {
                const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '']
                for (const v of variants) {
                                            lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution}`)
                                            lines.push(v.path)
                }
                return lines.join('\n')
}

// --- Detect original resolution -----------------------------------------------

function probeHeight(mp4Path) {
                try {
                                            const out = execSync(
                                                                                        `ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "${mp4Path}"`,
                                                    { encoding: 'utf8' }
                                                                        ).trim()
                                            const h = parseInt(out)
                                            return Number.isFinite(h) && h > 0 ? h : 9999
                } catch {
                                            return 9999 // assume no cap if ffprobe fails
                }
}

// --- Core processor -----------------------------------------------------------
async function processVariant(exercise, source, requestedHeights, variantIndex, variantCount) {
                const folder = source.key.slice(0, source.key.lastIndexOf('/') + 1)
                if (source.alreadyProcessed) {
                                            console.log(`  check Reusing existing HLS for ${source.gender || 'primary'}: ${source.key}`)
                                            return await derivedFolderBytes(folder)
                }

                const { id } = exercise
                const thumbKey = `${folder}thumb.jpg`
                const teaserKey = `${folder}teaser.mp4`
                const hlsFolder = `${folder}hls/`
                const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `processor-${id}-${source.gender || 'primary'}-`))
                const mp4Path = path.join(tmpDir, 'input.mp4')
                const thumbPath = path.join(tmpDir, 'thumb.jpg')
                const teaserPath = path.join(tmpDir, 'teaser.mp4')
                const progress = (local) => updateProgress(id, Math.round(5 + (variantIndex + local / 85) * (85 / variantCount)))

                try {
                                            await progress(0)
                                            console.log(`  v  Downloading ${source.key}...`)
                                            await downloadFromR2(source.key, mp4Path)

                                            await progress(5)
                                            console.log(`  camera Generating thumbnail...`)
                                            execSync(['ffmpeg', '-y', '-i', `"${mp4Path}"`, '-ss', '00:00:01', '-frames:v', '1', '-update', '1', '-q:v', '2', `"${thumbPath}"`].join(' '), { stdio: 'inherit' })

                                            await progress(15)
                                            console.log(`  movie Generating teaser (10s preview)...`)
                                            execSync(['ffmpeg', '-y', '-i', `"${mp4Path}"`, '-t', '10', '-vf', 'scale=720:-2', '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast', '-crf', '28', '-movflags', '+faststart', `"${teaserPath}"`].join(' '), { stdio: 'inherit' })

                                            await progress(23)
                                            const originalHeight = probeHeight(mp4Path)
                                            console.log(`  zoom Original resolution: ${originalHeight}p`)
                                            let targetHeights = requestedHeights.filter((height) => height <= originalHeight)
                                            if (targetHeights.length === 0) {
                                                                                        targetHeights = [Math.min(...requestedHeights)]
                                                                                        console.warn(`  ! All requested heights exceed original (${originalHeight}p). Using ${targetHeights[0]}p only.`)
                                            }
                                            console.log(`  list Generating HLS variants: ${targetHeights.map((height) => `${height}p`).join(' + ')}`)

                                            await progress(30)
                                            for (const height of targetHeights) {
                                                                                        const cfg = QUALITY_CONFIG[height]
                                                                                        const hlsDir = path.join(tmpDir, 'hls', `${height}p`)
                                                                                        fs.mkdirSync(hlsDir, { recursive: true })
                                                                                        console.log(`  signal Generating HLS ${height}p...`)
                                                                                        execFileSync('ffmpeg', [
                                                                                                                    '-y', '-i', mp4Path,
                                                                                                                    '-profile:v', 'baseline', '-level', '3.0',
                                                                                                                    '-vf', `scale='min(${cfg.width},iw)':trunc(ow/a/2)*2`,
                                                                                                                    '-c:v', 'libx264', '-c:a', 'aac',
                                                                                                                    '-b:v', cfg.bitrate, '-maxrate', cfg.maxrate, '-bufsize', cfg.bufsize,
                                                                                                                    '-hls_time', '10', '-hls_playlist_type', 'vod',
                                                                                                                    '-hls_segment_filename', path.join(hlsDir, 'seg%03d.ts'),
                                                                                                                    path.join(hlsDir, 'playlist.m3u8'),
                                                                                        ], { stdio: 'inherit' })
                                            }

                                            await progress(75)
                                            if (fs.existsSync(thumbPath)) await uploadToR2(thumbKey, thumbPath, 'image/jpeg')
                                            if (fs.existsSync(teaserPath)) await uploadToR2(teaserKey, teaserPath, 'video/mp4')

                                            await progress(85)
                                            const variants = []
                                            for (const height of targetHeights) {
                                                                                        const cfg = QUALITY_CONFIG[height]
                                                                                        const dir = path.join(tmpDir, 'hls', `${height}p`)
                                                                                        if (!fs.existsSync(dir)) continue
                                                                                        const files = fs.readdirSync(dir)
                                                                                        for (const file of files) {
                                                                                                                    const contentType = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T'
                                                                                                                    await uploadToR2(`${hlsFolder}${height}p/${file}`, path.join(dir, file), contentType)
                                                                                        }
                                                                                        variants.push({ bandwidth: cfg.bandwidth, resolution: `${cfg.width}x${height}`, path: `${height}p/playlist.m3u8` })
                                                                                        console.log(`  cube HLS ${height}p -> ${hlsFolder}${height}p/ (${files.filter((file) => file.endsWith('.ts')).length} segments)`)
                                            }

                                            const masterTmp = path.join(tmpDir, 'master.m3u8')
                                            fs.writeFileSync(masterTmp, buildMasterPlaylist(variants))
                                            await uploadToR2(`${hlsFolder}master.m3u8`, masterTmp, 'application/vnd.apple.mpegurl')
                                            console.log(`  list Master playlist -> ${hlsFolder}master.m3u8`)
                                            return (fs.existsSync(thumbPath) ? fs.statSync(thumbPath).size : 0)
                                                                                        + (fs.existsSync(teaserPath) ? fs.statSync(teaserPath).size : 0)
                                                                                        + localDerivedBytes(path.join(tmpDir, 'hls'))
                } finally {
                                            fs.rmSync(tmpDir, { recursive: true, force: true })
                }
}

async function processExercise(exercise) {
                const { id, name, videoQualityHeights } = exercise
                const sources = await resolveSources(exercise)
                const mappedSlug = RECOMMENDED_SOURCE_MAP[id]?.slug
                if (mappedSlug) console.log(`  info Recovered source mapping: ${mappedSlug}`)

                const requestedHeights = Array.isArray(videoQualityHeights) && videoQualityHeights.length > 0
                                            ? videoQualityHeights.filter((height) => QUALITY_CONFIG[height])
                                            : DEFAULT_HEIGHTS
                const derivedBytesBySource = []
                for (let i = 0; i < sources.length; i++) {
                                            derivedBytesBySource.push(await processVariant(exercise, sources[i], requestedHeights, i, sources.length))
                }

                const primary = sources.find((source) => source.gender === 'male') || sources[0]
                const nextMedia = {}
                for (const gender of ['male', 'female']) {
                                            const entry = exercise.media?.[gender]
                                            const key = entry && typeof entry === 'object' ? (toObjectKey(entry.key) || toObjectKey(entry.url)) : null
                                            if (!key && entry?.url) nextMedia[gender] = entry
                }
                for (const source of sources) {
                                            if (!source.gender) continue
                                            const folder = source.key.slice(0, source.key.lastIndexOf('/') + 1)
                                            nextMedia[source.gender] = {
                                                                                        ...(nextMedia[source.gender] || {}),
                                                                                        key: source.key,
                                                                                        url: `${R2_PUBLIC_BASE}/${folder}hls/master.m3u8`,
                                                                                        thumb: `${R2_PUBLIC_BASE}/${folder}thumb.jpg`,
                                            }
                }

                for (let i = 0; i < sources.length; i++) {
                                            const source = sources[i]
                                            if (!source.alreadyProcessed) await markDone({ id, originalVideoKey: source.key, hlsProcessed: false, derivedBytes: derivedBytesBySource[i], sourceDeleted: false })
                                            if (!source.alreadyProcessed) {
                                                                                        await deleteFromR2(source.key)
                                                                                        console.log(`  trash  Original MP4 deleted -> ${source.key}`)
                                            }
                                            await markDone({ id, originalVideoKey: source.key, hlsProcessed: false, derivedBytes: derivedBytesBySource[i], sourceDeleted: true })
                }
                await markDone({ id, originalVideoKey: primary.key, media: nextMedia })
                console.log(`  check Done - "${name}" (${sources.length} video variant(s))`)
}

// --- Main ---------------------------------------------------------------------

async function main() {
                const pending = await fetchPending()
                const maxItems = Number(process.env.PROCESSOR_MAX_ITEMS || 200)
                if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 200) {
                                            throw new Error(`PROCESSOR_MAX_ITEMS must be an integer from 1 to 200 (received: ${process.env.PROCESSOR_MAX_ITEMS})`)
                }
                const needsReview = pending.filter((exercise) => NEEDS_SOURCE_REVIEW.has(exercise.id))
                const queue = pending.filter((exercise) => !NEEDS_SOURCE_REVIEW.has(exercise.id))
                const batch = queue.slice(0, maxItems)
                const heights = DEFAULT_HEIGHTS.join('+')
                console.log(`movie  Player.Action - Adaptive HLS Generator (tier-aware)\n`)

    if (pending.length === 0) {
                            console.log('check No pending exercises.')
                            return
    }

                console.log(`list ${batch.length} of ${queue.length} processable exercise(s); ${needsReview.length} pending source review (limit ${maxItems}):\n`)

    let ok = 0, fail = 0

    for (const ex of batch) {
                            const tierHeights = (Array.isArray(ex.videoQualityHeights) && ex.videoQualityHeights.length > 0)
                                            ? ex.videoQualityHeights.join('+')
                                                                    : heights
                            console.log(`\nrefresh "${ex.name}" (${ex.id}) [tier: ${tierHeights}p]`)
                            try {
                                                                    await processExercise(ex)
                                                                    ok++
                            } catch (err) {
                                                                    console.error(`  X ${err.message}`)
                                                                    fail++
                            }
    }

    console.log(`\n----------------------------`)
                console.log(`check ${ok} processed  ! ${needsReview.length} pending source review  X ${fail} failed`)
                if (fail > 0) process.exitCode = 1
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
