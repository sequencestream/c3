// 桌面渠道的命名与目标映射 —— 纯函数,发布编排(desktop.mjs)与其测试共用同一份知识。
//
// 三层命名互不相同,分开维护是有意的:
//
//   1. **Rust 目标三元组** —— Tauri `externalBin` 要求 sidecar 文件名带上目标三元组
//      后缀(`binaries/c3-aarch64-apple-darwin`)。这是 Tauri 的约定,不是我们的。
//   2. **Tauri 自己产出的 bundle 文件名** —— 形如 `c3_0.9.6_aarch64.dmg`,由 Tauri
//      决定,各平台各不相同,所以我们按扩展名去发现而不是去预测。
//   3. **对外分发名** —— `c3-desktop-v{ver}-{target}.{ext}`。与 CLI 包
//      (`c3-v{ver}-{target}.tar.gz`)刻意不同前缀,消费者一眼能分清 UI 版与 CLI 版。
//
// 纯 Node,无依赖。

import { normalizeVersion } from './artifact-name.mjs'

/** 桌面渠道支持的目标(与 CLI 的 KNOWN_TARGETS 交集,三平台各一)。 */
export const DESKTOP_TARGETS = ['macos-arm64', 'windows-x64', 'linux-x64']

/**
 * 友好目标名 → Rust 目标三元组。Tauri 用它给 sidecar 文件命名,也用它选交叉编译目标。
 * 与 `server/scripts/release/build-target.mjs` 的 TARGETS 一一对应。
 */
export const RUST_TRIPLES = {
  'macos-arm64': 'aarch64-apple-darwin',
  'windows-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
}

/** 目标对应的 Rust 三元组;未知目标抛错(而不是产出一个名字对不上的 sidecar)。 */
export function rustTriple(target) {
  const triple = RUST_TRIPLES[target]
  if (!triple) {
    throw new Error(
      `[desktop] no Rust target triple for '${target}' — known: ${Object.keys(RUST_TRIPLES).join(', ')}`,
    )
  }
  return triple
}

/**
 * sidecar 在 `desktop/src-tauri/binaries/` 下必须使用的文件名。Tauri 按
 * `<externalBin>-<triple>` 查找,名字错一个字符,打包时就报 "resource path doesn't exist"。
 */
export function sidecarStageName(target) {
  const name = `c3-${rustTriple(target)}`
  return target.startsWith('windows') ? `${name}.exe` : name
}

/**
 * 每个目标预期产出的桌面产物。`dir` 是 Tauri bundle 目录下的子目录名,`ext` 是用来
 * 在该目录里发现真实文件的扩展名(Tauri 的文件名含版本与架构,各平台格式不一,
 * 与其预测不如发现)。
 */
export const DESKTOP_BUNDLES = {
  'macos-arm64': [
    { kind: 'dmg', dir: 'dmg', ext: '.dmg' },
    // `.app` 是目录,发布前要打成归档;它是 dmg 里的同一份产物,单独提供是为了
    // 免挂载安装与公证票据校验。
    { kind: 'app', dir: 'macos', ext: '.app', archive: 'tar.gz' },
  ],
  'windows-x64': [
    { kind: 'msi', dir: 'msi', ext: '.msi' },
    { kind: 'nsis', dir: 'nsis', ext: '.exe' },
  ],
  'linux-x64': [
    { kind: 'deb', dir: 'deb', ext: '.deb' },
    { kind: 'appimage', dir: 'appimage', ext: '.AppImage' },
  ],
}

/** 该目标预期的桌面产物列表;未知目标抛错。 */
export function desktopBundles(target) {
  const bundles = DESKTOP_BUNDLES[target]
  if (!bundles) {
    throw new Error(
      `[desktop] no bundle plan for '${target}' — known: ${Object.keys(DESKTOP_BUNDLES).join(', ')}`,
    )
  }
  return bundles
}

/** 传给 `tauri build --bundles` 的取值(Tauri 的 bundle 类型名)。 */
export function tauriBundleFlags(target) {
  // `.app` 由 macOS 的 `app` bundle 类型产出,dmg 依赖它,所以两者都要列上。
  return desktopBundles(target).map((b) => (b.kind === 'nsis' ? 'nsis' : b.kind))
}

/** 对外分发名的扩展名 —— 目录型产物(`.app`)会被打成归档,扩展名随之变化。 */
export function desktopPackageExt(bundle) {
  if (bundle.archive === 'tar.gz') return `${bundle.ext}.tar.gz`
  return bundle.ext
}

/**
 * 对外分发名:`c3-desktop-v{ver}-{target}{ext}`。
 * 与 CLI 的 `c3-v{ver}-{target}.tar.gz` 前缀不同,是消费者区分 UI 版 / CLI 版的依据。
 */
export function desktopPackageName(version, target, bundle) {
  return `c3-desktop-v${normalizeVersion(version)}-${target}${desktopPackageExt(bundle)}`
}

/**
 * Tauri / MSI 要求 bundle 版本是纯 `MAJOR.MINOR.PATCH`,而 c3 的版本 SoT 是
 * `git describe`,在 tag 之后的提交上会长成 `0.9.6-12-gabc1234`。
 *
 * 于是版本分成两路:**完整**版本串继续进 sidecar 与运行时校验(壳与 sidecar 必须
 * 逐字一致),**归一化**后的三段版本只喂给安装包元数据。二者不可互换。
 */
export function bundleVersion(version) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(normalizeVersion(String(version)))
  if (!m) {
    throw new Error(`[desktop] cannot derive a bundle version from '${version}'`)
  }
  return `${m[1]}.${m[2]}.${m[3]}`
}

/** 该目标能否在当前宿主上构建桌面包。Tauri 不做跨平台打包。 */
export function isDesktopHostTarget(target, platform = process.platform, arch = process.arch) {
  const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform
  return target === `${os}-${arch}`
}
