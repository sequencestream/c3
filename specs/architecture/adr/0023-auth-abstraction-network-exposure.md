# 0023 — 认证抽象边界：网络暴露的强制前提（basic 为首个 provider）

- **Status:** proposed
- **Date:** 2026-06-11
- **Driver:** 为网络暴露做准备，先立可扩展的认证抽象边界，而非把单一认证方式焊死在各层

## Context

宪法 **C-SEC-5** 规定 server 只绑定 localhost，「暴露到网络需要一份 ADR 和一套显式认证设计」。
当前 Web UI 完全没有任何认证——这正是 C-SEC-5 只允许 localhost 的原因：没有认证的服务一旦监听非回环地址，任何能访问该网卡的人都能驱动 agent 执行工具、读写文件、动用宿主 CLI 凭据。认证因此是网络暴露的**强制前提**，而非可选增强。

这是「网络暴露」四件套的**第一件（地基）**，后续三件依赖本件确立的边界：

1. 本件——认证抽象边界 + 契约（无运行时）。
2. 口令哈希/令牌签名等运行时实现 + 认证中间件。
3. 登录页 + 会话生命周期 UI。
4. 设置持久化文件的权限收紧与日志脱敏。

设计这层抽象时面临的核心张力：**只需要 basic 登录，却不能只为 basic 建模。** 若把「用户名 + 口令」直接铺在 `SystemSettings` 顶层、把登录消息写死成 `{username, password}`，则将来加 OAuth/SSO/多用户时，配置层、协议层、校验层、UI 层都要返工——而这恰是 C-SEC-5 注解所要求的「显式认证设计」应当避免的。

约束：

- `shared/src/protocol.ts` 是类型唯一源、**零运行时**（ADR-0009）；任何 zod/哈希/签名实现都不得进入 wire 模块。
- `SystemSettings` 持久化于 `~/.c3/settings.json`，新增字段必须**向后兼容**：缺省即「未启用认证」，旧文件行为完全不变。
- 设置文件将开始承载**口令哈希**（不是明文）——这是被接受的成本，文件权限与脱敏由后续件保证。
- 不在本件实现任何运行时逻辑（中间件、登录页、哈希函数、令牌签名/校验均不在内）。

## Options Considered

### 1. 不立抽象，直接铺 basic 字段

在 `SystemSettings` 顶层加 `authUsername` / `authPasswordHash` / `authEnabled`，登录消息写成 `{type:'login', username, password}`。

_Pro:_ 最少的代码，直达 basic 需求。
_Con:_ 单一认证方式焊死在配置层与协议层——加 OAuth/SSO 时四层返工。
_Con:_ 没有「provider」概念，无法表达「同一套会话令牌模型 + 多种认证后端」。
_Con:_ 与 c3 既有的 vendor-neutral（ADR-0011）、双层配置（ADR-0021）等「先立边界再填实现」的工程范式不一致。

### 2. 完整多用户 + RBAC + 多 provider 一次到位

直接建模用户表、角色、权限、OAuth/SSO/LDAP 多 provider。

_Pro:_ 一步到位，未来不返工。
_Con:_ c3 当前是单机本地工具，没有多租户/组织概念——严重超前设计（与 ADR-0021 否决三层配置同理）。
_Con:_ 巨大的未验证表面积；与「本期只需 basic」的实际需求脱节。
_Con:_ 无数据库（架构约束：no database），多用户持久化无处安放。

### 3. 可扩展抽象 + 单一 basic provider 实现（selected）

按 `kind` 的 discriminated union 建模 `AuthProvider`（首个且唯一 `kind:'basic'`），会话令牌模型与登录/登出/未认证消息**与 provider 无关**（对任何 provider 复用），`AuthConfig` 挂到 `SystemSettings.auth?`。OAuth/SSO 仅在 union 上「留位」——新增一个 `kind` 即扩展，不动既有臂、不动会话令牌模型、不动消息契约。

_Pro:_ 边界与实现解耦——本期只落 basic，将来加 provider 只追加一个 union 臂。
_Pro:_ 会话令牌/登录消息是 provider 无关的中立层，跨 provider 复用（与 ADR-0011 的 vendor 中立同构）。
_Pro:_ `enabled` 主开关 + `auth?` 可选——缺省即未启用，旧配置零行为变化（与 ADR-0021 的 `enabled` 范式一致）。
_Pro:_ 口令以**哈希**（PHC 串）存储、签名密钥以**引用**（env 名/keystore id）而非本体存储——把「设置文件含敏感物」的暴露面降到最小。
_Con:_ 比选项 1 多一层 union/嵌套结构；本期只有一个臂，抽象「暂时空转」——但这正是地基件的目的。

