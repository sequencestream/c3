# Domain: auth

c3 的认证。在连接被允许驱动智能体之前,先确立它**是谁**。认证是一项**可选**能力——是否启用认证、
以及是否把 c3 暴露到网络,由使用者决定;暴露到网络时建议启用认证(ADR-0023)。

本域回答两个问题:**你是谁**(认证)与**你能碰哪些工作区**(工作区范围)。前者由 provider 抽象承载,
`none` 与 `basic` 两种实现;后者由管理员配置的账号级范围承载,控制台与外部 MCP 共用同一个求解器。
尚未落地的部分(令牌签发/校验、通用认证中间件、完整会话生命周期 UI、设置文件加固)见 _Roadmap_。

## Why

认证是一项可选能力,面向需要把 c3 暴露到网络、或希望在本机之外限制访问的场景。与其把单一
认证方式(`basic`)硬焊进每一层——配置、协议、校验、UI——不如先铺好抽象层,
使未来的 SSO/多用户提供方成为增量变更,而非重写(与 ADR-0011 的厂商模型
同样的“中立抽象 + 按种类扩展”准则)。

## Model

所有认证类型都是共享线/配置契约的一部分(零运行时,ADR-0009);服务端的
运行时 schema 双向校验并与该契约保持类型钉定一致。

- **AuthConfig** —— `{ enabled, provider, session, exposure? }`。挂在 `SystemSettings.auth?` 下。
  缺省该块或 `enabled: false` ⇒ 无认证。
- **AuthProvider** —— 一个以 `kind` 为判别字段的联合类型,是 SSO/多用户的唯一扩展点。
  - `kind: 'none'`(**NoneAuthProvider** `{}`)——无认证(登录已禁用)的一等公民表达,
    是默认值。不携带任何配置。不变式:`kind:'none' ⇔
enabled:false`,在规范化阶段强制执行(过期的 `enabled:true` 会被重新钉回 `false`),因此
    下拉框的"无认证"选项与总开关永远不会互相矛盾(UI 读取的是 provider kind,而不是第二个标志位)。
  - `kind: 'basic'`(**BasicAuthProvider** `{ accounts: { username, passwordHash }[], adminUsername }`)——
    **多账户,恰好一个管理员**,运行时生效。每个账户都可以登录(管理员是系统配置变更的
    权威,而非登录特权——无 RBAC);`adminUsername` 引用一个
    账户(`accounts` 为空时为 `''` = 未配置状态)。用户名会被去除首尾空白,且区分大小写唯一。账户凭据仅由专用消息
    (`set_admin_password` upsert / `remove_account` / `set_admin_account`)修改,绝不通过 `save_settings`。
- **AuthSessionPolicy** —— `{ ttlSeconds, signingKeyRef }`。与 provider 无关的会话令牌策略。
  `signingKeyRef` 是一个 _引用_(环境变量名 / keystore id),绝非密钥本身。默认
  `ttlSeconds` 为 **30 天**——足够长,关闭标签页后再回来不会被重新要求登录;
  目前还没有 TTL 编辑 UI。规范化会把持久化的旧版 `3600`(原来的 1 小时
  默认值)一次性迁移到 30 天默认值。会话仍然只存在于进程内(无持久化存储,
  ADR-0006),因此服务端重启会使每个令牌失效,不论 TTL 如何,下次重连都会重新提示登录。
- **AuthExposureConfig** —— `{ bindAddress? }`。网络暴露 / 绑定意图。
- **AuthorizationSubject** —— 一次请求实际以谁的身份被授权。已验证的 basic subject 映射为它自己;
  认证缺省 / `enabled:false` / `none` / 尚未配置管理员的 `basic` 空壳,一律映射为合成主体
  **`local`**。控制台与外部 MCP 共用这一个 resolver,所以两条路径对同一个人给出同一个答案。
- **UserWorkspaceScope** —— `{ subject, mode: 'all' | 'selected', workspaces[] }`。管理员配置的账号级
  工作区授权,落在 `user_workspace_scopes` + `user_workspace_scope_items`(见下节)。
