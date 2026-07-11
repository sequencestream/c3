// 产物校验和(release 3/7)—— 生成 SHA256SUMS + 每产物 .sha256。
//
// 给定已构建的产物(默认从 dist/manifest.json 读取),生成分发完整性校验的附属文件:
//   <artifact>.sha256          一行 `<hex>  <name>`(与 shasum -a 256 -c 兼容)
//   SHA256SUMS                 所有产物的汇总
//
// 分发经公开 GitHub Release,完整性由 sha256 校验和 + GitHub HTTPS 提供。
//
// 纯 Node。CLI: node scripts/release/checksum.mjs [--manifest=dist/manifest.json] [--dry-run]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256File } from './manifest.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/**
 * 生成每产物 `.sha256` + 汇总 `SHA256SUMS`。
 * 注:调用点仍可传 `version`,但当前仅生成 sha256、不使用版本号,故忽略。
 * @param {object} o
 * @param {Array<{ name: string, path: string }>} o.artifacts  path = absolute
 * @param {string} o.outDir                                    SHA256SUMS 落地目录
 * @param {(m: string) => void} [o.log]
 * @returns {{ sha256sums: string, written: string[] }}
 */
export function checksumArtifacts({ artifacts, outDir, log = () => {} }) {
  const written = []
  const sumsLines = []

  for (const a of artifacts) {
    const hex = sha256File(a.path)
    const line = `${hex}  ${a.name}`
    sumsLines.push(line)
    const sha256Path = `${a.path}.sha256`
    writeFileSync(sha256Path, line + '\n')
    written.push(sha256Path)
    log(`  sha256  ${a.name}  ${hex}`)
  }

  const sha256sums = sumsLines.join('\n') + '\n'
  const sumsPath = resolve(outDir, 'SHA256SUMS')
  writeFileSync(sumsPath, sha256sums)
  written.push(sumsPath)

  return { sha256sums, written }
}

/** 读取 dist/manifest.json → 产物列表(name + dist 绝对路径)。 */
export function artifactsFromManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  const distDir = dirname(manifestPath)
  return {
    version: manifest.version,
    artifacts: manifest.artifacts.map((a) => ({
      name: a.file,
      path: resolve(distDir, basename(a.file)),
    })),
  }
}

// --- CLI ---
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
  const manifestPath = resolve(repoRoot, args.manifest || 'dist/manifest.json')
  if (!existsSync(manifestPath)) {
    console.error(
      `[checksum] manifest not found: ${manifestPath} — run \`pnpm release:build\` first.`,
    )
    process.exit(1)
  }
  const { version, artifacts } = artifactsFromManifest(manifestPath)
  console.log(`[checksum] version v${version} — ${artifacts.length} artifact(s)`)
  if (args['dry-run']) {
    console.log('[checksum] --dry-run: would write .sha256 + SHA256SUMS')
    for (const a of artifacts) console.log(`  ${a.name}`)
    process.exit(0)
  }
  const res = checksumArtifacts({
    artifacts,
    outDir: dirname(manifestPath),
    version,
    log: (m) => console.log(m),
  })
  console.log(`[checksum] hashed — ${res.written.length} file(s) written.`)
}
