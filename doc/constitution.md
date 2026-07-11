# Constitution — c3

项目的最高层约束。这些约束极少变化,并且优先于任何规格、设计与代码。
对本文档的修改需要维护者的明确签署(见修订流程)。

## 使命与价值观

**使命:** 让人类在浏览器中安全地批准 Claude Code 在本地机器上的敏感工具调用。

**价值观,按优先级排序**(冲突时优先级高者胜出):

1. **决策边界的安全性** — 没有经过授权的决策,任何敏感工具都不得运行。这一条压倒一切。
2. **通信契约的正确性** — 浏览器与服务端在任何时刻都对消息形状达成一致。协议损坏或含糊比缺失某个功能更糟。
3. **本地优先的简洁性** — 单用户、单项目、单进程。优先选择简单的本地设计而非通用性。
4. **开发者体验** — 可读的工具输入、快速的反馈、易于构建。

**冲突裁决规则:** 当两个价值观冲突时,满足优先级更高的一个,并在相应的 ADR 中记录取舍。

## 技术栈基线

**允许的核心技术栈:** TypeScript(strict)、Node.js / Bun 运行时、Hono(HTTP + WS)、
Vue 3 + Vite(前端)、`@anthropic-ai/claude-agent-sdk`、pnpm workspaces、Vitest。

**未经 ADR 禁止使用:** 任何数据库或持久化存储;任何默认绑定到非回环接口的网络监听器;
任何认证/身份提供方;除 Claude Agent SDK 之外的任何第二套智能体运行时。

**License-server 边界:** 上述禁止清单约束的是 **c3 进程**。商业产品的**授权(entitlement)**
归属于一个**独立产品 license-server(LS)**,刻意置于 c3 进程之外——因此 LS 的 PostgreSQL、
GitHub OAuth(身份提供方)、微信支付都存在于**那里**,而不在 c3 中。c3 **内部**唯一的妥协
是一个小型磁盘上**授权缓存**(一个 LS 签名的令牌 + 一个心跳承载令牌),支持 30 分钟离线宽限期;
c3 不保留通用数据库,也不保留第二套智能体运行时。ADR-0026 是必需的例外记录。见
[ADR-0026](architecture/adr/0026-product-licensing-separate-license-server.md)
与 [product-license 领域](domains/commerce/product-license/product-license-overview.md)。

**例外流程:** 引入被禁止的技术需要在 `architecture/adr/` 下新建一个 ADR,列出所考虑的方案,
并由维护者批准。

## 安全基线(不可协商)

- **C-SEC-1** — c3 是其智能体会话的权限**网关**。SDK 会收到 `settingSources: ['user', 'project']`,
  因此继承自 `~/.claude` 与项目 `.claude` 的 hook 及允许/拒绝规则会优先生效;任何未被它们
  预先决定的工具都会流经 `canUseTool` 并送达浏览器。继承的允许规则可能自动批准某个浏览器
  从未见过的工具——这是可接受的,与 `claude` CLI 的行为一致(ADR 0005)。修改 `settingSources`
  需要新建一个 ADR。
- **C-SEC-2** — 被 SDK 归类为敏感的工具,除非有决策授权,否则不得执行:明确的允许(Allow),
  或者一个授权自动执行的活跃权限模式(`acceptEdits`、`bypassPermissions`)。
- **C-SEC-3** — 在没有任何决策的情况下,默认结果是**拒绝**。一个待决请求会无限期阻塞,
  直到用户做出决定(无超时);若运行被中止,则结果视为拒绝。无法解析或未知的客户端消息
  会被忽略,绝不会被当作批准处理。
- **C-SEC-4** — 不硬编码也不记录任何密钥。`claude` CLI 拥有认证权;c3 从不处理 Claude 凭据。
- **C-SEC-5** — 服务端仅绑定 localhost;默认不启用认证。将其暴露到网络需要明确的认证设计。
  认证是任何非回环绑定的**强制前置条件**:认证抽象定义了一个可扩展的 provider 联合类型
  (`basic` 优先实现),但“启用认证 ⇒ 可绑定非回环地址”这条执行规则尚未接通,因此服务端
  仍保持仅限 localhost。放宽这一条款需要先完成该执行规则,再加上一个新的 ADR。见
  [ADR-0023](architecture/adr/0023-auth-abstraction-network-exposure.md) 与
  [auth 领域](domains/core/auth/auth-overview.md)。

## 编码原则

- **处处使用 TypeScript `strict: true`。** 用可辨识联合类型(discriminated union)建模通信
  与状态;基于 `type` 做窄化。禁止用 `as` 来漂白类型。边界处使用 `unknown`;在边缘校验
  WS 输入。
- **类型的唯一真源** — `@ccc/shared`。两端导入同一份协议定义;都不重新定义它们。
- **为导出的函数签名加注解。** 服务端本地 `.ts` 文件的导入说明符保留 `.js` 后缀。
- **构建顺序很重要:** 先构建 web 再构建 server(server 内嵌 web 构建产物)。

## AI 工程原则

- 智能体在用户控制的 `permissionMode` 下运行。用户可以升级到 `bypassPermissions`,
  但只能通过一次明确的、可观察的 UI 操作——绝不能悄悄进行。
- 在运行中途切换到 `bypassPermissions` 是设计上允许的(`allowDangerouslySkipPermissions: true`),
  **前提仅仅是因为 c3 仍然是呈现该选择的 UI。** 这必须始终是一次明确的用户操作。
- 会话是串行的:对一个轮次正在进行中的会话发起新的 prompt 会被拒绝,而不是被合并。
  不同会话并发运行,没有固定上限。运行归属于一个进程级别的会话运行时注册表,而不是归属于
  连接;切换正在查看的会话或关闭 socket 都不会停止运行——只有 `stop_run`、`delete_session`
  或 `remove_workspace` 才会(ADR 0006)。

## 运维原则

- 单一二进制文件必须仅依赖 PATH 上的 `bun` 与已登录的 `claude` 即可运行。
- 找不到 `claude` 可执行文件,或 SDK 出错,都要以 `reason: 'error'` 的 `turn_end` 呈现给用户——
  绝不能默默挂起。

## 文档撰写规范

- 文档在边界高度解释设计——实现方式、流程、逻辑、状态与规则——清晰到足以据此评审和实现。
  避免穷举式地列出与源码重复、且会随之漂移失步的低层级代码细节(完整源码树、逐文件或
  逐符号清单);共享契约只记录一次,并通过编号引用。

## 修订流程

由维护者提出并签署变更。放宽某条 `C-SEC-*` 规则的修订需要在 ADR 中给出书面理由,
并在 `changes/` 下的变更记录中做出说明。违反本文档的行为将被视为阻断发布的缺陷。
