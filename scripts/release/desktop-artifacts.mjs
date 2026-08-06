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

/**
 * Linux 上 AppImage 打包必需的环境 —— 打包器调用的 linuxdeploy 是个外部工具,
 * 两个默认行为都会让 c3 的构建失败:
 *
 * - `NO_STRIP` —— linuxdeploy 默认对 AppDir 里的每个 ELF 执行 `strip`。c3 的
 *   sidecar 是 `bun --compile` 产出的单文件二进制,可执行文件尾部附着 JS 字节码
 *   与资源;strip 会改写节区并破坏(或直接拒绝处理)这种布局。deb 不做 strip,
 *   所以症状是同一次构建里 deb 成功、appimage 失败。
 * - `APPIMAGE_EXTRACT_AND_RUN` —— linuxdeploy 及其插件自身就是 AppImage,默认要
 *   靠 FUSE 自挂载。Ubuntu 24.04 起既不预装 libfuse2,又用 AppArmor 限制了非特权
 *   user namespace,自挂载起不来。改成解包后执行就绕开了整条挂载路径。
 */
export const LINUX_BUNDLE_ENV = {
  NO_STRIP: 'true',
  APPIMAGE_EXTRACT_AND_RUN: '1',
}

/** 该目标打包时要额外注入的环境;非 Linux 目标为空。 */
export function linuxBundleEnv(target) {
  return target.startsWith('linux') ? { ...LINUX_BUNDLE_ENV } : {}
}

/**
 * `tauri build` 的附加 flag。
 *
 * Linux 上强制 `--verbose`:打包器把 linuxdeploy 的 stdout/stderr 捕获在内部,非
 * verbose 模式下丢弃,失败时只剩一句 `failed to run linuxdeploy` —— 没有任何可
 * 诊断的信息。这条链路依赖外部工具且最易失败,日志量的代价值得。
 */
export function tauriBuildFlags(target) {
  return target.startsWith('linux') ? ['--verbose'] : []
}

/**
 * 每个目标在 manifest 里标记为 `preferred` 的安装器 kind —— 桌面更新器在同一个
 * 平台出现多个安装器候选时的**唯一**挑选依据,绝不猜测。
 *
 * 选择理由:macOS 用 dmg(免挂载、可校验公证),Windows 用 nsis(免提权的 per-user
 * 安装,msi 需要管理员),Linux 用 AppImage(当前用户可在原安装位置原子替换,无需
 * root;deb 仍供首次安装)。更新器只认 manifest 里的 `preferred: true` 标记,这里
 * 定义的就是发布侧写入该标记的约定。
 */
export const DESKTOP_PREFERRED_KIND = {
  'macos-arm64': 'dmg',
  'windows-x64': 'nsis',
  'linux-x64': 'appimage',
}

/** 该目标的自更新首选安装器 kind;未知目标返回 null(由调用方拒绝,不猜测)。 */
export function preferredKindFor(target) {
  return DESKTOP_PREFERRED_KIND[target] ?? null
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

/**
 * ad-hoc 签名身份。`codesign -s -` 里的这个连字符是「无身份」的特殊取值:照样封装
 * 完整性哈希(改一个字节签名即失效),但不带任何证书,因此不需要 Apple 账号。
 *
 * arm64 上未签名的 Mach-O 内核直接拒绝执行,所以 ad-hoc 不是可选项而是最低门槛。
 */
export const AD_HOC_SIGNING_IDENTITY = '-'

/**
 * macOS 签名档位 —— 由**凭证是否真的可用**决定,不由构建意图决定。
 *
 * 关键在于「可用」必须按非空判定,而不是按变量是否存在判定:GitHub Actions 在
 * secret 未配置时会把 `${{ secrets.X }}` 渲染成**空字符串但保留该环境变量**,
 * 而 Tauri 打包器只看变量存不存在,于是拿着空 base64 去 `security import`,报
 * `SecKeychainItemImport: One or more parameters passed to a function were not valid`
 * 后整个打包失败。空值必须在交给 Tauri 之前就被当作「没有凭证」剔除。
 *
 * - `developer-id` —— 证书 + 密码齐备,走 Apple 正式签名(可继续公证)。
 * - `ad-hoc`       —— 没有可用证书,退到自签。产物能跑,但用户需要清除隔离标记。
 */
export function macSigningMode(env = process.env) {
  const present = (key) => typeof env[key] === 'string' && env[key].trim() !== ''
  return present('APPLE_CERTIFICATE') && present('APPLE_CERTIFICATE_PASSWORD')
    ? 'developer-id'
    : 'ad-hoc'
}

/**
 * Tauri 打包器会读取的 Apple 凭证变量。ad-hoc 档位下这些变量必须从子进程环境里
 * **删除**(而不是置空)—— 见 `macSigningMode` 里空字符串的那个坑。
 */
export const APPLE_CREDENTIAL_ENV_KEYS = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY_PATH',
]

/**
 * 交给 `tauri build` 的 Apple 相关环境覆盖。
 *
 * `undefined` 表示「从子进程环境里删掉这个变量」,由 `run()` 落实。ad-hoc 档位下
 * 一并清掉公证凭证:半套凭证会让 Tauri 走进公证分支再失败,不如干净地不去。
 */
export function appleEnvOverride(mode) {
  if (mode === 'developer-id') return {}
  return Object.fromEntries(APPLE_CREDENTIAL_ENV_KEYS.map((k) => [k, undefined]))
}

/**
 * `tauri build --config` 的覆盖内容。
 *
 * ad-hoc 签名走 `bundle.macOS.signingIdentity` 而不是 `APPLE_SIGNING_IDENTITY`
 * 环境变量,也不在事后自己补签:Tauri 必须在**打 dmg 之前**签完 `.app`,否则
 * dmg 里封的仍是未签名的那一份 —— 事后对 `bundle/macos/c3.app` 补签改不到已经
 * 生成的镜像。让打包器自己按正确顺序签是唯一不会漏的做法。
 */
export function tauriConfigOverride({ version, target, signingMode }) {
  const config = { version }
  if (target.startsWith('macos') && signingMode === 'ad-hoc') {
    config.bundle = { macOS: { signingIdentity: AD_HOC_SIGNING_IDENTITY } }
  }
  return config
}
