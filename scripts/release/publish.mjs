// release:publish (release 3/7) — sign the built artifacts + cut a GitHub Release.
//
// Operates on an already-built dist/ (run `pnpm release:build` first; manifest.json drives
// the artifact list). Steps: warn on dirty tree → sign (SHA256SUMS + .sha256 + .minisig) →
// create the git tag → `gh release create` with every artifact + sidecar + notes.
//
// `--dry-run` REHEARSES: it prints the full plan (tag, files, notes) and executes nothing
// with an external or irreversible effect — no signing, no tag, no `gh`. This is what makes
// `release:publish --dry-run` safe to run anywhere.
//
//   node scripts/release/publish.mjs [--dry-run]
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactsFromManifest, signArtifacts, secretFromEnv } from './sign.mjs'
import { buildNotes } from './notes.mjs'

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
  const hasKey = Boolean(secretFromEnv())

  // Upload set = each artifact + its sidecars + the aggregate SHA256SUMS(.minisig).
  const uploads = []
  for (const a of artifacts) {
    uploads.push(a.name, `${a.name}.sha256`)
    if (hasKey) uploads.push(`${a.name}.minisig`)
  }
  uploads.push('SHA256SUMS')
  if (hasKey) uploads.push('SHA256SUMS.minisig')

  const dirty = (git(['status', '--porcelain']).stdout || '').trim()

  console.log(
    `[publish] tag ${tag} — ${artifacts.length} artifact(s), minisign ${hasKey ? 'ON' : 'OFF (no key)'}`,
  )
  if (dirty)
    console.warn('[publish] ⚠ working tree is dirty — release should be cut from a clean tree')
  console.log('[publish] plan:')
  console.log(
    `  1. sign        → SHA256SUMS + per-artifact .sha256${hasKey ? ' + .minisig' : ' (no key → skip .minisig)'}`,
  )
  console.log(`  2. tag         → git tag -a ${tag}`)
  if (!noPublish) {
    console.log(`  3. gh release  → gh release create ${tag} (${uploads.length} files)`)
    for (const u of uploads) console.log(`       upload ${u}`)
  } else {
    console.log('  3. gh release  → skipped (--no-publish: sign locally only)')
  }

  if (dryRun) {
    console.log('[publish] --dry-run: nothing signed, no tag, no GitHub Release created.')
    return { dryRun: true, tag, uploads }
  }

  if (!hasKey) {
    console.warn(
      '[publish] ⚠ C3_MINISIGN_SECRET_KEY[_FILE] not set — publishing WITHOUT minisign signatures.',
    )
  }

  // 1. sign
  console.log('\n[publish] signing artifacts…')
  signArtifacts({
    artifacts,
    outDir: dirname(manifestPath),
    version,
    secretKeyB64: secretFromEnv(),
    log: (m) => console.log(m),
  })

  if (noPublish) {
    console.log('[publish] --no-publish: signed locally; no tag, no GitHub Release.')
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
