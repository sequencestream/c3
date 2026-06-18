// upload-to-server.mjs — push the signed release artifacts to a self-hosted store.
//
// Operates on an already-built + signed dist/ (run release:build then sign first;
// manifest.json drives the artifact list). Each file is POSTed individually to
// `${SERVER}/v1/artifact/upload` and stored under <version>/<batch>/<filename> on
// the server. A single `batch` is reused for every file so one release lands in
// one time subdirectory.
//
// Auth: a fixed bearer token (Authorization: Bearer <token>). Integrity: the
// per-file sha256 is sent as X-Artifact-Sha256 and re-checked server-side.
//
// Env (CLI flags override): C3_ARTIFACT_SERVER_URL, C3_ARTIFACT_UPLOAD_TOKEN.
// When the server URL or token is absent the script no-ops (exit 0) so local /
// unconfigured runs stay harmless.
//
//   node scripts/publish/upload-to-server.mjs [--dist=dist] [--version=vX.Y.Z] \
//     [--batch=20260618-1430Z] [--server=https://…] [--token=…] [--dry-run]
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256File } from '../release/manifest.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

function parseArgs(argv) {
  const o = {}
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) o[m[1]] = m[2] ?? true
  }
  return o
}

/** UTC timestamp safe as a path segment: YYYYMMDD-HHmmZ (matches the server's charset). */
function defaultBatch(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`
  )
}

/** The upload set: each artifact + its sidecars + the aggregate SHA256SUMS + manifest. */
function uploadList(manifest) {
  const files = []
  for (const a of manifest.artifacts) {
    files.push(basename(a.file), `${basename(a.file)}.sha256`, `${basename(a.file)}.minisig`)
  }
  files.push('SHA256SUMS', 'SHA256SUMS.minisig', 'manifest.json')
  return files
}

async function uploadFile({ server, token, version, batch, distDir, name, dryRun }) {
  const path = resolve(distDir, name)
  const hex = sha256File(path)
  const url =
    `${server.replace(/\/+$/, '')}/v1/artifact/upload` +
    `?version=${encodeURIComponent(version)}&batch=${encodeURIComponent(batch)}&filename=${encodeURIComponent(name)}`
  if (dryRun) {
    console.log(`  [dry-run] PUT ${name} (${hex.slice(0, 12)}…) → ${version}/${batch}/`)
    return
  }
  const body = readFileSync(path)
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'X-Artifact-Sha256': hex,
        },
        body,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status} — ${text.slice(0, 200)}`)
      }
      console.log(`  uploaded ${name} → ${version}/${batch}/`)
      return
    } catch (err) {
      lastErr = err
      if (attempt < 3) console.warn(`  retry ${name} (attempt ${attempt} failed: ${err.message})`)
    }
  }
  throw new Error(`upload failed for ${name}: ${lastErr?.message}`)
}

export async function uploadToServer({
  dist = 'dist',
  version,
  batch,
  server = process.env.C3_ARTIFACT_SERVER_URL,
  token = process.env.C3_ARTIFACT_UPLOAD_TOKEN,
  dryRun = false,
} = {}) {
  if (!server || !token) {
    console.log('[upload-to-server] C3_ARTIFACT_SERVER_URL/TOKEN unset — skipping (no-op).')
    return { skipped: true }
  }

  const distDir = resolve(repoRoot, dist)
  const manifestPath = resolve(distDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.error(
      '[upload-to-server] dist/manifest.json missing — run `release:build` + sign first.',
    )
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  const ver = version || `v${manifest.version}`
  const b = batch || defaultBatch()

  const files = uploadList(manifest).filter((f) => existsSync(resolve(distDir, f)))
  console.log(
    `[upload-to-server] ${files.length} file(s) → ${server} as ${ver}/${b}/${dryRun ? '  (dry-run)' : ''}`,
  )
  for (const name of files) {
    await uploadFile({ server, token, version: ver, batch: b, distDir, name, dryRun })
  }
  console.log(`[upload-to-server] done — ${ver}/${b}/`)
  return { skipped: false, version: ver, batch: b, count: files.length }
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2))
  await uploadToServer({
    dist: typeof args.dist === 'string' ? args.dist : 'dist',
    version: typeof args.version === 'string' ? args.version : undefined,
    batch: typeof args.batch === 'string' ? args.batch : undefined,
    server: typeof args.server === 'string' ? args.server : undefined,
    token: typeof args.token === 'string' ? args.token : undefined,
    dryRun: Boolean(args['dry-run']),
  })
}
