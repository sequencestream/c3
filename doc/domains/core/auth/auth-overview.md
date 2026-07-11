# Domain: auth

c3 的认证。在连接被允许驱动智能体之前,先确立它**是谁**——这是把服务端暴露到
localhost 之外的强制前提条件(constitution C-SEC-5, ADR-0023)。

> **状态:部分运行时(2026-06-16)。** 边界 + 契约(配置形状、线消息)之外,
> 又加入了一个为 System Settings
> auth 面板供电的 **`basic` 提供方运行时**:真实的密码哈希(scrypt PHC)、真实的 `login` 凭据校验、以及
> **多账户且恰好一个管理员**(添加/改密/移除账户 + 指定
> 唯一管理员),再加上 `oauth` 的 `adminEmail`(仅契约)。第一片**请求级授权**
> 也已落地:**只有管理员可以更改系统配置**(AUTH-R10)——对
> `basic` 强制执行,对尚未启用的 `oauth` 运行时编码但处于惰性状态。**仍未完成的:** 令牌签发/校验、
> 通用认证中间件 + "启用认证 ⇒ 可绑定非本地地址" 的强制执行(所以
> 服务端的绑定地址**保持不变**——仍然只限本地),完整的会话生命周期 UI,以及
> 设置文件加固。各剩余任务分别填补什么见 _Roadmap_。

## Why

Web UI 今天没有任何认证;这正是 C-SEC-5 把服务端钉在
loopback 上的原因。为网络暴露做准备,认证必须先行。与其把单一
认证方式(`basic`)硬焊进每一层——配置、协议、校验、UI——不如先铺好抽象层,
使未来的 OAuth/SSO/多用户提供方成为增量变更,而非重写(与 ADR-0011 的厂商模型
同样的“中立抽象 + 按种类扩展”准则)。

## Model

所有认证类型都是共享线/配置契约的一部分(零运行时,ADR-0009);服务端的
运行时 schema 双向校验并与该契约保持类型钉定一致。

- **AuthConfig** —— `{ enabled, provider, session, exposure? }`。挂在 `SystemSettings.auth?` 下。
  缺省该块或 `enabled: false` ⇒ 无认证。
- **AuthProvider** —— 一个以 `kind` 为判别字段的联合类型,是 OAuth/SSO/多用户的唯一扩展点。
  - `kind: 'none'`(**NoneAuthProvider** `{}`)——无认证,C-SEC-5
    仅限本地默认值(登录已禁用)的一等公民表达。不携带任何配置。不变式:`kind:'none' ⇔
enabled:false`,在规范化阶段强制执行(过期的 `enabled:true` 会被重新钉回 `false`),因此
    下拉框的"无认证"选项与总开关永远不会互相矛盾(UI 读取的是 provider kind,而不是第二个标志位)。
  - `kind: 'basic'`(**BasicAuthProvider** `{ accounts: { username, passwordHash }[], adminUsername }`)——
    **多账户,恰好一个管理员**,运行时生效。每个账户都可以登录(管理员是系统配置变更的
    权威,而非登录特权——无 RBAC);`adminUsername` 引用一个
    账户(`accounts` 为空时为 `''` = 未配置状态)。用户名会被去除首尾空白,且区分大小写唯一。账户凭据仅由专用消息
    (`set_admin_password` upsert / `remove_account` / `set_admin_account`)修改,绝不通过 `save_settings`。
  - `kind: 'oauth'`(**OAuthAuthProvider** `{ issuer, clientId, clientSecretRef, redirectUri, scopes, usePkce, allowedEmails, adminEmail }`)
    —— 通用 OIDC,**仅契约**:配置会持久化,但目前没有 OAuth 运行时(回调
    endpoint、发现(discovery)、PKCE/state、令牌交换、JWKS 校验、会话铸造全部
    延后),因此启用认证目前只对 `basic` 生效。`issuer` 是 OIDC 发现的基础 URL;
    `clientSecretRef` 是对客户端密钥的一个 _引用_(环境变量名 / keystore id),绝非
    明文(与 `signingKeyRef` 同一准则);`scopes` 默认为 `['openid','profile','email']`;
    `usePkce` 默认为 `true`;`allowedEmails` 是授权白名单(为空 ⇒ 无人
    获得授权——未来的运行时会强制执行这一点)。`adminEmail` 是唯一管理员的邮箱(OAuth
    版的 `adminUsername`)——必须非空且是 `allowedEmails` 的成员(在保存层校验)。
    本阶段的授权仅通过邮箱白名单(无 sub 白名单 / 角色)。
