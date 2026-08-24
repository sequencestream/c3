# im-robot — 设计

行为契约见 [im-robot-spec.md](im-robot-spec.md);实体见 [im-robot-models.md](im-robot-models.md)。

## 分层

```
平台长连接  →  provider(平台特定)  →  supervisor(平台中性)  →  回合执行  →  唯一出站守卫  →  provider.rawSend
```

**provider 很薄,是刻意的。** 它只拥有平台特有的部分:持有连接、解码平台帧、投递消息。其余——是否
要求 @提及、按 `(platform, robotId, messageId)` 去重、一个 Conversation 一次一个回合、入站/出站守卫、
截断、审计、数据库上下文恢复——全部在中性层,因此第二个平台继承它们而不是重写一遍。

**出站守卫是结构入口,不是调用约定。** supervisor 只依赖受控发送入口,拿不到可直发的 sender;provider
的原始发送能力只在该入口内部可见。正常最终回答、全部固定控制提示(凭据拦截、超时/阻塞/错误、
工作目录失败、Conversation 忙)与长回合的固定进度提示都走同一入口。

抽象照搬 agent 适配器的形状(ADR-0011):一个小接口加一份诚实的能力台账,注册表按平台键入工厂。
**不采用 forge 集成的形状**——那种二选一三元式每加一个 provider 都要改所有分支。

## 与平台 SDK 的边界

SDK 只负责**入站长连接**:建连、心跳、重连、解码平台私有的二进制帧。这是真正难以自行实现的部分
(需要先换取连接地址,再处理带分片与确认的 protobuf 帧,而其 schema 只嵌在各语言 SDK 内)。

**出站由 c3 自己实现**,走服务端统一的出站 HTTP 通道:发送消息、获取与刷新访问令牌、解析机器人自身
身份。三个理由,第一个是根本的:

- 外发正是被约束的那件事。把 c3 主动送出去的每个字节留在自己的代码里,才能让内容守卫与审计没有
  绕过的可能。
- 统一出站通道已经处理好代理与豁免规则,第二个 HTTP 客户端要把这些重学一遍再单独验证一遍。
- 体积。SDK 的高层封装持有全量 OpenAPI 客户端;只取长连接部分让产物只增长约 0.7 MB,而非约三倍。

代价是平台无关的策略要自己写——但它们本来就该写在中性层。

一键建应用是一条**平台中性的能力**:客户端以 `start_app_registration` 携带 `platform` 发起,
服务端经注册工厂表 `IM_APP_REGISTRATION_FACTORIES` 解析到对应平台实现,未注册的平台收到显式的
不支持结果。当前注册表中只有飞书一个实现,下述细则即该实现的行为。

### 设备授权与一键建应用的窄例外

一键建应用是「SDK 只负责入站」边界的唯一例外,且只覆盖**官方 Device Authorization 的设备码
begin/轮询**:`@larksuiteoapi/node-sdk` 的 `registerApp` 经进程级单例 `defaultHttpInstance`
发 HTTP,无法按调用注入独立 client。代理选择仍由 c3 单方面决定,于是飞书平台边界提供一个幂等
初始化器 `installSdkHttpAgent()`(注册 handler 与 provider 共同依赖,替代原先只设
`defaults.proxy=false` 的孤立副作用):

- 保留 `defaultHttpInstance.defaults.proxy=false`,禁止 Axios 自行读取代理环境变量,避免与 c3
  的代理决策叠加。
- 只安装一次 request interceptor:按每次请求的绝对 URL、当前 `getProxyConfig()` 与环境变量调用
  `proxyAgentFor`,为 HTTPS 请求设置或清除 `httpsAgent`。agent 按目标 origin 与有效代理配置
  复用,配置变化时淘汰旧 agent,避免轮询循环每次重建连接池;直连与 `NO_PROXY` 目标显式清除
  agent,绝不残留上一请求的 agent。
- 初始化可重复调用而不叠加 interceptor;`installSdkHttpAgent()` 返回的 `{ release }` 在测试与
  进程关闭时释放缓存 agent 并卸载。长连接不受影响:`WSClient` 收到显式 agent,不经过该
  interceptor。

注册只面向**飞书中国区**(`accounts.feishu.cn`),固定 `createOnly: true`,不接受客户端传入
addons、既有 App ID 或域名。SDK 一旦报告 `domain_switched`(国际 Lark 租户),服务端立即中止
轮询并以不支持地区收敛,后续可能返回的 Lark 凭据一律丢弃。

### 最小权限模板与灰度限制

`registerApp` 的 addons 是封闭模板,不套用 Agent 全量 manifest:

