# agent-session — Cursor vendor

实现规则见 [agent-session-spec](../agent-session-spec.md);厂商中立抽象见
[ADR-0011](../../../../architecture/adr/0011-vendor-neutral-agent-abstraction.md)、
二进制解析见 [ADR-0012](../../../../architecture/adr/0012-host-binary-probe-first-capability-gate.md)、
会话归属见 [ADR-0015](../../../../architecture/adr/0015-session-agent-binding-vendor-ownership.md)、
store scope 见 [ADR-0030](../../../../architecture/adr/0030-session-store-scope-vendor-neutral-data-root.md)。

Cursor 是 c3 驱动的第三个厂商,与 Claude、Codex 同质地落在厂商中立的三件套
(driver / approval / session-store)与能力台账上。运行载体是 **`@cursor/sdk`
的 local runtime**:它作为 c3 的依赖随包发布,并在 **c3 服务进程内**执行 ——
没有 `cursor-agent` 子进程,没有 argv,没有 NDJSON 解析。一轮 = `Agent.create`
(或 `Agent.resume`)→ `send` → 迭代 `Run.stream()` → 由 `Run.wait()` 收束。
c3 负责规范化消息流、读取 SDK 本地存储、管理运行生命周期,但 **Cursor 自身保存
的上下文才是恢复真相**。

## 运行载体与可用性判定

Cursor **没有宿主二进制描述符**:它既不是 Claude/Codex 那样由 c3 从 npm 托管
安装的 CLI,也不是用户自装的外部 CLI,因此不出现在 `HOST_BINARIES` 中,也不参与
远程版本发现、版本钉选与历史清理。可用性判定退化为一句话:**`@cursor/sdk` 能否
被解析**(`require.resolve`,不实际加载,避免为一次探测拉起整个 local runtime 与
平台原生包)。不可解析 ⇒ cursor agent 类型不可用,启动日志给出原因。

SDK 通过 optionalDependencies 解析平台原生包(`@cursor/sdk-<os>-<arch>`)。因此:

- **npm 安装的 c3**(带 node_modules):Cursor 完整可用。
- **单文件二进制发布**:`@cursor/sdk` 被显式排除在 bundle 之外(否则会把构建机
  的原生模块冻进所有交叉编译目标),故二进制中不携带 Cursor runtime,cursor
  agent 类型不可用。这是诚实的降级,而非静默失败。

