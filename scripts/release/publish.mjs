// release:publish (release 3/7) — checksum the built artifacts + cut a GitHub Release.
//
// Operates on an already-built dist/ (run `pnpm release:build` first; manifest.json drives
// the artifact list). Steps: warn on dirty tree → checksum (SHA256SUMS + .sha256) →
// create the git tag → `gh release create` with every artifact + sidecar + notes.
//
// `--dry-run` REHEARSES: it prints the full plan (tag, files, notes) and executes nothing
// with an external or irreversible effect — no tag, no `gh`. This is what makes
// `release:publish --dry-run` safe to run anywhere.
//
//   node scripts/release/publish.mjs [--dry-run]
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactsFromManifest, signArtifacts } from './sign.mjs'
import { buildNotes } from './notes.mjs'
import { verifyDist } from './postgate.mjs'

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

function git(args) {
  return spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' })
}

export async function publish({ dryRun = false, noPublish = false, manifestPath: mp } = {}) {
  const manifestPath = mp ? resolve(mp) : resolve(repoRoot, 'dist', 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.error('[publish] dist/manifest.json missing — run `pnpm release:build` first.')
    process.exit(1)
  }
  const { version, artifacts } = artifactsFromManifest(manifestPath)
  const { tag, notes } = buildNotes()

  // Upload set = each artifact + its .sha256 sidecar + the aggregate SHA256SUMS.
  const uploads = []
  for (const a of artifacts) {
    uploads.push(a.name, `${a.name}.sha256`)
  }
  uploads.push('SHA256SUMS')

  const dirty = (git(['status', '--porcelain']).stdout || '').trim()

  console.log(`[publish] tag ${tag} — ${artifacts.length} artifact(s)`)
  if (dirty)
    console.warn('[publish] ⚠ working tree is dirty — release should be cut from a clean tree')
  console.log('[publish] plan:')
  console.log('  1. checksum    → SHA256SUMS + per-artifact .sha256')
  console.log(
    '  1b. verify     → manifest ↔ SHA256SUMS ↔ on-disk + P0 complete (abort on mismatch)',
  )
  console.log(`  2. tag         → git tag -a ${tag}`)
  if (!noPublish) {
    console.log(`  3. gh release  → gh release create ${tag} (${uploads.length} files)`)
    for (const u of uploads) console.log(`       upload ${u}`)
  } else {
    console.log('  3. gh release  → skipped (--no-publish: checksum locally only)')
  }

  if (dryRun) {
    console.log('[publish] --dry-run: nothing written, no tag, no GitHub Release created.')
    return { dryRun: true, tag, uploads }
  }

  // 1. checksum
  console.log('\n[publish] hashing artifacts…')
  signArtifacts({
    artifacts,
    outDir: dirname(manifestPath),
    version,
    log: (m) => console.log(m),
  })

  // 1b. final check (release 5/7) — manifest ↔ SHA256SUMS ↔ on-disk + P0 complete.
  //     Runs after checksumming (needs SHA256SUMS) and before anything irreversible.
  console.log('\n[publish] verify-dist final check…')
  try {
    verifyDist({ manifestPath, log: (m) => console.log(m) })
  } catch (err) {
    console.error(`[publish] ✗ verify-dist failed: ${err.message}`)
    console.error('[publish] aborting — no tag, no GitHub Release.')
    process.exit(1)
  }

  if (noPublish) {
    console.log('[publish] --no-publish: hashed + verified locally; no tag, no GitHub Release.')
    return { dryRun: false, noPublish: true, tag, uploads }
  }

  // 2. tag (idempotent: skip if it already exists)
  const exists = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0
  if (exists) {
    console.log(`[publish] tag ${tag} already exists — reusing`)
  } else {
    const t = git(['tag', '-a', tag, '-m', `c3 release ${tag}`])
    if (t.status !== 0) {
      console.error(`[publish] git tag failed: ${(t.stderr || '').trim()}`)
      process.exit(1)
    }
    console.log(`[publish] created tag ${tag}`)
  }

  // 3. GitHub Release via gh
  const distDir = dirname(manifestPath)
  const ghArgs = [
    'release',
    'create',
    tag,
    ...uploads.map((u) => resolve(distDir, u)),
    '--title',
    `c3 ${tag}`,
    '--notes',
    notes,
  ]
  const gh = spawnSync('gh', ghArgs, { cwd: repoRoot, stdio: 'inherit' })
  if (gh.status !== 0) {
    console.error('[publish] gh release create failed (push the tag and ensure `gh auth login`).')
    process.exit(1)
  }
  console.log(`[publish] GitHub Release ${tag} published.`)
  return { dryRun: false, tag, uploads }
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2))
  await publish({
    dryRun: Boolean(args['dry-run']),
    noPublish: Boolean(args['no-publish']),
    manifestPath: typeof args.manifest === 'string' ? args.manifest : undefined,
  })
}
