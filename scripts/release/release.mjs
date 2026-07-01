// pnpm release — interactive local release: prompt for a version, cross-compile the
// three shipping targets on THIS host (no Docker, no GH Actions), collect the signed
// packages under dist/release-artifacts/v<ver>/, then optionally upload them to the
// self-hosted license-server store.
//
// Bun cross-compiles every target from one macOS/Linux host, so a single machine
// produces the linux-x64 + macos-arm64 + windows-x64 set. Windows in particular needs
// no Windows runner and no container — `bun --compile --target=bun-windows-x64` writes
// c3.exe directly.
//
// Flow:
//   1. version   — prompt (or --version); normalized to X.Y.Z and validated
//   2. gate      — source pregate (typecheck/lint/test/…); --skip-gate to bypass
//   3. build     — release-build.mjs --targets=<three>  (dist/c3-v<ver>-<target>.{tar.gz,zip})
//   4. sign      — SHA256SUMS + per-package .sha256 (+ .minisig when a secret key is present)
//   5. collect   — copy the package set + sidecars + manifest.json into
//                  dist/release-artifacts/v<ver>/  (the layout publish:binaries also reads)
//   6. upload    — optional POST to the license-server /v1/artifact/upload store
//
// The GitHub-publish path lives on unchanged as `pnpm release:github` (release-github.mjs)
// and the decomposed scripts (release:build / release:sign / release:publish / publish:binaries).
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { runPregate } from './pregate.mjs'
import { computeVersionInfo } from './version-info.mjs'
import { normalizeVersion } from './artifact-name.mjs'
import { artifactsFromManifest, signArtifacts, secretFromEnv } from './sign.mjs'
import { publicKeyTextFromSecret } from './minisign.mjs'
import { uploadToServer, resolveServer, resolveToken } from '../publish/upload-to-server.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

// The three targets this local flow always ships. All cross-compile from one host.
const RELEASE_TARGETS = ['linux-x64', 'macos-arm64', 'windows-x64']
// Default minisign secret blob (keyId||seed) when neither env nor --key-file is set. gitignored.
const DEFAULT_KEY_FILE = resolve(repoRoot, 'dist', 'c3-minisign-secret.key')

function parseArgs(argv) {
  const o = { passthrough: [] }
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    const [, k, v] = m
    if (k === 'dry-run') o.dryRun = true
    else if (k === 'skip-gate') o.skipGate = true
    else if (k === 'skip-upload') o.skipUpload = true
    else if (k === 'yes') o.yes = true
    else if (k === 'version') o.version = v
    else if (k === 'targets') o.targets = v
    else if (k === 'harden') o.harden = v
    else if (k === 'server') o.server = v
    else if (k === 'token') o.token = v
    else if (k === 'batch') o.batch = v
    else if (k === 'key-file') o.keyFile = v
    else if (['skip-web', 'skip-smoke', 'skip-pack'].includes(k)) o.passthrough.push(a)
  }
  return o
}