- `preset: false`,只使用机器人能力最小基底,不叠加平台默认模板。
- tenant scopes 为 `im:message:send_as_bot`、`im:message.group_at_msg:readonly`、
  `im:message.p2p_msg:readonly`、`application:bot.basic_info:read`,覆盖默认群聊 @提及、
  单聊文本入站、文本回复与机器人身份解析;不申请 user scopes、卡片、文档、评论、Wiki 或文件
  能力,也不读取未 @机器人的群内普通消息。
- tenant events 仅为 `im.message.receive_v1`。

addons 受飞书平台灰度控制:未开灰时平台会忽略整个 addons 并展示默认流程,SDK 状态与最终凭据
都不会说明模板是否被忽略,确认页是唯一可观察面。c3 能保证的是请求载荷严格为上述模板,不能把
平台实际授权面伪装成可由程序核验的结果;管理员在确认页看到默认模板或额外业务权限时应拒绝。

### 凭据后的长连接配置与手工降级

取得凭据后,服务端用该应用**自己**的 tenant token 走 application v7 开发配置接口——不构造 SDK
全量 `Client`,不调 v6 PATCH/GET:

- 先以本次返回的 App ID/App Secret 获取 `tenant_access_token`(App ID 必须来自同一注册结果,
  不能由客户端指定),再 `PATCH /open-apis/application/v7/applications/{appId}/config`。
- 请求体只含 `event: { subscription_type: 'websocket', add_events: ['im.message.receive_v1'] }`,
  即一次完成长连接订阅方式与消息事件订阅,正好覆盖下方三条前置条件中的两条。
- 令牌获取与 PATCH 都走 `outboundFetch`,沿用统一代理/豁免与错误处理,叠加任务取消信号与单次
  15 秒超时;`code=0` 是「官方配置接口已接受」的唯一同步判定,之后才返回 `ready`。

若凭据已完整但 token 或 PATCH 因接口不可用、权限拒绝、业务拒绝或网络错误未获 `code=0`,任务
返回 `manual_setup_required` 并**携带完整凭据**,让管理员能找回刚创建的应用手工补齐长连接;
只有取得凭据前的传输错误、响应缺少任一项凭据或内部不变量破坏才返回不含凭据的失败。凭据在
`ready` / `manual_setup_required` 结果中只出现一次、只发往发起连接,不落日志、不广播、不在
机器人创建前持久化。

### 飞书应用侧前置条件

入站只走 SDK 长连接,因此飞书开发者后台必须同时满足:

1. **订阅方式 = 使用长连接接收事件/回调**(不是请求网址推送)。
2. **已添加事件** `im.message.receive_v1`(接收消息)。
3. 应用具备机器人能力,且凭据与 c3 中配置的 `appId`/`appSecret` 一致。

一键建应用(当前仅飞书有实现,且仅新建表单)自动完成 1–3 中的凭据与长连接配置;`manual_setup_required`
降级结果仍须管理员手工补齐 1–2。手工填写凭据、编辑既有机器人及只写密钥语义不变。

`WSClient.start()` 在握手完成前就会返回;c3 会等到 SDK `onReady`(或终端失败/超时)后才记
`[im] connected`。若控制台未切长连接或未订阅该事件,表现为连接失败/超时,或连接成功但发消息后
没有任何 `[c3][feishu] event im.message.receive_v1` / `[im] inbound`。

## 代理

长连接与出站都可能需要经代理。c3 自行解析代理(配置优先,其次标准环境变量,回环与豁免名单除外),
并把结果作为一个建立 CONNECT 隧道的 agent 显式交给连接方。

**同时必须关闭 SDK 自身的代理探测。** 它会自行读取环境变量,随后长连接以协议不匹配失败,
_即使已经显式提供了 agent_。导出了代理变量的机器因此完全连不上,而这类机器很常见。关闭它一次,
代理由 c3 单方面决定。设备授权的 SDK HTTP 请求同样遵守这条边界:interceptor 按每个请求的目标
origin 重新应用 c3 的代理决策,账号域的静态 agent 不会错用于其它飞书 origin,直连与 `NO_PROXY`
不会残留上一请求的 `httpsAgent`(详见上文「设备授权与一键建应用的窄例外」)。

## supervisor 生命周期

形状照搬调度器:模块级句柄、幂等的启动、先停止接受新工作再排空在途的停止。

- **启动** 时为每个已启用的机器人建立连接。某个机器人连不上是可见且可恢复的状态,既不影响启动
  也不影响其它机器人。
- **重载** 用于配置变更:断开旧连接,若仍启用则以当前凭据重连。
- **停止** 先关连接再排空——反过来会让一个正在关停的 supervisor 继续被喂进新消息。它同时挂在进程
  信号与自更新重启上,否则一条遗留的连接会活到下一个进程里,两个版本同时应答同一个群。

重连本身交给 SDK(它内建退避与心跳看门狗),中性层只在连接进入终态失败后做上层重建兜底,
不重复实现心跳。