这个判定要被控制台看见,靠的不是"前端知道 cursor 特殊",而是 `settings` 回包里
**覆盖全部 vendor 的中立可用性信号** `vendorRuntime`(见
[websocket-protocol](../../../../shared/api-conventions/websocket-protocol.md#settings)):
每个 vendor 都用同一套词汇作答 —— 能不能跑、由哪类运行时承载(`host-cli` /
`embedded-sdk`)、不能跑的稳定原因码。Claude/Codex 的那一项仍取宿主 CLI 探测结果
(语义与 `hostStatus` 完全一致),cursor 的那一项取 `@cursor/sdk` 能否解析,**与
服务端启动时决定要不要构造 cursor adapter 用的是同一个探针函数**,因此设置页所报
状态与内核实际能力不可能漂移。`hostStatus` 继续只讲宿主 CLI:cursor 不出现在其中,
也不进入 vendor CLI 版本面板 —— 它没有二进制可装、可钉、可同步。

## 厂商接口契约

- **driver**:每次 `start()` 解析凭据 → 构造 agent 选项 → `Agent.create` /
  `Agent.resume` → `send` → 迭代 `Run.stream()`。`sessionId()` **不需要等待**:
  agent id 由 SDK 在创建时铸出,`start()` 返回时即为已知,因此不存在"合成 id 被
  交给 resume"的风险。续聊把 c3 会话绑定的原生 agent id 原样传给 `Agent.resume`。
  `abort()` 调用 `Run.cancel()`——进程内的协作式停止,但仍是**整轮**级别:SDK
  没有在途 interrupt,也没有逐工具批准点。轮次结束(无论成败)后关闭 agent 句柄,
  释放 local executor 与其 MCP 客户端;下一轮按 id resume,不丢上下文。
- **approval**:结构性 no-op。消息流是单向只读的,没有"请求批准"事件,也没有
  回写半信道;`onRequest` 满足契约(可注册、可注销)但永不触发。批准被降级为
  启动期一次性策略(见下)。
- **session-store**:读 **SDK 自己的 local agent store**(`Agent.list` /
  `Agent.messages.list`,已发布 API),**不读** Cursor IDE 的私有 chat 库 ——
  后者没有兼容承诺,解出来的镜像会在下个版本腐化。rename/delete 不提供。
- **skill**:发现目录为项目级 `<project>/.cursor/skills`;SDK 在加载 `project`
  设置层时会扫描工作区的 rules / skills / `AGENTS.md`,而 c3 的运行恒定加载该层。
  支持度随 SDK 是否可解析门控。

## 能力台账

八个在途运行控制全部为 `false`,且各有所据:

- `perToolApproval: false` —— 无逐工具批准信道;权限在轮次启动时一次定死。
- `interrupt: false` —— `Run.cancel()` 确实存在且是真实的协作式停止,但它**结束
  整轮**;没有"插话后同一 run 继续"的通道,而这正是本标志的语义。
- `inProcessMcp: false` —— 这是 **c3 侧**的事实而非 SDK 限制:SDK 提供进程内回调
  工具(`local.customTools`,以合成 MCP server 面向模型暴露),但 c3 尚未把自己的
  工具接到该通道;接通之日才翻转,不提前。
- `taskStore: false` —— SDK 没有 task API;其 `updateTodos` 是对话内记账调用,
  不是 c3 可读写的存储。
- `nativeUserInput: false` —— headless 运行从不向人发问。
- `setActionMode` / `streamingPush` / `forkSession: false` —— 模式在轮次启动时
  固定(可逐轮改变,但不能改活跃 run);下一轮是新的 run 而非推入活跃会话;
  `Agent.resume` 服务于中性 resume 语义而非 fork。

`canFormTeam`(依赖 `streamingPush`)因此对 Cursor 为假:Cursor 会话不能成为
agent-team 的常驻 lead。

## 会话能力等级

- `resume: full` —— `Agent.resume(agentId)` 端到端恢复原生上下文,即便上一轮是被
  取消的(探针已证)。id 由 SDK 铸出,不可能被伪造。
- `list / read: partial` —— 由 SDK 本地存储服务,只覆盖**经 SDK 创建**的 agent;
  用户在 Cursor IDE 或 `cursor-agent` CLI 里产生的历史不在其中。这是真实的缩减,
  故标 `partial` 而非 `full`(不夸大)或 `none`(不隐藏入口)。
- `rename / delete: none` —— SDK 对 local agent 均不提供;c3 不假装修改不属于
  自己的存储。

## 流式归一化

规范化器是有状态的(每运行一个实例),遵守 `CanonicalMessage` 的
append-with-id-upsert 契约。**关键事实:SDK 的 `assistant` 与 `thinking` 帧都是
增量**(由内部 `text-delta` / `thinking-delta` 构造),而 wire 消费端只切片新增
后缀 —— 故同一 id 下必须**累积重发整段**,原样转发增量会截断可见输出。

- **文本**累积进当前打开的 span;被工具调用或推理帧**打断**后关闭该 span,下一个
  增量开启新块。这样"工具调用之后说的话"不会被追加回它之前,转录顺序与模型实际
  产出一致。
- **thinking** 仅来自原生 `thinking` 帧:增量拼接为单一块累积重发,空文本的收束
  帧(仅带 `thinking_duration_ms`)结束该 span。**绝不**从文本或事件名启发式
  伪造 thinking。
- **工具**按稳定 `call_id` 关联(running 与 completed 同 id),结果回填到同一
  `tool_use` 块;不按到达顺序配对并发调用。开始帧携带的入参在补全帧省略时仍然
  保留。无 `call_id` 时按确定性序号合成并标记降级;补全帧找不到对应开始帧时单独
  成块并标 `orphanCompletion`,不误绑到他工具。`status: 'error'` 即便没有 payload
  也必须落成失败结果,否则该块会永远停在"运行中"。
- **未知事件 / 运行时记账帧(`task`/`usage`/`request`)/ 无法表达的富消息**完整
  保存在 envelope 或 block 的 `vendorExtra`,不丢弃也不伪造转录内容。
- **终局**以 `Run.wait()` 为准:流结束只意味着没有更多帧,不意味着轮次成功。
  `status` 帧提供即时的错误文本,`wait()` 给出最终裁决。

## 权限与模式

SDK 给出两个各自独立、且在轮次启动时固定的旋钮:对话 `mode`(`agent` / `plan`)
与是否启用 Cursor 的 Auto-review 分类器审查工具调用(`autoReview`)。没有逐工具
运行期批准信道,故中性工具门无法逐调用兑现;能诚实兑现的是"全自动执行"与"由
Cursor 自己的分类器把关"二选一 —— 只有显式的 `never-ask` 关闭审查。

模式目录三档:

- `plan` → plan × on-sensitive → SDK 的 `mode: 'plan'`,一等的偏读对话模式。
- `agent` → build × on-sensitive → `mode: 'agent'`,Auto-review 开。
- `full-access` → build × never-ask → `mode: 'agent'`,Auto-review 关,工具全自动。

与 CLI 时代的关键差异:**plan 不再被拒绝**。CLI 的 `--mode plan` 只读性未被证明,
故当时 driver 对任何 `ActionMode === 'plan'` 直接拒绝启动;SDK 把 plan 提升为
一等对话模式,探针确认其被接受,因此模式目录开放 plan 令牌。

## 工具清单与风险

`listTools()` 向 `freezeTools()` 提供 SDK `ToolCall` 联合中的原生工具静态表 ——
工具名即该联合的判别值(`read` / `shell` / `semSearch` / …),既是线上身份也是
控制台显示名,无需去后缀或翻译。每项归入六个中立类别之一:`read` / `search` /
`edit` / `execute` / `network` / `meta`;另附 MCP 命名空间前缀(保守按 write)。
风险归一化只映射原生参数形状已知的工具;其余(`mcp`/`task`/`createPlan`/
`updateTodos`/`readLints`/`generateImage`/`recordScreen`)保持 `unknown-tool` 并
**fail-closed**——未知工具永不因名字近似而默认放行。

## MCP

c3 的回环 HTTP MCP 服务器作为 `mcpServers` **直接传入** `Agent.create` 选项。
CLI 时代那套"改写数据根 `mcp.json` → `mcp list` 自检 → 运行后还原"的注入术**已
整体删除**:它存在的唯一理由是 CLI 只从配置文件读 MCP,而 SDK 直接收配置。
`bearerTokenEnvVar` 在此被解析为 Authorization 头(SDK 收头而非环境变量间接层)。

## 认证与数据根

**SDK 只认 API Key**:`apiKey` 选项或 `CURSOR_API_KEY` 环境变量。它**不读**
`cursor-agent login` 写入操作系统钥匙串的凭据 —— 这是与 CLI 路线最大的行为差异,
也是 agent 配置形状变化的原因。凭据解析顺序:agent 配置的 `apiKey` → 本轮
`envOverrides.CURSOR_API_KEY`(bound agent 的密钥经此到达进程内 driver)→ 服务端
环境变量。三者皆空时 **在 `start()` 处即失败**,而不是烧掉一轮再返回 SDK 那句
不可行动的 `Invalid User API Key`。

agent 配置形状:`{ apiKey, model }`,**没有 `baseUrl`** —— c3 没有讲 Cursor 协议
的 relay,故 Cursor agent 不能被指向其他 provider,`configMode` 恒为 `system`
(schema 拒绝携带 baseUrl 的配置)。`apiKey` 落盘按 SEC-13 加密(与其他厂商同一
机制,按字段名而非厂商分支处理):线上与内存里是明文(故保存后仍可继续编辑),
写入 `settings.json` 时是带 `c3secretv1:` 前缀的密文。

## 控制台配置入口与消费面

系统设置的 Agent 配置面板把 Cursor 与 Claude/Codex 同列在 vendor 下拉里:选中即
重建判别联合的 cursor 分支(`configMode: 'system'` 且不可切 `custom`,config 仅
`{apiKey, model}`,任何路径都不产生 `baseUrl`);`apiKey` 可留空,此时运行期回落到
服务端环境的 `CURSOR_API_KEY`,`model` 留空则沿用 Cursor 的 `auto`。

可用性门控一律读上面那个中立信号,**不写 `if (vendor === 'cursor')`**:运行时不可用
时该选项禁用、原因就地标注(下拉选项与 agent 列表下方各一份),而**已经配置好的
cursor agent 的选项保持可选** —— 否则浏览器会把选中值挪走,等于 UI 悄悄改写了一条
既有配置。Runtime 诊断区为每个 vendor 各出一行:标识列显示宿主 CLI 的二进制名或
进程内 SDK 的包名(`@cursor/sdk`),路径、版本这些只有真实 CLI 才有的字段仅在宿主
CLI 行渲染。

建成之后,Cursor agent 与其他真实 agent 走同一套排序、分组与选择规则,可出现在:
系统默认 agent 与工具/意图/规格/规格评审角色选择、降级链、工作区新会话与各类会话的
待定绑定、新建会话弹窗、讨论参与者、共识投票者。这些消费面**不额外过滤 cursor**。
会话首轮之后仍遵守既有 vendor 冻结规则(同 vendor 可换 agent,跨 vendor 重绑被拒);
讨论参与者可以是 Cursor,但研究会话的组织者仍只允许 Claude —— 本变更不借此放宽编排
约束。

**automation 是唯一的例外**:Cursor 没有 dispatcher 执行路径,故自动化表单把它灰显
并标注"不支持自动化",LLM 型任务**新选中**它时禁止保存;系统配置的 automation agent
跟随链若解析到 Cursor,表单不把它当作可提交的默认值,而是回落到受支持的 vendor 并要求
用户显式改选。表单灰显与调度期 hard-fail 读的是同一份 `AUTOMATION_VENDORS` 列表,所以
表单不可能提供一个 dispatcher 会拒绝的选择。既有的 Cursor automation 仍可查看与编辑,
其 vendor 不被 UI 门控静默改写 —— 该 vendor 选项对这条记录保持可选,保存门控也放行它,
名称/提示词/触发条件等无关字段照常可改可存(表单提示分派时会直接失败);禁止保存只针对
把一条记录**新改成**不受支持的 vendor。

数据根恒为 `$HOME/.cursor`:SDK 的 local agent store 落在
`~/.cursor/projects/<workspace>/sdk-agent-store/…`,与运行加载的工作区 rules /
skills 同根。该根**只存会话状态,不含凭据**。

## 沙箱

arapuca 包装的是**子进程**;Cursor 的 runtime 在 c3 进程内,没有子进程可窄化,
因此 Cursor **不注册 arapuca auth profile**,`createSandboxWrapper` 也不会为它
生成 wrapper。隔离改由 SDK 自带沙箱兑现:中性的 `DriverStartOptions.sandboxed`
(每个沙箱运行都为真,与厂商如何实现隔离无关)映射为
`local.sandboxOptions.enabled`。这也是 `sandboxed` 这个中性字段存在的原因 ——
CLI 厂商经 `sandboxWrapperPath` 兑现,进程内 SDK 厂商经自身 runtime 兑现。

## 探针结论

准入探针脚本 `scripts/e2e/cursor-sdk-probe.mjs` 可复现地验证各项能力,其结论是
本能力台账的唯一事实来源。两个**阻断项**:

- **G1 resume 恢复上下文**:第二轮经 `Agent.resume(agentId)` 记得第一轮建立的
  暗号。不成立则 `sessions.resume` 不能标 `full`。
- **G2 取消后仍可续聊**:一轮被 `Run.cancel()` 中途杀死后,同一 agent 仍可 resume
  并正常完成下一轮。不成立则被打断的会话即告丢失。

其余为信息项:原生工具名清单、工具 `call_id` 在 running/completed 间的稳定性、
plan 对话模式被接受、SDK 本地存储能列出 c3 创建的 agent。探针需要真实
`CURSOR_API_KEY` 与出网,非 CI 安全,不在 `pnpm e2e` 套件内。

## 降级与非目标

已接受的展示降级:SDK 本地存储只覆盖 c3 经 SDK 创建的 agent(用户在 IDE/CLI 里
的运行不在其中)——这只影响列表/回放展示,`resume` 始终以 Cursor 原生上下文为准,
故差异不改变恢复来源。单文件二进制发布中 Cursor 不可用(见"运行载体与可用性判定")。

非目标:不驱动 `cursor-agent` CLI;不读取或逆向 Cursor IDE 的私有 chat 库;不冒充
Cursor 可恢复真相;不支持 custom/relay 自定义 provider、逐工具审批、Cursor IDE
历史同步、partial streaming、完整 diff/patch、token 用量、subagent 嵌套展示、
automation 执行。Cursor automation 无执行路径,会在调度期 hard-fail,而非借道
Claude 引擎。

## 待探针解锁

以下能力在相应探针证明后才开放,此前保持关闭:

- **进程内工具**:把 c3 自己的工具接到 SDK 的 `local.customTools` 后,
  `inProcessMcp` 方可翻为 true。
- **会话 list/read 升级**:若未来 SDK 暴露覆盖 IDE/CLI 会话的读取通道,可把
  `partial` 升为 `full`(仍不读私有库)。
- 任何新增在途控制(如真正的在途 `interrupt`)需先有探针证据,再翻台账。