- **AuthSessionPolicy** —— `{ ttlSeconds, signingKeyRef }`。与 provider 无关的会话令牌策略。
  `signingKeyRef` 是一个 _引用_(环境变量名 / keystore id),绝非密钥本身。默认
  `ttlSeconds` 为 **30 天**——足够长,关闭标签页后再回来不会被重新要求登录;
  目前还没有 TTL 编辑 UI。规范化会把持久化的旧版 `3600`(原来的 1 小时
  默认值)一次性迁移到 30 天默认值。会话仍然只存在于进程内(无持久化存储,
  ADR-0006),因此服务端重启会使每个令牌失效,不论 TTL 如何,下次重连都会重新提示登录。
- **AuthExposureConfig** —— `{ bindAddress? }`。网络暴露 / 绑定意图。
- **AuthSessionToken** —— `{ tokenId, subject, issuedAt, expiresAt }`。与 provider 无关的已签发令牌。
- **Wire messages** —— `login` / `logout` / `set_admin_password` / `remove_account` / `set_admin_account`
  (client→server),`login_result` / `admin_password_result` / `account_op_result` / `unauthenticated`
  (server→client)。登录请求/结果的形状会被未来的 HTTP 登录端点与
  WS 通道共同复用。`set_admin_password { username, password, currentPassword? }` **upsert**
  某个账户的密码——用户名是新的则新增账户(第一个成为管理员),已存在则更改
  (`admin_password_result`:`ok` | `{ code: 'not_authenticated' | 'invalid' }`)。
  `remove_account { username }` / `set_admin_account { username }` 管理账户集合 + 管理员指定
  (`account_op_result`:`ok` | `{ code: 'not_found' | 'admin_must_reassign' | 'invalid' }`)。
  `unauthenticated` 是 HTTP 401 的 WS 对应物。

## Business rules

- **AUTH-R1(默认 = 禁用)** —— `SystemSettings.auth` 缺省、`enabled: false`、`none`
  provider,或校验失败的 provider ⇒ "无认证",即 C-SEC-5 的仅限本地默认值。
  规范化会软失败:一个格式错误的 `auth` 块会被丢弃(视为缺省),绝不抛出异常,
  因此一个非法配置永远不会意外把用户锁在外面或破坏启动。`none` provider 是"无认证"的
  显式一等公民形式:规范化会把它的 `enabled` 钉为 `false`,使 provider kind 成为唯一真源
  (没有第二个标志位与之矛盾)。
- **AUTH-R2(向后兼容)** —— 一个没有 `auth` 字段的既有 `settings.json` 经过
  load → normalize → save 会保持相同行为(无认证)。新增本 domain 不改变
  任何既有配置的语义。
- **AUTH-R3(绝不明文)** —— 密码只以哈希形式存储(`BasicAuthProvider.passwordHash`,
  一个 PHC 字符串)。明文的 `AuthLoginRequest.password` 只在传输中存在——
  与哈希比对校验,绝不持久化。没有任何类型、示例或测试携带真实明文密码作为存储值。
- **AUTH-R4(密钥按引用存放)** —— 令牌签名密钥绝不持久化到 `settings.json`;
  `AuthSessionPolicy.signingKeyRef` 引用它(环境变量名 / keystore id)。运行时解析
  真正的密钥(延后)。
- **AUTH-R5(会话/消息与 provider 无关)** —— `AuthSessionToken`、`AuthLoginRequest/Result`、
  以及 login/logout/unauthenticated 消息不携带任何 provider 特有字段。新增一个 provider
  只需添加一个 `AuthProvider` 分支 + 一个服务端 zod 分支;会话模型与线消息不受影响。