连接、入站、出站与绑定挑战各打一行 `[im] …` 诊断日志(只含元数据:机器人、chat 类型、sender 摘要、
tokenish、notice key、消费成败原因码);不记录验证码明文或消息正文。飞书 SDK 的连接生命周期经
`[c3][feishu]` 透出。

## 回合执行

机器人回合复用运行启动器已有的「无人值守会话种类」范式(意图/规格/规格评审三个先例),而**不是**
讨论域的逐 agent 会话管理器——后者底层无条件安装标准权限门,敏感工具会挂在一个无人应答的检查上。

回合执行体与自动化的开发回合是结构上的同胞:内部观察者累积 assistant 文本,收到回合结束即以最终
文本收敛。三处差异都源于同一个事实——**没有人在看**:

- 授权请求不是等待的对象,而是立即以 `blocked` 收敛
- 有硬墙钟上限
- 没有附着模式与团队推送分支(同一 Conversation 本就串行,不存在已在运行的回合)

只有最终 assistant 文本作为回复离开这一层;工具调用/结果等其余线事件在此被丢弃——agent 过程不进外发路径。
执行期间回合层把真实阶段投影成 `accepted`/`step_started`/`step_done` 事件帧交给 supervisor(帧不含工具名、输入或
正文);supervisor 按宽限(短回合零进度)、间隔与预算门控,经同一出站守卫以固定文案外发。投影在回合 settle 后即
停止,投递失败只落审计,不阻塞也不重试;最终答复由独立路径完整发出。

supervisor 在启动回合前按七维 Conversation 身份认领消息、校验 `scope_hash`、加载已提交上下文,并把可选的已验证原生
会话引用或数据库恢复种子交给回合执行体。最终回答发送前再复核 binding 与 scope;不一致则丢弃 agent 文本,
只发绑定引导或 `scope_changed` 提示。投递成功后同事务提交 Context Turn;失败则清空正文并失效
原生会话缓存。

机器人身份挂在运行时上(与规格评审挂载被评审意图同理),其启动画像由该身份解析而来;缺身份或缺画像
时启动器抛错而非退化,因为没有配置可约束的回合没有安全的默认值。

## 工具清单与权限网格

表单的工具区是一个与自动化表单**共享**的权限网格(只读/写入两组 + 全选/全清 + 可选的网络开关)。
工具清单按厂商静态声明(`ToolManifestEntry { name, isWrite }`),由服务端一次下发给两个表单:
厂商 SDK 内建工具 + c3 自己的 14 个通用 MCP 工具。`scope: 'robot'` 再加入机器人专属只读
`mcp__c3__list_workspaces`,`scope: 'automation'` 不加入。机器人是部署级管理对象、不绑工作区字段,因此清单
不含任何 `mcp__<server>__` 工作区命名空间——这是管理契约,不是「无 workspaceName 即安全」的数据访问保证。

线路上是同一对消息 `get_tool_manifest { vendor, workspaceName?, scope? }` → `tool_manifest
{ vendor, tools, scope? }`:机器人侧发 `scope: 'robot'` 且不带 `workspaceName`,服务器原样回显
`scope`,前端据此把回复落到机器人缓存而不是自动化缓存——回复可能在提问的表单关闭之后才到。

网格组件只负责渲染、分组、全选/全清、网络开关与 loading/error/empty 状态;创建默认只读、编辑保持原样、
切换厂商清空勾选这些调用方语义留在机器人表单——两种表单对「哪些工具能写」不会静默地产生两份回答。

## 启动画像与沙箱推导

`robotLaunchProfile` 从机器人的 `toolAllowlist` 计算三件事,挂在 `RobotProfile` 上由运行启动器消费
(kernel 不 import features,故结果值在 features 层算好、随画像传递):

- `writeEnabled` —— 是否勾了该厂商的**本地写/执行**工具(codex 为 `shell`/`apply_patch`,排除 `mcp__`
  前缀)。它**独一**决定 codex 原生沙箱模式:workspace-write 对应 actionMode 'build'、只读对应 'plan',
  再经厂商策略映射到 codex 的 sandboxMode;`sessionKind` 保持 `'robot'`,不改动既有
  sandboxEligible 与默认会话种类。
- `networkAccess` —— allowlist 里是否含 `network-access` 伪条目;仅当 codex + workspace-write 才生效,
  其余情况静默忽略。
- `bindMcp` —— 勾了 c3 MCP 工具时的绑定器,把勾选的裸工具名交给传输层;一个 c3 工具都没勾时没有绑定。

### 运行根冻结与双重强制

