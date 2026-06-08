// publish-binaries — locally sign the downloaded build artifacts and publish them as a
// GitHub Release on the PUBLIC distribution repo (default: sequencestream/c3).
//
// Why this exists: the source repo (sequencestream/code-creative-center) is PRIVATE, but the
// signed binaries are meant to be public. CI builds the artifacts there; `download-artifacts.sh`
// pulls them into `dist/release-artifacts/<version>/<artifact>/…`. This script then, on a
// trusted local machine that holds the minisign SECRET key:
//   1. merge the per-target subdirs into one flat set (reuses release/merge-dist.mjs),
//   2. sign every package (SHA256SUMS + per-artifact .sha256 + .minisig — release/sign.mjs),
//   3. verify the set is internally consistent (release/postgate.mjs),
//   4. bootstrap the public repo's default branch if it is still empty (one README commit),
//   5. cut a GitHub Release on the PUBLIC repo with every artifact + sidecar + the public key.
//
// The signing + sidecar formats are byte-identical to `pnpm release:publish`, so the binary's
// embedded `c3 verify` and the official `minisign -V` both validate these downloads.
//
// Usage:
//   node scripts/publish/publish-binaries.mjs [<version>] [options]
//   pnpm publish:binaries [<version>] [options]
//
// Options:
//   --dry-run            rehearse: print the full plan, touch nothing (no merge, no sign, no gh)
//   --repo=owner/name    target distribution repo (default: $C3_PUBLISH_REPO or sequencestream/c3)
//   --key-file=path      minisign secret blob (default: $C3_MINISIGN_SECRET_KEY[_FILE] or
//                        dist/c3-minisign-secret.key)
//   --allow-unsigned     publish .sha256/SHA256SUMS WITHOUT .minisig (NOT recommended for public)
//   --clobber            if the Release/tag already exists, re-upload assets instead of aborting
//   --yes                skip the confirmation prompt before bootstrapping the empty public repo
//
// Requires: an authenticated `gh` CLI with push access to the target repo.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { mergeDist } from '../release/merge-dist.mjs'
import { artifactsFromManifest, signArtifacts, secretFromEnv } from '../release/sign.mjs'
import { verifyDist } from '../release/postgate.mjs'
import { topChangelogSection } from '../release/notes.mjs'
import { parseSecretBlob, formatPublicKey, verifyContent } from '../release/minisign.mjs'
import { P0_TARGETS } from '../release/targets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

const DEFAULT_REPO = process.env.C3_PUBLISH_REPO || 'sequencestream/c3'
const DEFAULT_KEY_FILE = resolve(repoRoot, 'dist', 'c3-minisign-secret.key')
const ARTIFACTS_BASE = resolve(repoRoot, 'dist', 'release-artifacts')

// DER prefixes for raw Ed25519 keys — mirror minisign.mjs so we can derive the public key
// (and a shippable minisign.pub) straight from the secret seed, guaranteeing they match.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function parseArgs(argv) {
  const o = { _: [] }
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) o[m[1]] = m[2] ?? true
    else o._.push(a)
  }
  return o
}

function gh(args, { capture = false } = {}) {
  return spawnSync('gh', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: capture ? 'pipe' : 'inherit',
  })
}

/** Resolve the artifacts directory for <version>. Auto-pick when omitted: the only dir, or
 *  the highest semver. */
function resolveVersionDir(version) {
  if (!existsSync(ARTIFACTS_BASE))
    fail(`${ARTIFACTS_BASE} not found — run scripts/publish/download-artifacts.sh first.`)
  if (version) {
    const dir = resolve(ARTIFACTS_BASE, version)
    if (!existsSync(dir)) fail(`no artifacts for version ${version} at ${dir}`)
    return { version, dir }
  }
  const dirs = readdirSync(ARTIFACTS_BASE)
    .filter((n) => !n.startsWith('.') && statSync(join(ARTIFACTS_BASE, n)).isDirectory())
    .sort(compareSemver)
  if (!dirs.length) fail(`no version dirs under ${ARTIFACTS_BASE} — download artifacts first.`)
  const picked = dirs[dirs.length - 1]
  if (dirs.length > 1)
    console.warn(
      `[publish] multiple versions present (${dirs.join(', ')}) — picking ${picked}; pass <version> to override.`,
    )
  return { version: picked, dir: resolve(ARTIFACTS_BASE, picked) }
}