- **AUTH-R6(认证 ⇒ 暴露前提条件)** —— 非本地的 `exposure.bindAddress`(例如 `0.0.0.0`)
  表达了将 c3 暴露到网络的意图,这要求 `enabled` 认证。**这条规则的运行时强制执行
  尚未完成**(Roadmap 第 2 步);面板目前只在 UI 中对开关进行把关(必须先配置管理员才能
  启用暴露)——服务端的绑定地址仍然不变。
- **AUTH-R7(basic 账户存储由专用消息独占拥有)** —— `basic` 账户集合
  (用户名、密码哈希、管理员指定)只能由 `set_admin_password` /
  `remove_account` / `set_admin_account` 修改(密码类消息在服务端对明文做哈希,scrypt
  PHC)。一般性的 `save_settings` 绝不触碰它——服务端会把**整个 basic provider**强制
  按磁盘上的值回写,因此一个陈旧/空的客户端草稿无法覆盖、重新指定或清空账户。
  (当磁盘上的 provider 不是 `basic` 时——比如刚从 none/oauth 切换到
  basic 的草稿——保留新鲜的空壳 `{ accounts: [], adminUsername: '' }`;账户随后通过专用消息填充。)
- **AUTH-R8(改密关卡)** —— 更改一个既有账户的密码需要证明该
  账户的当前密码(`currentPassword` 与其存储的哈希比对校验)⇒ 不匹配时返回
  `not_authenticated`。校验故意从简(非空用户名 + 最小长度),依照 ADR 的非目标;
  失败返回 `invalid`。(名册变更还额外受 AUTH-R10 把关——只有管理员可以
  添加/移除账户或重新指定管理员,一旦已配置一个管理员;在引导窗口期——尚无
  管理员——该关卡处于惰性,因此第一个账户得以创建。)
- **AUTH-R9(单管理员引用完整性 + 方式互斥)** —— 同一时刻只有一种认证方式
  处于激活状态(单一 `provider` 联合类型——`basic` 与 `oauth` 永远不能同时启用)。
  在 `basic` 下,当 `accounts` 非空时,`adminUsername` 必须恰好引用一个账户,且
  用户名必须唯一;在 `oauth` 下,`adminEmail` 必须非空且是 `allowedEmails` 的成员。
  两层强制执行这一点:**保存层**用一个结构化代码拒绝 UI 触发的违规
  (`account_op_result` / `auth.oauthAdminInvalid`);规范化是针对手工编辑
  `settings.json` 的**软失败兜底**——一个悬空/重复管理员的 `basic` 块会被丢弃(无认证),
  而一个 `adminEmail` 非法的 `oauth` 块会被保留(它没有任何运行时效果——
  `oauth.enabled` 始终为 false——丢弃它只会无谓地清空配置的其余部分)。
  `basic.enabled` 是派生的:true ⇔ `accounts` 非空 且 `adminUsername` 引用一个账户。
  当其他账户还存在时,移除管理员账户会被拒绝(`admin_must_reassign`);当它是唯一账户时
  移除它会把存储清空回未配置状态。旧版单账户
  `{ username, passwordHash }` 配置会一次性迁移到 `{ accounts: [...], adminUsername }`。