回合启动时把运行根 `~/.c3/robots/<name>/` 冻结为真实绝对路径(`freezeRobotRoot`,机器人运行时的
`workspacePath` 即此目录),随画像传入运行启动器;根不可解析则回合失败关闭。冻结根被权限门与 claude
的执行前 `PreToolUse` 钩子共用——同一裁决、同一根,门裁决一次、钩子再裁决一次(钩子先于宿主机
`~/.claude/settings.json` 的 allow 规则运行且只拒绝,宿主的设置绕不开边界)。

### 无条件进程隔离

机器人回合无论工作区沙箱开关如何都进程隔离:启动器见 `rt.sandboxPaths` 未置位时,用
`launchSandbox(workspacePath, executionRoot)` 现造一个——允许集折叠为运行根(读写)+ specs/codex/
claude 配置目录 + vendor 认证挂载。隔离建立失败以安全错误结束回合,不退化。驱动路径无需另行接线,
`rt.sandboxPaths` 被强制置位后自动进入包装逻辑。

## c3 MCP 回环绑定

机器人经 `transport/robot-mcp` 使用独立回环流式 HTTP 路径(`/internal/robot-mcp/v1`):每次绑定颁发
一次性令牌,回环外源被拒,`enabledTools` 精确等于勾选子集,dispose 时先吊销令牌再关连接,URL 随即
404。传输层只携带不可伪造的 IM 上下文、binding id、回合起点 `scope_hash` 与实时 run id,不在
initialize 时钉定台账 `workspacePath`。

装配分为两个机器人专用构造器:

- `buildRobotL1Tools` 处理六个账本只读工具和机器人专属 `list_workspaces`。列举型遍历当次详细可见工作区,
  对象型先反查归属再验详细可见集;`list_workspaces` 仅按注册表顺序返回实时详细可见集的名称。
- `buildRobotWriteTools` 处理 `save_intents`、`save_intent_directly`、`submit_spec_review`、
  `start_session_for_intent`、`start_discussion`、`continue_discussion`。每个 handler 先重算调用级作用域;
  新建型从显式 `workspaceName` 解析注册根,对象型从 id 反查候选归属后验详细可见集,再调用意图、规格评审、
  会话启动或讨论域的共享核心。

机器人写构造器的闭包不含运行根。保存包装 schema 才有 `workspaceName`,进入共享核心前剥离该字段与
`intentSessionId`;`save_intents` 的每项 `status: 'todo'`/`automate` 与五维正文说明直接复用意图域
共享 schema,机器人不复制状态规则;`save_intent_directly` 不含这两个写字段。intent-mcp 和
automation-mcp 的 schema 与既有工作区 binding 不变。规格审核包装额外
接收 `intentId`,首次读取 live spec 指纹并以实时 robot run id 归因;共享核心提交前再次读取,不一致即
stale 零写入。对象缺失与越权使用相同 `not_visible` 结果,不会泄露其它工作区是否存在该 id。

启动依赖的构造顺序里存在一个「launchDeps ↔ robotMcp」环,靠惰性取值器解开:robotMcp 先于 launchDeps
创建,工具处理器经 `() => robotMcpDeps` 在回合真正运行时才解析广播、讨论启动与 session launch 依赖;
依赖未就绪则拒绝。运行 id 按取值器延迟解析,供 `submit_spec_review` 使用实际 robot run id 归因。

## 会话续接

Conversation 的下一条消息可带着上次绑定的原生会话 id 进入,厂商据此续接同一段对话。会话 id 只在产生
它的厂商内有效,所以 Conversation 同时记录厂商。绑定发生在回复投递**成功之后**:未送达的回答不得把
原生会话缓存推进到发送者尚未见过的状态;失败回合会清空该缓存。

## 存储与配置

`robots` 模块下除机器人/线程/上下文/审计四表外,还有 IM 身份绑定、一次性挑战、群工作区白名单与授权
审计表(`database/robots/` 与 `database/auth/` 边界)。均由 store 在首次访问时惰性、幂等地建表(与全库
一致的收敛方式)。密钥经既有的配置加密落库,读取只经一个专用访问器,其余读路径只见到「是否已配置」。

机器人四表(`im_robots` / `im_robot_threads` / `im_robot_context_turns` / `im_robot_turns`)的持久化按
职责拆分:`robot-schema.ts` 持有表 DDL、整表重塑迁移与 `ensureSchema`;`robot-config-store.ts` /
`robot-context-store.ts` / `robot-turn-store.ts` 分别是配置 CRUD、会话上下文生命周期、回合审计三类
读写入口;`robot-db.ts` 是共享基础(连接获取、事务、测试用时钟)。`robot-store.ts` 保留为对外 barrel,
外部 import 路径不变。SQLite 不能 `ALTER` 一个 `CHECK`,整表重塑(重命名归档 → 建新表 → 投影搬数据 →
重建索引)因此由 `table-rebuild.ts` 的 `rebuildTable` 统一承担,替代此前四表各自手写、曾两次因索引
误挂旧表复发同一缺陷的重塑套路。