- **EffectiveScope** —— 一次外部 MCP 授权的冻结结果:`{ keyId, ownerSubject, secretVersion,
policyEpoch, workspaceName, workspacePath, tools }`。它同时是会话钉定的四元组来源。
- **AuthSessionToken** —— `{ tokenId, subject, issuedAt, expiresAt }`。与 provider 无关的已签发令牌。
- **Wire messages** —— `login` / `logout` / `set_admin_password` / `remove_account` / `set_admin_account`
  (client→server),`login_result` / `admin_password_result` / `account_op_result` / `unauthenticated`
  (server→client)。登录请求/结果的形状会被未来的 HTTP 登录端点与
  WS 通道共同复用。`set_admin_password { username, password, currentPassword? }` **upsert**
  某个账户的密码——用户名是新的则新增账户(第一个成为管理员),已存在则更改
  (`admin_password_result`:`ok` | `{ code: 'not_authenticated' | 'invalid' }`)。
  首个管理员保存成功时,服务器在成功结果后向当前连接发送
  `unauthenticated { reason: 'missing' }`,要求使用新凭据登录；后续账号变更不触发此流程。
  `remove_account { username }` / `set_admin_account { username }` 管理账户集合 + 管理员指定
  (`account_op_result`:`ok` | `{ code: 'not_found' | 'admin_must_reassign' | 'invalid' }`)。
  `unauthenticated` 是 HTTP 401 的 WS 对应物。

## 工作区范围 `user_workspace_scopes`

「这个账号能碰哪些工作区」是**管理员配置的授权状态**,不是用户偏好。它决定三件事:控制台工作区列表
里出现哪些条目,一把外部 MCP key(借它归属账号的权限)能到达哪些工作区,以及 IM 机器人每次 c3 工具
调用时的个人 scope 求解(调用级,不与连接钉定混用)。

- **两张表,不是一列名单。** `user_workspace_scopes` 存 subject 与 `mode`;`user_workspace_scope_items`
  存 `selected` 模式下的明细。拆开是为了让「选定了,但一个都没选」成为可表达的状态 —— 单列名单会把它
  和「压根没配」压成同一个空值,而前者是管理员打出来的决定,后者是待配置。
- **默认拒绝。** 没有策略行 = 一个工作区也到不了。`selected` 且零明细同样是零。缺行、无法解释的
  `mode`、注册表已无的明细名 —— 每一种都产出空集,没有任何分支把缺失读作全部。
- **两个 subject 不进表。** 已配置的管理员恒为 `all`(否则他能编辑掉自己的恢复权限,把部署锁死);
  无认证部署的合成主体 `local` 同样恒为全部。两者都是 resolver 里的显式分支,而不是存储里的行。
- **`all` 跟随注册表,`selected` 不跟随。** 新注册一个工作区会自动进入每个 `all` 范围,但绝不会挤进
  任何 `selected` 名单。因此注册表变更也推进 policy epoch。
- **不复用 `personalized_configs`。** 判断标准正好相反:那张表是用户自管的偏好,本表是管理员管、被
  约束者只读的授权。共用一张表就把「可以自己改」和「绝不能自己改」压在同一条写路径上。
- **写入整体替换**,且与 policy epoch 同事务提交;失败一起回滚,一次没落地的写绝不吊销任何会话。

### policy epoch

`system_configs` 的 `auth.policyEpoch` 是一个单调递增的**全局**值,回答「自这个会话被钉定以来,有没有
任何授权输入变过」。推进它的是:工作区 ACL 写入、账号名册与管理员指定的变更、工作区注册表变更、以及
每 key 的工具授权变更 —— 全部在改数据的同一事务里 bump。显示名与最后使用时间不推进它。

刻意是全局而不是按 owner:按 owner 要求每个变更点自行判断「动了谁的权限」,分类错一次就是一个保留了
旧权限的会话。全局的代价是一次无关编辑会断开无关的外部客户端,它们重新 initialize 即可。

## Business rules

- **AUTH-R1(默认 = 禁用)** —— `SystemSettings.auth` 缺省、`enabled: false`、`none`
  provider,或校验失败的 provider ⇒ "无认证",即默认值。
  规范化会软失败:一个格式错误的 `auth` 块会被丢弃(视为缺省),绝不抛出异常,
  因此一个非法配置永远不会意外把用户锁在外面或破坏启动。`none` provider 是"无认证"的
  显式一等公民形式:规范化会把它的 `enabled` 钉为 `false`,使 provider kind 成为唯一真源
  (没有第二个标志位与之矛盾)。
- **AUTH-R2(向后兼容)** —— 一份没有 `auth` 键的既有配置经过
  load → normalize → save 会保持相同行为(无认证)。新增本 domain 不改变
  任何既有配置的语义。
- **AUTH-R3(绝不明文)** —— 密码只以哈希形式存储(`BasicAuthProvider.passwordHash`,
  一个 PHC 字符串)。明文的 `AuthLoginRequest.password` 只在传输中存在——
  与哈希比对校验,绝不持久化。没有任何类型、示例或测试携带真实明文密码作为存储值。