- **AUTH-R10(仅管理员可变更系统配置)** —— **只有唯一的管理员可以更改系统
  配置。** 每个会变更配置的处理器(`save_settings`、`set_admin_password`、
  `remove_account`、`set_admin_account`、`save_workspace_setting`、`save_workspace_mcp_config`)在变更前都会
  经过一个与 provider 无关的管理员关卡;非管理员或未认证的连接会被
  `auth.adminOnly` 错误拒绝,且不发生任何变更。**添加/移除工作区同样仅限管理员**
  (`add_workspace` / `remove_workspace`):建立或拆除一个信任根要经过同一个管理员
  关卡,因此非管理员会被 `auth.adminOnly` 拒绝,未认证连接会被
  `unauthenticated` 拒绝;查看、进入、编辑工作区仍向任何已认证用户开放(该
  关卡只收窄注册表变更)。该关卡把连接已认证的**subject**(在握手时 / `login` 时
  绑定)与当前 provider 的管理员(`basic.adminUsername` /
  `oauth.adminEmail`)进行比对。**每当没有管理员可以适用时它就是惰性的——每个本地连接都被信任**:
  认证禁用 / `none` / 未配置的 `basic` 空壳(引导窗口期,AUTH-R2 的 localhost
  信任)。**`basic` 完全强制执行。**`oauth` **延后**(仅契约):由于没有 OAuth 登录
  运行时,没有 subject 可解析,因此该关卡对 `oauth` 保持惰性;`adminEmail` 比对
  分支已经接好线,一旦 OAuth 运行时绑定了 subject,强制执行会自动激活。该关卡**从来不是
  唯一防线**——它与握手/分发认证关卡组合作用(当认证启用时,未认证连接
  无法到达这些处理器)。服务端的强制执行与客户端无关:控制台还会为非管理员
  额外隐藏/禁用相关控件(由 `ready.isAdmin` 驱动),但那只是 UX——绝非权威来源。

## Roadmap(延后到之后的任务)

1. **已完成** —— 抽象边界 + 契约。
2. **部分完成** —— 密码哈希 ✅ + `basic` 登录校验 ✅ + `set_admin_password` ✅ +
   **仅管理员系统配置关卡**(AUTH-R10,`basic`)✅ 已完成;**仍延后:** 令牌
   签发/校验、通用认证中间件(握手之外的每帧令牌检查),
   以及“启用认证 ⇒ 可绑定非本地地址”的强制执行(真正的 C-SEC-5 松绑)。
3. **部分完成** —— System Settings 认证配置面板 ✅(三态 provider 下拉框
   **none/basic/oauth** 作为单一认证开关——没有单独的启用勾选框——
   - 用户名/改密/暴露开关 + `oauth` provider 配置表单 ✅);登录页面
     已上线(件①);**仍延后:** 完整的会话生命周期 UI。
4. 加固设置文件:收紧权限(现在它携带密码哈希)+ 日志脱敏。
5. **OAuth 运行时**(延后)—— `oauth` provider **仅契约**。构建运行时意味着:
   `/auth/callback` endpoint、OIDC 发现拉取、PKCE + `state` 生成/校验、
   授权码 → 令牌交换、JWKS 签名校验、邮箱白名单授权、以及
   会话铸造。库选型(`openid-client` 还是 `arctic`,以及与 `bun build --compile` 的兼容性)
   记录在 ADR-0023 中,尚未锁定。

## Shared context

- **Wire protocol** —— 认证消息(`login`、`logout`、`set_admin_password`、`remove_account`、
  `set_admin_account`、`login_result`、`admin_password_result`、`account_op_result`、`unauthenticated`)
  以及配置/令牌契约类型(AuthConfig、AuthProvider、BasicAuthProvider、account、会话
  令牌、登录请求/结果、admin-password 结果、account-op 结果)是单一共享
  线/配置契约的一部分。
- **Runtime** —— 服务端对密码进行哈希与校验(scrypt PHC),运行 login / logout /
  账户管理处理器,并在每个会变更配置的处理器中执行管理员关卡(AUTH-R10)。
  连接的 `subject` 在 WebSocket 握手时和 `login` 时绑定,`ready.isAdmin`
  标志把 UX 提示传给控制台。Basic provider 的保留、OAuth 保存校验、
  派生的 `basic.enabled`、旧版单账户迁移,以及跨字段不变式全都位于
  服务端的配置校验层中。
- **Config panel** —— System Settings 页面承载认证区域,并路由
  账户管理消息及其结果。
- 持久化在 `~/.c3/settings.json` 内的 `SystemSettings.auth` 下,通过与其余
  系统配置相同的单一并发安全写路径。

## References

- [ADR-0023](../../../architecture/adr/0023-auth-abstraction-network-exposure.md) —— 该决策 +
  完整的类型结构与不变式。
- [constitution C-SEC-5](../../../constitution.md) —— 本 domain 所对应的前提条件条款。
- [glossary](../../../glossary.md) —— Authentication / AuthProvider / AuthConfig / Session token 术语。
