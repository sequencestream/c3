// minisign keypair generator (release 3/7).
//
//   node scripts/release/keygen.mjs [--comment="…"] [--out=dist/c3-minisign-secret.key]
//
// Prints the PUBLIC key (paste into server/src/release-pubkey.ts + README) to stdout, and
// writes the SECRET blob (base64 of keyId||seed) to a gitignored file. The secret is the
// distribution trust anchor: move it offline, set it as the `C3_MINISIGN_SECRET_KEY` GH
// Secret, then delete the file. The secret is NEVER printed to stdout.
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeypair } from './minisign.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

function parseArgs(argv) {
  const o = {}
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    if (m) o[m[1]] = m[2]
    else if (a.startsWith('--')) o[a.slice(2)] = true
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
const comment = args.comment || 'c3 release signing key'
const outPath = resolve(repoRoot, args.out || 'dist/c3-minisign-secret.key')

const kp = generateKeypair({ comment })
writeFileSync(outPath, kp.secretKeyB64 + '\n', { mode: 0o600 })

console.log('minisign keypair generated.\n')
console.log('PUBLIC KEY (embed in server/src/release-pubkey.ts + README):')
console.log('-----------------------------------------------------------')
process.stdout.write(kp.publicKeyText)
console.log('-----------------------------------------------------------')
console.log(`key id: ${kp.keyId.toString('hex')}`)
console.log(`\nSECRET written (mode 600) → ${outPath}`)
console.log('  ⚠ Move it offline, set GH Secret C3_MINISIGN_SECRET_KEY, then delete the file.')
console.log('  ⚠ The secret is NOT printed here on purpose.')