### 4. 单层扁平 AuthConfig（有 enabled 但无 provider union）

`AuthConfig { enabled, username, passwordHash, ttlSeconds, ... }`，扁平、无 `kind`。

_Pro:_ 比选项 3 略简单。
_Con:_ 仍把 basic 的字段（username/passwordHash）焊在顶层；加 OAuth 时这些字段对 OAuth 无意义，要么留空污染、要么再返工拆出 provider——回到选项 1 的问题。

## Decision

**采纳选项 3。** 打破 C-SEC-5 的前提被正式确立为：**认证（`AuthConfig.enabled === true` 且配置完整的 provider）是 server 绑定非回环地址的强制前提。** 本 ADR 即 C-SEC-5 所要求的「ADR + 显式认证设计」——但本期只确立**边界与契约**，运行时实现（含强制校验本身）留待后续件。

### 类型结构（落 `shared/src/protocol.ts`，零运行时）

```typescript
// 认证 provider 种类——扩展点。本期仅 'basic';oauth/sso 后续追加一个 kind。
export const AUTH_PROVIDER_KINDS = ['basic'] as const
export type AuthProviderKind = (typeof AUTH_PROVIDER_KINDS)[number]

// 单管理员 basic provider:用户名 + 口令哈希(PHC 串,永不明文)。
export interface BasicAuthProvider {
  kind: 'basic'
  username: string
  passwordHash: string // PHC 串(算法+参数+盐+摘要),如 $argon2id$...;绝不存明文
}

// provider 抽象——按 kind 的 discriminated union(本期单臂)。
export type AuthProvider = BasicAuthProvider

// 会话令牌策略——TTL + 签名密钥*引用*(env 名/keystore id),密钥本体绝不入设置文件。
export interface AuthSessionPolicy {
  ttlSeconds: number
  signingKeyRef: string
}

// 网络暴露/绑定意向。非回环 bindAddress 要求 enabled 认证(运行时由后续件强制)。
export interface AuthExposureConfig {
  bindAddress?: string // 缺省 127.0.0.1(C-SEC-5);如 0.0.0.0 表网络暴露意向
}

// 认证总配置。挂到 SystemSettings.auth?;缺省/enabled:false ⇒ 未启用(C-SEC-5 默认)。
export interface AuthConfig {
  enabled: boolean
  provider: AuthProvider
  session: AuthSessionPolicy
  exposure?: AuthExposureConfig
}

// 会话令牌模型——provider 无关的中立层。
export interface AuthSessionToken {
  tokenId: string // 不透明 jti
  subject: string // 主体(basic 下即 username)
  issuedAt: number // 签发 Unix ms
  expiresAt: number // 过期 Unix ms(= issuedAt + ttl*1000)
}

// 登录/登出/未认证消息——provider 无关,HTTP 端点与 WS 共用同一契约。
export interface AuthLoginRequest { username: string; password: string } // 明文仅在传输期,校验后即弃
export const AUTH_FAILURE_CODES = ['invalid_credentials', 'auth_disabled', 'rate_limited'] as const
export type AuthFailureCode = (typeof AUTH_FAILURE_CODES)[number]
export type AuthLoginResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; code: AuthFailureCode }

// WS 协议增补
// ClientToServer += { type:'login'; request: AuthLoginRequest } | { type:'logout' }
// ServerToClient += { type:'login_result'; result: AuthLoginResult }
//                += { type:'unauthenticated'; reason:'missing'|'expired'|'invalid' }  // 401 语义

// SystemSettings += { auth?: AuthConfig }  // 缺省=未启用,向后兼容
```

### 不变量

