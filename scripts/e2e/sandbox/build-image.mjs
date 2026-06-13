#!/usr/bin/env node
/**
 * Build the c3 sandbox E2E base image.
 *
 * Produces a local Docker image (default tag `c3-sandbox-e2e:latest`) with the
 * `claude` and `codex` vendor CLIs installed — the image the sandbox E2E
 * (`e2e-sandbox-container-test.mjs`) configures c3 to use and verifies the
 * container path against. See ./Dockerfile for what goes in.
 *
 * Usage:
 *   node scripts/e2e/sandbox/build-image.mjs              # build c3-sandbox-e2e:latest
 *   C3_SANDBOX_IMAGE=foo:bar node .../build-image.mjs     # custom tag
 *   node scripts/e2e/sandbox/build-image.mjs --no-cache   # force a clean rebuild
 *
 * Exit codes: 0 built (or already present with --skip-existing), non-zero on
 * failure or Docker unavailable.
 */
import { spawnSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const IMAGE = process.env.C3_SANDBOX_IMAGE || 'c3-sandbox-e2e:latest'
const argv = process.argv.slice(2)
const NO_CACHE = argv.includes('--no-cache')
const SKIP_EXISTING = argv.includes('--skip-existing')

function dockerAvailable() {
  try {
    execSync('docker info --format "{{.ServerVersion}}"', { timeout: 8000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function imageExists(tag) {
  const r = spawnSync('docker', ['image', 'inspect', tag], { stdio: 'pipe' })
  return r.status === 0
}

if (!dockerAvailable()) {
  console.error('[build-image] Docker is not available — start Docker and retry.')
  process.exit(2)
}

if (SKIP_EXISTING && imageExists(IMAGE)) {
  console.log(`[build-image] ${IMAGE} already present — skipping (--skip-existing).`)
  process.exit(0)
}

console.log(`[build-image] building ${IMAGE} from ${HERE}/Dockerfile …`)
const args = ['build', '-t', IMAGE, '-f', `${HERE}/Dockerfile`]
if (NO_CACHE) args.push('--no-cache')
args.push(HERE)

const build = spawnSync('docker', args, { stdio: 'inherit' })
if (build.status !== 0) {
  console.error(`[build-image] build failed (exit ${build.status}).`)
  process.exit(build.status || 1)
}

console.log(`[build-image] ✅ built ${IMAGE}`)
process.exit(0)