function run(script, scriptArgs) {
  return new Promise((res, rej) => {
    const p = spawn('node', [resolve(here, script), ...scriptArgs], {
      stdio: 'inherit',
      cwd: repoRoot,
    })
    p.on('error', rej)
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${script} → exit ${code}`))))
  })
}

/** A version is X.Y.Z with an optional prerelease/build tail; a single leading `v` is tolerated. */
function isValidVersion(v) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalizeVersion(v))
}

/** Resolve the release version: --version wins; otherwise prompt with the baseline as default. */
async function resolveVersion(args) {
  if (args.version) {
    const v = normalizeVersion(args.version.trim())
    if (!isValidVersion(v))
      throw new Error(`--version "${args.version}" is not a valid X.Y.Z version`)
    return v
  }
  if (!process.stdin.isTTY)
    throw new Error(
      'no TTY to prompt for a version — pass --version=X.Y.Z in non-interactive runs.',
    )

  const suggested = computeVersionInfo().version
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const answer = (await rl.question(`Release version [${suggested}]: `)).trim()
      const v = normalizeVersion(answer || suggested)
      if (isValidVersion(v)) return v
      console.log(`  ✗ "${answer}" is not a valid version (expected X.Y.Z). Try again.`)
    }
  } finally {
    rl.close()
  }
}

/** Prompt a yes/no question (default No). Returns false when there is no TTY. */
async function confirm(question, defaultYes = false) {
  if (!process.stdin.isTTY) return defaultYes
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `))
      .trim()
      .toLowerCase()
    if (!answer) return defaultYes
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

/** Resolve the minisign secret blob (keyId||seed): env > --key-file > the default dist key file.
 *  Returns { secretKeyB64, source } — secretKeyB64 undefined when no key is found anywhere. */
function resolveSecret(keyFileArg) {
  const fromEnv = secretFromEnv()
  if (fromEnv) return { secretKeyB64: fromEnv, source: 'env C3_MINISIGN_SECRET_KEY[_FILE]' }
  const keyFile = keyFileArg ? resolve(keyFileArg) : DEFAULT_KEY_FILE
  if (existsSync(keyFile))
    return { secretKeyB64: readFileSync(keyFile, 'utf-8').trim(), source: keyFile }
  return { secretKeyB64: undefined, source: null }
}

/** The upload set for a release: every package + its sidecars + the aggregate index files.
 *  `.minisig`/`minisign.pub` are included ONLY when this run actually signed — dist/ is reused
 *  across runs, so a stale signature from a prior signed build must never leak into a later set. */
function collectFiles(manifest, signed) {
  const files = []
  for (const a of manifest.artifacts) {
    const name = a.file
    files.push(name, `${name}.sha256`)
    if (signed) files.push(`${name}.minisig`)
  }
  files.push('SHA256SUMS', 'manifest.json')
  if (signed) files.push('SHA256SUMS.minisig', 'minisign.pub')
  return files
}

/** Copy the built package set from dist/ into dist/release-artifacts/v<ver>/ (flat layout). */
function collectArtifacts(distDir, outDir, manifest, signed, log) {
  mkdirSync(outDir, { recursive: true })
  const copied = []
  for (const name of collectFiles(manifest, signed)) {
    const src = resolve(distDir, name)
    if (!existsSync(src)) continue
    copyFileSync(src, resolve(outDir, name))
    copied.push(name)
  }
  log(`  collected ${copied.length} file(s) → ${outDir}`)
  return copied
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const targets = args.targets
    ? args.targets
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : RELEASE_TARGETS
  // Default to the obfuscated `standard` tier — a bare `pnpm release` ships hardened.
  // Opt down to minify-only / debug with an explicit --harden=basic|none.
  const harden = String(args.harden || process.env.RELEASE_HARDEN || 'standard')

  const version = await resolveVersion(args)
  const tag = `v${version}`
  // Thread the chosen version to every child so the packages / manifest all stamp it.
  process.env.C3_RELEASE_VERSION = version

  const distDir = resolve(repoRoot, 'dist')
  const outDir = resolve(distDir, 'release-artifacts', tag)

  console.log(
    `[release] ${args.dryRun ? 'DRY-RUN ' : ''}${tag} — ` +
      `gate → build(${targets.join(',')}) → sign → collect → ${args.skipUpload ? 'no-upload' : 'upload?'}`,
  )
  console.log(`[release]   harden ${harden}, out ${outDir}`)

  // 1. pregate — blocking source gate; skip with --skip-gate, list-only with --dry-run.
  if (!args.skipGate) {
    const { failed } = runPregate({ dryRun: args.dryRun })
    if (failed) {
      console.error(
        `[release] aborted — source gate "${failed}" is red (no cross-compile attempted).`,
      )
      process.exit(1)
    }
  } else {
    console.log('[release] --skip-gate: source gates skipped.')
  }

  if (args.dryRun) {
    console.log('[release] --dry-run: would build + sign + collect into', outDir)
    console.log(
      `[release] --dry-run: would ${args.skipUpload ? 'skip upload' : 'offer LS upload'}.`,
    )
    return
  }

  // 2. build the three targets (Phase0 web → Phase1 embed → Phase2 cross-compile → pack).
  await run('release-build.mjs', [
    `--targets=${targets.join(',')}`,
    `--harden=${harden}`,
    ...args.passthrough,
  ])

  // 3. sign in place — SHA256SUMS + per-package .sha256/.minisig + SHA256SUMS.minisig + minisign.pub.
  const manifestPath = resolve(distDir, 'manifest.json')
  if (!existsSync(manifestPath))
    throw new Error(
      `build produced no manifest at ${manifestPath} (harden=none skips it — use basic/standard).`,
    )
  const { artifacts } = artifactsFromManifest(manifestPath)
  console.log('\n[release] signing…')
  const { secretKeyB64, source } = resolveSecret(args.keyFile)
  if (secretKeyB64) console.log(`  key ${source}`)
  const { signed } = signArtifacts({
    artifacts,
    outDir: distDir,
    version,
    secretKeyB64,
    log: (m) => console.log(m),
  })
  // Emit a shippable minisign.pub derived from the SAME secret, then self-verify one signature
  // against it so a wrong/mismatched key can't ship silently.
  if (signed) {
    const pub = publicKeyTextFromSecret(secretKeyB64)
    writeFileSync(resolve(distDir, 'minisign.pub'), pub.text)
    console.log(`  minisign.pub (key id ${pub.keyId.toString('hex')})`)
  } else {
    console.log(
      '  ⚠ unsigned — no minisign secret (env C3_MINISIGN_SECRET_KEY[_FILE], --key-file, or ' +
        `${DEFAULT_KEY_FILE}). Run \`pnpm release:keygen\` to mint one; packages still verify by sha256.`,
    )
  }

  // 4. collect into dist/release-artifacts/v<ver>/ (the flat layout publish:binaries reads).
  console.log('\n[release] collecting…')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  collectArtifacts(distDir, outDir, manifest, signed, (m) => console.log(m))

  // 5. optional upload to the license-server store. Server defaults to the production URL;
  //    the token resolves from env or dist/.upload_license_server_auth_token.key.
  if (args.skipUpload) {
    console.log(`\n[release] --skip-upload: packages ready at ${outDir}`)
  } else {
    const server = resolveServer(args.server)
    const token = resolveToken(args.token)
    if (!token) {
      console.log(
        '\n[release] no upload token — set C3_ARTIFACT_UPLOAD_TOKEN, pass --token, or drop it in ' +
          'dist/.upload_license_server_auth_token.key to enable license-server upload.',
      )
      console.log(`[release] packages ready at ${outDir}`)
    } else if (await confirm(`Upload ${tag} to ${server}?`)) {
      const rel = `dist/release-artifacts/${tag}`
      await uploadToServer({ dist: rel, version: tag, batch: args.batch, server, token })
    } else {
      console.log(`[release] upload skipped — packages ready at ${outDir}`)
    }
  }

  console.log(`\n[release] done — ${tag} at ${outDir}`)
}

main().catch((err) => {
  console.error(`[release] ✗ ${err.message}`)
  process.exit(1)
})
