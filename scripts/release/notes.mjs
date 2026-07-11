// release:notes (release 3/7) — assemble GitHub Release notes from the version + CHANGELOG.
//
// The release version is the git-tag SoT (version-info.mjs). The body is the TOP section of
// CHANGELOG.md (everything from the first `## ` heading to the next `## `), so the changelog
// is the single source for human-facing notes. Missing/empty CHANGELOG → a minimal stub + warn.
//
//   node scripts/release/notes.mjs [--out=dist/RELEASE_NOTES.md]   (prints to stdout otherwise)
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeVersionInfo } from './version-info.mjs'
import { normalizeVersion } from './artifact-name.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/** Extract the top `## …` section of a changelog (heading + body up to the next `## `). */
export function topChangelogSection(changelog) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => /^##\s/.test(l))
  if (start === -1) return null
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end === -1) end = lines.length
  return lines.slice(start, end).join('\n').trim()
}

/**
 * Build release notes text for the current version.
 * @returns {{ version: string, tag: string, notes: string }}
 */
export function buildNotes({ changelogPath } = {}) {
  const { version } = computeVersionInfo()
  const v = normalizeVersion(version)
  const tag = `v${v}`
  const cl = changelogPath ?? resolve(repoRoot, 'CHANGELOG.md')
  let section = null
  if (existsSync(cl)) section = topChangelogSection(readFileSync(cl, 'utf-8'))
  const body = section ?? `## ${v}\n\n_No CHANGELOG.md section found._`
  const notes =
    `${body}\n\n---\n\n` +
    'Verify downloads: `shasum -a 256 -c <artifact>.sha256` (or check against `SHA256SUMS`).\n'
  return { version: v, tag, notes }
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
      return m ? [m[1], m[2] ?? true] : [a, true]
    }),
  )
  const { tag, notes } = buildNotes()
  if (args.out) {
    const outPath = resolve(repoRoot, args.out)
    writeFileSync(outPath, notes)
    console.error(`[notes] ${tag} → ${outPath}`)
  } else {
    process.stdout.write(notes)
  }
}