/** Numeric-aware semver-ish compare (x.y.z[-pre]); stable enough for picking the latest dir. */
function compareSemver(a, b) {
  const seg = (s) => s.split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p))
  const pa = seg(a)
  const pb = seg(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

/** List the per-target sub-manifests under the version dir WITHOUT mutating anything (dry-run). */
function peekTargets(versionDir) {
  const out = []
  for (const name of readdirSync(versionDir)) {
    const sub = join(versionDir, name)
    if (!statSync(sub).isDirectory()) continue
    const mp = join(sub, 'manifest.json')
    if (!existsSync(mp)) continue
    const m = JSON.parse(readFileSync(mp, 'utf-8'))
    for (const a of m.artifacts) out.push({ target: a.target, file: a.file, version: m.version })
  }
  return out
}

/** Resolve the minisign secret blob: env first, then --key-file / the default dist file. */
function resolveSecret(keyFileArg) {
  const fromEnv = secretFromEnv()
  if (fromEnv) return { secretKeyB64: fromEnv, source: 'env C3_MINISIGN_SECRET_KEY[_FILE]' }
  const keyFile = keyFileArg ? resolve(keyFileArg) : DEFAULT_KEY_FILE
  if (existsSync(keyFile))
    return { secretKeyB64: readFileSync(keyFile, 'utf-8').trim(), source: keyFile }
  return { secretKeyB64: undefined, source: null }
}

/** Derive the minisign PUBLIC key text from the secret blob (keyId||seed). */
function publicKeyTextFromSecret(secretKeyB64) {
  const { keyId, seed } = parseSecretBlob(secretKeyB64)
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
  const publicKeyRaw = createPublicKey(priv)
    .export({ type: 'spki', format: 'der' })
    .subarray(SPKI_PREFIX.length)
  return {
    keyId: keyId.toString('hex'),
    text: formatPublicKey({ keyId, publicKeyRaw, comment: 'c3 release signing key (minisign)' }),
  }
}

/** Top CHANGELOG section for this version → GitHub Release notes. */
function buildNotesFor(version, pubKeyId) {
  const cl = resolve(repoRoot, 'CHANGELOG.md')
  let section = null
  if (existsSync(cl)) section = topChangelogSection(readFileSync(cl, 'utf-8'))
  const body = section ?? `## ${version}\n\n_No CHANGELOG.md section found._`
  return (
    `${body}\n\n---\n\n` +
    `**Verify your download** (minisign key id \`${pubKeyId}\`):\n\n` +
    '```\n' +
    'minisign -Vm <artifact> -p minisign.pub      # using the published public key, or\n' +
    'c3 verify <artifact>                          # using the key embedded in the binary\n' +
    '```\n\n' +
    'Or check `SHA256SUMS`: `shasum -a 256 -c SHA256SUMS`.\n'
  )
}

/** README seeded into the empty distribution repo on first publish. */
function bootstrapReadme(repo, pubKeyText, pubKeyId) {
  return (
    `# c3\n\n` +
    `Signed binary distribution for **c3 (Code Creative Center)**.\n\n` +
    `Source lives in a private repo; every release here is a signed build published from a\n` +
    `trusted machine. Downloads are under [Releases](https://github.com/${repo}/releases).\n\n` +
    `## Verify a download\n\n` +
    `minisign public key (key id \`${pubKeyId}\`):\n\n` +
    '```\n' +
    pubKeyText.trim() +
    '\n```\n\n' +
    `Each release ships \`minisign.pub\`, per-artifact \`.sha256\`/\`.minisig\`, and \`SHA256SUMS\`:\n\n` +
    '```\n' +
    'minisign -Vm c3-vX.Y.Z-<target>.tar.gz -p minisign.pub\n' +
    'shasum -a 256 -c SHA256SUMS\n' +
    '```\n'
  )
}

function fail(msg) {
  console.error(`[publish] ✗ ${msg}`)
  process.exit(1)
}

async function confirm(question) {
  process.stdout.write(`${question} [y/N] `)
  const ans = await new Promise((res) => {
    process.stdin.resume()
    process.stdin.once('data', (d) => {
      process.stdin.pause()
      res(String(d).trim().toLowerCase())
    })
  })
  return ans === 'y' || ans === 'yes'
}

/** Does the target repo already have a default branch (i.e. at least one commit)? */
function repoDefaultBranch(repo) {
  const r = gh(['repo', 'view', repo, '--json', 'defaultBranchRef'], { capture: true })
  if (r.status !== 0) fail(`cannot access repo ${repo}: ${(r.stderr || '').trim()}`)
  try {
    return JSON.parse(r.stdout)?.defaultBranchRef?.name || ''
  } catch {
    return ''
  }
}

/** Create README.md via the contents API — this also creates the repo's default branch. */
function bootstrapRepo(repo, readme) {
  const content = Buffer.from(readme).toString('base64')
  const r = gh(
    [
      'api',
      '--method',
      'PUT',
      `repos/${repo}/contents/README.md`,
      '-f',
      'message=chore: bootstrap c3 distribution repo',
      '-f',
      `content=${content}`,
    ],
    { capture: true },
  )
  if (r.status !== 0) fail(`bootstrap commit failed: ${(r.stderr || '').trim()}`)
}

function releaseExists(repo, tag) {
  return gh(['release', 'view', tag, '--repo', repo], { capture: true }).status === 0
}

export async function publishBinaries(opts = {}) {
  const {
    version: versionArg,
    dryRun = false,
    repo = DEFAULT_REPO,
    keyFile,
    allowUnsigned = false,
    clobber = false,
    yes = false,
  } = opts

  const { version, dir } = resolveVersionDir(versionArg)
  const tag = `v${version}`
  console.log(`[publish] version ${version} → repo ${repo} (tag ${tag})`)
  console.log(`[publish] artifacts: ${dir}`)

  // Secret key — required unless explicitly opting into an unsigned public release.
  const { secretKeyB64, source } = resolveSecret(keyFile)
  if (!secretKeyB64 && !allowUnsigned)
    fail(
      'no minisign secret key (env C3_MINISIGN_SECRET_KEY[_FILE] or dist/c3-minisign-secret.key). ' +
        'Pass --allow-unsigned to publish without .minisig (not recommended).',
    )
  const signing = Boolean(secretKeyB64)
  const pub = signing ? publicKeyTextFromSecret(secretKeyB64) : null
  if (signing) console.log(`[publish] signing key: ${source} (key id ${pub.keyId})`)

  const present = peekTargets(dir)
  const targets = [...new Set(present.map((a) => a.target))]
  const missingP0 = P0_TARGETS.filter((t) => !targets.includes(t))
  console.log(`[publish] targets: ${targets.join(', ')}`)
  if (missingP0.length)
    console.warn(`[publish] ⚠ P0 target(s) not in this download: ${missingP0.join(', ')}`)

  const defaultBranch = repoDefaultBranch(repo)
  const needsBootstrap = !defaultBranch

  // Plan summary.
  const sidecars = signing ? ['.sha256', '.minisig'] : ['.sha256']
  console.log('[publish] plan:')
  console.log(`  1. merge      → flatten ${targets.length} target(s) into ${dir}`)
  console.log(
    `  2. sign       → SHA256SUMS + per-artifact ${sidecars.join('/')}${signing ? ' + SHA256SUMS.minisig + minisign.pub' : ' (UNSIGNED)'}`,
  )
  console.log('  3. verify     → manifest ↔ SHA256SUMS ↔ on-disk (abort on mismatch)')
  if (needsBootstrap)
    console.log(`  4. bootstrap  → seed empty ${repo} with an initial README commit`)
  console.log(
    `  ${needsBootstrap ? '5' : '4'}. gh release → ${releaseExists(repo, tag) ? (clobber ? 'upload --clobber to existing' : 'EXISTS (pass --clobber)') : 'create'} ${tag} on ${repo}`,
  )

  if (dryRun) {
    console.log('[publish] --dry-run: nothing merged, signed, committed, or released.')
    return { dryRun: true, version, tag, repo, targets }
  }

  if (releaseExists(repo, tag) && !clobber)
    fail(`release ${tag} already exists on ${repo} — pass --clobber to re-upload assets.`)

  // 1. merge per-target subdirs into one flat set + manifest.json + SHA256SUMS.
  console.log('\n[publish] merging artifacts…')
  const { manifestPath } = mergeDist({ distDir: dir, log: (m) => console.log(m) })
  const { artifacts } = artifactsFromManifest(manifestPath)

  // 2. sign.
  console.log('\n[publish] signing…')
  signArtifacts({
    artifacts,
    outDir: dir,
    version,
    secretKeyB64,
    log: (m) => console.log(m),
  })

  // 2b. write the public key asset + self-verify one signature against it (catches a wrong key).
  let pubPath = null
  if (signing) {
    pubPath = resolve(dir, 'minisign.pub')
    writeFileSync(pubPath, pub.text)
    const sample = artifacts[0]
    const sig = readFileSync(`${sample.path}.minisig`, 'utf-8')
    const res = verifyContent(readFileSync(sample.path), sig, pub.text)
    if (!res.ok) fail(`self-verify failed for ${sample.name}: ${res.reason}`)
    console.log(`  ✓ self-verified ${sample.name} against minisign.pub`)
  }

  // 3. verify-dist. Only require the targets actually present (CI gates P0 completeness at build).
  console.log('\n[publish] verify-dist…')
  process.env.C3_REQUIRED_TARGETS = targets.join(',')
  try {
    verifyDist({ manifestPath, log: (m) => console.log(m) })
  } catch (err) {
    fail(`verify-dist failed: ${err.message}`)
  }

  // 4. bootstrap the empty public repo (outward-facing — confirm first).
  if (needsBootstrap) {
    console.log(`\n[publish] ${repo} has no default branch (empty repo).`)
    if (!yes) {
      const ok = await confirm(`Push an initial README commit to ${repo} to bootstrap it?`)
      if (!ok) fail('aborted before bootstrap.')
    }
    console.log('[publish] bootstrapping…')
    bootstrapRepo(repo, bootstrapReadme(repo, pub?.text ?? '', pub?.keyId ?? 'n/a'))
    console.log(`[publish] ${repo} bootstrapped.`)
  }

  // 5. cut / update the GitHub Release on the PUBLIC repo.
  const uploads = []
  for (const a of artifacts) {
    uploads.push(resolve(dir, a.name), resolve(dir, `${a.name}.sha256`))
    if (signing) uploads.push(resolve(dir, `${a.name}.minisig`))
  }
  uploads.push(resolve(dir, 'SHA256SUMS'))
  if (signing) {
    uploads.push(resolve(dir, 'SHA256SUMS.minisig'))
    if (pubPath) uploads.push(pubPath)
  }

  if (releaseExists(repo, tag)) {
    console.log(`\n[publish] uploading ${uploads.length} asset(s) to existing ${tag} (--clobber)…`)
    const r = gh(['release', 'upload', tag, ...uploads, '--repo', repo, '--clobber'])
    if (r.status !== 0) fail('gh release upload failed.')
  } else {
    console.log(`\n[publish] creating release ${tag} on ${repo} (${uploads.length} asset(s))…`)
    const notes = buildNotesFor(version, pub?.keyId ?? 'n/a')
    const r = gh([
      'release',
      'create',
      tag,
      ...uploads,
      '--repo',
      repo,
      '--title',
      `c3 ${tag}`,
      '--notes',
      notes,
    ])
    if (r.status !== 0) fail('gh release create failed (check `gh auth login` and repo access).')
  }

  console.log(`\n[publish] ✓ published ${tag} → https://github.com/${repo}/releases/tag/${tag}`)
  return { dryRun: false, version, tag, repo, targets, uploads }
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2))
  await publishBinaries({
    version: args._[0],
    dryRun: Boolean(args['dry-run']),
    repo: typeof args.repo === 'string' ? args.repo : undefined,
    keyFile: typeof args['key-file'] === 'string' ? args['key-file'] : undefined,
    allowUnsigned: Boolean(args['allow-unsigned']),
    clobber: Boolean(args.clobber),
    yes: Boolean(args.yes),
  })
}
