# 0044 — 外部 MCP:归属账号求交的权限内核 + 无凭据统一端点

- **Status:** accepted
- **Date:** 2026-08-14

## Context

外部 MCP 此前把「谁」「哪里」「什么」三件事全部压进一把 key:key 是 URL 路径段、绑定单一工作区、
携带一份工具勾选。这套设计有两处结构性缺陷,且它们必须一起解决。

**权限侧没有账号维度。** 一把 key 的作用域只由它自己声明,系统里没有「这把 key 归谁」「这个人能碰
哪些工作区」这层管理员配置。key 泄漏或误配置时,攻击面无法从账号侧收紧;工作区注册表也是无条件全量
可见的,控制台列的是原始注册表而不是某个人被授权看到的子集。更糟的是没有「无记录即拒绝」的规则,
任何一处漏配都读作放行。

**传输侧把凭据编进了 URL。** `/mcp/<api-key>` 违反 MCP 授权规范「令牌不得出现在 URL」的 MUST 要求,
而且 URL 会进代理访问日志、shell 历史与工单正文。key 硬绑单一工作区还意味着换工作区就要换 key。

两者是同一次改造的两半:没有可信的求交内核,统一端点的鉴权无从谈起;不改传输层,权限地基也作用不到
外部调用上。分两次交付会留下「内核已建、端点还是旧的」或「端点已切、判断没跟上」的中间态。

## Options considered

- **A. 复用 `personalized_configs` 存工作区范围** —— 被否决。判断标准正好相反:那张表是用户自管的
  偏好,本模型是管理员管、被约束者只读的授权。共用一张表就把「可以自己改」和「绝不能自己改」压在
  同一条写路径上。
- **B. 单列 `workspaces` 名单表达范围** —— 被否决。它无法区分「选定了但一个都没选」与「压根没配」。
  两者都拒绝,但只有前者是管理员打出来的状态,后者是待配置。
- **C. 给管理员也写一条 `all` 范围行** —— 被否决。管理员因此能编辑掉自己的恢复权限,把部署锁死。
- **D. 保留 `/mcp/<key>` 并新增 `POST /mcp` 双跑** —— 被否决。两个活地址服务同一个面,正是本次要
  消除的漂移;旧地址还会继续把凭据写进日志。
- **E. 用 query 参数或工具入参选工作区** —— 被否决。query 会进日志;工具入参把作用域交给调用方,
  等于取消求交。
- **F. per-owner 而非全局的 policy epoch** —— 被否决。它要求每个变更点自行判断「动了谁的权限」,
  分类错一次就是一个保留了旧权限的会话。
- **G. 统一内部六条 `/internal/*-mcp/v1`** —— 被否决,见「刻意排除」。

## Decision

### 三层求交是唯一卡口

`authorizeCall(auth, workspaceName, toolName)` 是外部 MCP 的**唯一**调用卡口,返回一个冻结的
`EffectiveScope`:

```
effectiveWorkspaces = key 自身工作区范围 ∩ owner 管理员配置范围
effectiveTools      = key.tools ∩ 可外部授权工具目录
```

本版 key 自身范围恒为「全部已注册工作区」,故 owner 配置是限制集;这个形状为将来的 per-key 收窄留了
位置,而不必移动卡口。`tools/list` 与调用检查用同一次求解,发现面与执行面因此不可能不一致。

**默认拒绝是结构性的**:缺行、无法解释的 mode、注册表已无的工作区名、账号名册不认识的 owner —— 每
一种都产出空集,代码里没有任何一条把「缺失」读成 `all` 的分支。

### 范围存储

`user_workspace_scopes`(subject 主键,`mode ∈ {all, selected}`)+ `user_workspace_scope_items`
(明细行)。拆两张表是为了让 `selected` 且零明细成为可表达的状态。写入整体替换,与 epoch 同事务。

**两个 subject 不进表,是 resolver 里的显式分支**:已配置的管理员恒为 `all`(否则他能锁死自己),
以及无认证部署合成的 `local` 主体。`local` 只在没有管理员关卡时有效 —— 一旦配置了 basic 认证,
owner 为 `local` 的 key 立即失效,绝不静默改派给真实账号。

### key 是归属化的能力

`mcp_api_keys` 保持 ADR-0042 的 EAV 形状,**不加列**:`ownerSubject` 与 `secretVersion` 是两个新的
`config_key` 行,经 `MCP_KEY_RULES` 编解码。两者都是可用记录的 NOT NULL 不变量。历史 key 拿不到可信
归属,启动时**一律吊销**:不代管理员指派归属、不保留旧的单工作区绑定、不升级明文。

记录仍保留 `workspaceName`,但它只回答「哪个工作区设置页管理这把 key」,**不授予任何访问权**。页面
上下文不能给出该页面对应工作区的权限。

### policy epoch 是全局单值

`system_configs` 的 `auth.policyEpoch`,单调递增。工作区 ACL 写入、账号名册/管理员变更、工作区注册表
变更(它们会改变某人的有效 `all` 集)、以及每 key 工具授权变更,都在**同一事务内**改数据并 bump。
显示名与最后使用时间不 bump。

全局而非按 owner:它会在一次无关的策略编辑后断开无关客户端,代价是一次重连;换来的是一条可审计的
新鲜度边界,不必让每个未来的变更点自行分类 —— 分类错一次的代价是保留了本该失效的权限。