- **AUTH-R4(密钥按引用存放)** —— 令牌签名密钥绝不落库;
  `AuthSessionPolicy.signingKeyRef` 引用它(环境变量名 / keystore id)。运行时解析
  真正的密钥(延后)。
- **AUTH-R5(会话/消息与 provider 无关)** —— `AuthSessionToken`、`AuthLoginRequest/Result`、
  以及 login/logout/unauthenticated 消息不携带任何 provider 特有字段。新增一个 provider
  只需添加一个 `AuthProvider` 分支 + 一个服务端 zod 分支;会话模型与线消息不受影响。
- **AUTH-R6(暴露时建议启用认证)** —— `exposure.bindAddress` 记录服务端绑定地址;
  是否把 c3 暴露到网络由使用者决定。当配置为非本地地址(例如 `0.0.0.0`)时,面板建议先启用
  认证,并把暴露开关放在「已配置管理员」之后(必须先配置管理员才能在面板里开启暴露)。
  **绑定地址的运行时应用尚未接入设置面板**(Roadmap 第 2 步)。
- **AUTH-R7(basic 账户存储由专用消息独占拥有)** —— `basic` 账户集合
  (用户名、密码哈希、管理员指定)只能由 `set_admin_password` /
  `remove_account` / `set_admin_account` 修改(密码类消息在服务端对明文做哈希,scrypt
  PHC)。一般性的 `save_settings` 绝不触碰它——服务端会把**整个 basic provider**强制
  按磁盘上的值回写,因此一个陈旧/空的客户端草稿无法覆盖、重新指定或清空账户。
  (当磁盘上的 provider 不是 `basic` 时——比如刚从 none 切换到
  basic 的草稿——保留新鲜的空壳 `{ accounts: [], adminUsername: '' }`;账户随后通过专用消息填充。)
- **AUTH-R8(改密关卡)** —— 更改一个既有账户的密码需要证明该
  账户的当前密码(`currentPassword` 与其存储的哈希比对校验)⇒ 不匹配时返回
  `not_authenticated`。校验故意从简(非空用户名 + 最小长度),依照 ADR 的非目标;
  失败返回 `invalid`。(名册变更还额外受 AUTH-R10 把关——只有管理员可以
  添加/移除账户或重新指定管理员,一旦已配置一个管理员;在引导窗口期——尚无
  管理员——该关卡处于惰性,因此第一个账户得以创建。)
- **AUTH-R9(单管理员引用完整性)** —— 单一 `provider` 联合类型意味着同一时刻只有
  一种认证方式处于激活状态。在 `basic` 下,当 `accounts` 非空时,`adminUsername`
  必须恰好引用一个账户,且用户名必须唯一。两层强制执行这一点:**保存层**用一个结构化代码
  拒绝 UI 触发的违规(`account_op_result`);规范化是针对手工编辑
  配置的**软失败兜底**——一个悬空/重复管理员的 `basic` 块会被丢弃(无认证)。
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
  绑定)与当前 provider 的管理员(`basic.adminUsername`)进行比对。**每当没有管理员
  可以适用时它就是惰性的——每个本地连接都被信任**:
  认证禁用 / `none` / 未配置的 `basic` 空壳(引导窗口期,AUTH-R2 的 localhost
  信任)。**`basic` 完全强制执行。**该关卡**从来不是
  唯一防线**——它与握手/分发认证关卡组合作用(当认证启用时,未认证连接
  无法到达这些处理器)。服务端的强制执行与客户端无关:控制台还会为非管理员
  额外隐藏/禁用相关控件(由 `ready.isAdmin` 驱动),但那只是 UX——绝非权威来源。
  **个人化设置不在该关卡范围内**:`get_personalized_settings` /
  `save_personalized_settings` 写的是**按人**偏好而非系统配置,任何已认证账户都可
  改自己那一份。账户键只取连接已验证的 subject(客户端无法指定),故账户之间彼此
  不可见;连接级认证关卡照旧生效。见
  [personalized-setting](../../settings/personalized-setting/personalized-setting-spec.md)。