1. **缺省即未启用**：`SystemSettings.auth` 缺失，或 `auth.enabled === false`，或 provider 校验失败 ⇒ 等价于「无认证」（保持 C-SEC-5 localhost-only 默认）。`normalize()` fail-soft：非法 `auth` 被丢弃为 `undefined`，而非抛错。
2. **永不明文**：类型与示例中绝不出现口令明文。`BasicAuthProvider.passwordHash` 是 PHC 串；`AuthLoginRequest.password` 是仅存在于「传输期」的明文，校验后即弃、绝不持久化。
3. **引用而非本体**：`signingKeyRef` 是密钥的**引用**（env 名/keystore id），签名密钥本体绝不进 `settings.json`。
4. **provider 无关的中立层**：`AuthSessionToken`、`AuthLoginRequest/Result`、login/logout/unauthenticated 消息都不含 provider 专有字段，新增 provider 不改动它们。
5. **扩展点单点**：新增认证方式 = 给 `AUTH_PROVIDER_KINDS` 加一个值 + 给 `AuthProvider` union 追加一个臂 + 给服务端 zod registry 追加一个臂；既有臂、会话令牌模型、消息契约均不动（与 ADR-0011 vendor 扩展、ADR-0021 双层配置同构）。

### 运行时校验位置

遵循 ADR-0009/ADR-0011 的分工：**类型**在 `shared/src/protocol.ts`（零运行时），**zod 运行时 schema**在 `server/src/kernel/config/auth-schema.ts`，底部 `_AssertExtends` 双向类型钉死防止 schema 与 wire 类型漂移（复刻 `agent-config/schema.ts` 体例）。`normalize()`（`server/src/kernel/config/index.ts`）在加载时校验 `auth`，非法 ⇒ 省略（fail-soft）。

## Consequences

### 正面

- **边界先于实现**：本期零运行时即固定跨层契约；后续三件在稳定边界上填实现，不返工。
- **可扩展**：OAuth/SSO/多用户加一个 union 臂即可，会话令牌与消息契约不动。
- **向后兼容**：旧 `settings.json` 无 `auth` 字段 ⇒ 行为完全不变（未启用 = 当前 localhost-only 现状）。
- **暴露面最小化**：口令存哈希、密钥存引用——设置文件即便泄露也不含明文口令或签名密钥本体。

### 负面 / 接受的成本

- 设置持久化文件从本件起**承载口令哈希**。哈希不可逆，但仍是敏感物——文件权限收紧（如 `chmod 600`）与日志脱敏**不在本件**，由后续件（第 4 件）保证。本 ADR 显式记录该未了责任。
- 抽象本期「空转」：只有一个 `basic` 臂，多出的 union/嵌套层在加入第二个 provider 前不产生直接收益——这是地基件的固有代价（与 ADR-0021 双层配置在单项目时的空转同理）。
- **C-SEC-5 尚未真正解除**：本件只立前提与契约，**没有**实现强制校验、也没有改变 server 的实际绑定地址。在后续件落地「enabled 认证 ⇒ 才允许非回环绑定」的运行时强制之前，server 仍应保持 localhost-only。constitution C-SEC-5 据此加注解（指向本 ADR），但条款本身在运行时强制到位前不放宽。

## Compliance

- `auth-schema.ts` 的 zod schema 必须有底部双向类型钉死（`z.infer<schema>` ↔ `AuthConfig`），任一方向失败即编译错误。
- `normalize()` 对以下输入必须产出「未启用」：`auth` 缺失、`enabled:false`、provider 校验失败、未知 `kind`。旧 settings.json（无 `auth`）round-trip 后行为不变。
- `auth-schema.test.ts` 必须覆盖：合法 basic 配置解析通过、缺省 ⇒ undefined、非法（未知 kind / 缺字段 / 明文位置）⇒ 拒绝。
- `protocol.test.ts` 必须含 login/logout/login_result/unauthenticated 消息的 JSON round-trip。
- 类型与测试中**绝不**出现真实口令明文常量（测试用占位 `'pw'` 仅作传输期入参，不作持久化值）。
- `pnpm typecheck` 必须通过。

## References

- [constitution C-SEC-5](../../constitution.md) — 本 ADR 注解的条款
- [auth domain spec](../../domains/core/auth/auth-overview.md) — 业务规则 AUTH-R*
- [protocol.ts](../../../shared/src/protocol.ts) — `AuthConfig` / `AuthProvider` / 会话令牌 / 认证消息类型
- [auth-schema.ts](../../../server/src/kernel/config/auth-schema.ts) — zod schema + 类型钉死
- [ADR-0009](0009-unidirectional-boundaries.md) — 类型在 shared、运行时在 server 的分层
- [ADR-0011](0011-vendor-neutral-agent-abstraction.md) — 同构的「中立抽象 + 按 kind/vendor 扩展」范式
- [ADR-0021](0021-system-project-two-tier-sandbox-config.md) — 同构的 `enabled` 开关 + 缺省即禁用 + 拒绝超前设计