### 传输层

- **地址**:裸 `POST /mcp`。`/mcp/<任何东西>`(含旧 key 路径与 `/mcp/v1`)一律 404,不是兼容路由。
- **凭据**:唯一来源 `Authorization: Bearer c3k_…`。query、`X-API-Key`、任何其它自定义凭据头都**不被
  解析**。缺失/格式错/未知/已吊销/owner 失效一律同一个 401,正文相同。凭据校验先于工作区解析,
  未认证方无法探测工作区名。
- **工作区**:`X-C3-Workspace` 在 initialize 时固定。空/重复(逗号合并)/超长 400;未知与越权同一个
  403。后续请求重复同一个值是正常的(客户端静态头会带在每个请求上);**不同**的值是 re-scope 尝试,
  403 且不动会话 —— 变的是请求,不是它的权限。

  该头是 **c3 自定义 HTTP 头,不是 MCP 协议字段**:Streamable HTTP 规定的是 `Mcp-Session-Id` 一类
  协议级头与基于 OAuth 的 `Authorization` 扩展,租户选择属应用层。代价明说:不支持配置任意头的客户端
  用不了本端点,且**不做任何 query/path/body/工具入参兜底**。

- **会话钉定**:`(keyId, secretVersion, workspaceName, policyEpoch)` 四元组,每个请求重新认证后比对。
  keyId 不符与未知会话同答 404(不泄露归属,也不让一把 key 毁掉另一把的 transport);secretVersion 或
  policyEpoch 变化则**先清场再 404**,让客户端重新 initialize。顺序恒为:先持久化(含 epoch)提交,
  再清连接;清理失败由逐请求的四元组比对兜底。
- **trusted-local**:`auth.provider.kind='none'`(无管理员关卡)且回环 peer 时,无需 key,合成
  keyId/owner `local`、secretVersion `0`、全部工作区与全部工具。**已出示的凭据必须校验通过** —— 一个
  打错的 bearer 绝不降级为全权。
- **暴露未配置**:绑定非回环地址且无管理员时,`/mcp` 整面返回 503 + 引导文案,回环请求也一样,不建立
  任何会话。答案不取决于调用方从哪个网卡进来。

### id 归属不变量

本次不实现调用时的 id 归属校验,但确立不变量:**任何基于 id 的操作,必须在执行前解析出该资源真实的
工作区**,不得以会话选定的工作区代替。执行由依赖意图 `f1249134-7834-4b88-916d-8700bd11e9cc` 交付。

### 刻意排除:内部六条路由

`/internal/*-mcp/v1` 保持 loopback + per-run token,不使用 bearer key、owner 范围、`X-C3-Workspace`
或本统一传输。它们的作用域来自 c3 自己创建的 run 闭包,比账号求交**更严格**;把它们并进来只会用一个
更宽的模型替换一个更窄的。

## Consequences

- 没有双跑窗口:旧 URL 直接 404,`/mcp/v1` 不再返回 410,存量无 owner 的 key 被吊销,客户端必须重配。
- 一把 key 可跨其 owner 被授权的多个工作区,按会话选择;换工作区不再换 key。
- 一次 ACL 或工具授权编辑会断开全部外部会话。客户端重新 initialize 即可。
- 不强制 HTTPS:明文 bearer 在无 TLS 的网络上可被同网段嗅探。远程部署仍需自管 HTTPS 反代并抑制日志中
  的敏感头。c3 从不记录 `Authorization` 的值。
- claude.ai 自定义连接器要求服务端提供 OAuth 流程,c3 不提供,故本静态 key 端点不支持它。
- 本 ADR 不含自助管理 UI 与管理员「用户与访问」界面(依赖意图
  `4f9f31f0-b2da-42f8-9768-c036b269a6bd`),也不含调用审计、写操作二次确认、限流与 OAuth。
- **控制台侧只做可见性过滤,不做逐消息强制。** 工作区列表按主体求解后,一个已认证连接仍可对未列出的
  `workspaceName` 发起工作区内的 WebSocket 消息 —— 这与引入范围之前的行为一致,不是本次造成的回归,但
  也不能把过滤后的列表当作访问控制边界来读。外部 MCP 侧由 `authorizeCall` 逐调用把关,WebSocket 侧的
  逐消息强制留待后续意图。

## Compliance

- 违反本 ADR 的信号:出现第二个能授权外部 MCP 调用的判断点;任何把缺失策略读作 `all` 的分支;从 query
  /path/body/自定义头解析凭据;为管理员或 `local` 写入范围行;策略写入与 epoch bump 不同事务;先清连接
  后持久化;内部六条路由丢掉 loopback guard 或 per-run token。
- 范围模型见 [auth](../../domains/core/auth/auth-overview.md),请求与授权链见
  [external-mcp](../../domains/core/external-mcp/external-mcp-spec.md)。

## References

- [ADR-0023](0023-auth-abstraction-network-exposure.md) —— 认证抽象与网络暴露前提。
- [ADR-0042](0042-configuration-in-database.md) —— 配置入库的 EAV 形状,本次新增字段沿用它。
- [ADR-0009](0009-unidirectional-boundaries.md) —— kernel ↛ features 的单向边界,epoch 因此落在
  kernel 侧,范围 resolver 落在 auth 域。