- **AUTH-R11(工作区可见性按主体求解)** —— 工作区列表不是原始注册表,而是
  `listWorkspacesForSubject(subject)` 的结果:控制台的 `ready.workspaces`、后续的 `workspaces` 刷新、
  外部 MCP 的工作区解析与 IM 机器人调用级 scope 求解共用同一个 resolver,保持注册表顺序、只做过滤。
  管理员与 `local` 看到全部;其余账号看到其存储范围求解出的子集,无范围记录即为空。**名册中已删除的
  subject 恒为空范围**——`remove_account` 不自动清除 `user_workspace_scopes` 行,但 resolver 先校验
  `isValidOwner`,因此遗留 scope 行不能继续授权控制台、外部 MCP 或 IM 绑定发送者。**内部系统任务**
  (调度、清理)仍可读未过滤的注册表,但任何面向用户的界面与外部 MCP / IM 路径都不得把原始注册表当作
  授权判据。控制台的列表是**可见性**过滤,不是逐消息的访问控制 —— 一个已认证连接仍可对未列出的
  `workspaceName` 发起工作区内消息(与引入范围之前一致)。外部 MCP 侧有 `authorizeCall` 逐调用把关;
  IM 侧在每次 L1 工具 handler 内重读 binding 与 scope; WebSocket 侧的逐消息强制留待后续意图。
- **AUTH-R12(外部 MCP 三层求交)** —— 外部调用的权限 = key 自身范围 ∩ owner 的工作区范围 ∩
  (key 工具 ∩ 可外部授权目录)。唯一卡口是 `authorizeCall`,它先判 owner、再判工作区、最后判工具,
  返回冻结的 `EffectiveScope`。`local` 归属的 key 只在没有管理员关卡时有效;一旦配置 basic 认证,它
  立即失效而不被改派给任何真实账号。链路细节见
  [external-mcp](../external-mcp/external-mcp-spec.md#请求与授权链)。

## Roadmap(延后到之后的任务)

1. **已完成** —— 抽象边界 + 契约。
2. **部分完成** —— 密码哈希 ✅ + `basic` 登录校验 ✅ + `set_admin_password` ✅ +
   **仅管理员系统配置关卡**(AUTH-R10,`basic`)✅ 已完成;**仍延后:** 令牌
   签发/校验、通用认证中间件(握手之外的每帧令牌检查),以及把
   `exposure.bindAddress` 接入服务端实际绑定的运行时应用。
3. **部分完成** —— System Settings 认证配置面板 ✅(二态 provider 下拉框
   **none/basic** 作为单一认证开关——没有单独的启用勾选框——
   - 用户名/改密/暴露开关 ✅);登录页面
     已上线(件①);**仍延后:** 完整的会话生命周期 UI。
4. 加固设置文件:收紧权限(现在它携带密码哈希)+ 日志脱敏。

## Shared context

- **Wire protocol** —— 认证消息(`login`、`logout`、`set_admin_password`、`remove_account`、
  `set_admin_account`、`login_result`、`admin_password_result`、`account_op_result`、`unauthenticated`)
  以及配置/令牌契约类型(AuthConfig、AuthProvider、BasicAuthProvider、account、会话
  令牌、登录请求/结果、admin-password 结果、account-op 结果)是单一共享
  线/配置契约的一部分。
- **Runtime** —— 服务端对密码进行哈希与校验(scrypt PHC),运行 login / logout /
  账户管理处理器,并在每个会变更配置的处理器中执行管理员关卡(AUTH-R10)。
  连接的 `subject` 在 WebSocket 握手时和 `login` 时绑定,`ready.isAdmin`
  标志把 UX 提示传给控制台。Basic provider 的保留、
  派生的 `basic.enabled`、旧版单账户迁移,以及跨字段不变式全都位于
  服务端的配置校验层中。授权侧另有主体求解、工作区范围求解与 `authorizeCall`,
  它们是控制台工作区列表、外部 MCP 与 IM 机器人调用级 scope 的**同一个**判断来源;账号删除后 IM
  绑定发送者因 `isValidOwner` 落空而得到空个人 scope,不得继续读取遗留明细。
- **Config panel** —— System Settings 页面承载认证区域,并路由
  账户管理消息及其结果。工作区范围目前没有编辑界面,由后续意图交付。
- 认证配置持久化在 `system_configs` 的 `auth.*` 键空间下(policy epoch 是同一键空间里的
  `auth.policyEpoch`,但不属于 `SystemSettings`,整对象保存会保留它);工作区范围持久化在
  `user_workspace_scopes` 与 `user_workspace_scope_items`。

## References

- [ADR-0023](../../../architecture/adr/0023-auth-abstraction-network-exposure.md) —— 认证抽象决策 +
  完整的类型结构与不变式。
- [ADR-0044](../../../architecture/adr/0044-external-mcp-owner-scope-and-unified-endpoint.md) ——
  工作区范围的默认拒绝语义、policy epoch 与三层求交的边界决策。
- [glossary](../../../glossary.md) —— Authentication / AuthProvider / AuthConfig / Session token 术语。
