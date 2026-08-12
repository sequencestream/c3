# agent-session — Cursor vendor

实现规则见 [agent-session-spec](../agent-session-spec.md);厂商中立抽象见
[ADR-0011](../../../../architecture/adr/0011-vendor-neutral-agent-abstraction.md)、
二进制解析见 [ADR-0012](../../../../architecture/adr/0012-host-binary-probe-first-capability-gate.md)、
会话归属见 [ADR-0015](../../../../architecture/adr/0015-session-agent-binding-vendor-ownership.md)、
store scope 见 [ADR-0030](../../../../architecture/adr/0030-session-store-scope-vendor-neutral-data-root.md)。

Cursor 是 c3 驱动的第三个厂商,与 Claude、Codex 同质地落在厂商中立的三件套
(driver / approval / session-store)与能力台账上。运行载体是**每轮一个
`cursor-agent` 子进程**:一轮 = `create-chat` 铸 id → 组 argv 与 env → spawn →
把提示写进 stdin 并关闭 → 逐行解析 NDJSON 帧 → 以子进程退出码收束。c3 负责规范化
消息流、读取 Cursor 的磁盘会话库、管理运行生命周期,但 **Cursor 自身保存的上下文
才是恢复真相**。

## 运行载体与可用性判定

Cursor 与 Claude/Codex 一样进入 `HOST_BINARIES`,但它是其中唯一**不由 c3 分发**的
一项:`cursor-agent` 由 Cursor 官方安装器发布、按发布日期而非 semver 版本化,因此
不参与远程版本发现、下载、版本钉选与历史清理。解析链相应只有两级:

1. `$CURSOR_PATH` —— 部署方指定的可执行文件;
2. 宿主 PATH —— 官方安装器的落点。

两级皆空 ⇒ cursor agent 类型不可用,原因码 `host-cli-missing`,启动日志给出安装
方式。二进制名(`cursor-agent`)与 vendor 名不同,是唯一这样的 vendor,所以每条
解析路径都从描述符读名字而不是拿 vendor id 当二进制名。

这个判定要被控制台看见,靠的不是"前端知道 cursor 特殊",而是 `settings` 回包里
**覆盖全部 vendor 的中立可用性信号** `vendorRuntime`(见
[websocket-protocol](../../../../shared/api-conventions/websocket-protocol.md#settings)):
每个 vendor 都用同一套词汇作答 —— 能不能跑、由哪类运行时承载、不能跑的稳定原因码,
取值均来自同一次宿主 CLI 探测。可用时诊断行额外给出**解析来源**(c3 随包安装 /
宿主 PATH / 路径覆盖)与**已解析位置**,回答"跑起来的是哪一份";来源不进原因码,
门控形状不变。cursor 出现在 `hostStatus` 与 runtime 诊断区,但不出现在 vendor CLI
版本面板里 —— 那里管的是 c3 装什么版本,而 cursor 的版本不由 c3 决定。

## 厂商接口契约

- **driver**:每次 `start()` 解析凭据 → 组装 env 与 argv → 铸 id → spawn。
  `sessionId()` **不需要等待**:新会话在 spawn 之前先跑一次 `create-chat` 拿到
  Cursor 自己铸的 chat id,`start()` 返回时即为已知,因此不存在"合成 id 被交给
  resume"的风险,也不存在首帧之前就失败的运行把上游绑定挂死的可能。续聊把 c3 会话
  绑定的原生 id 原样传给 `--resume`。`abort()` 把中止信号交给 `spawn`,终止子进程
  ——**整轮**级别:没有在途 interrupt,也没有逐工具批准点。
- **approval**:结构性 no-op。消息流是单向只读的(stdin 在派发后即关闭),没有
  "请求批准"事件,也没有回写半信道;`onRequest` 满足契约(可注册、可注销)但永不
  触发。批准被降级为启动期一次性策略(见下)。
- **session-store**:读 **Cursor 自己的磁盘会话库**
  `~/.cursor/chats/<工作区哈希>/<chat id>/`。每个目录含 `meta.json`(标题、cwd、
  时间戳 —— 列表所需的全部字段)与 `store.db`(正文)。列表只读 JSON,不开数据库;
  正文才读 `store.db`。因为这是 CLI 与 Cursor IDE 共写的同一个库,**在这个工作区
  里发生过的会话都在**,而不只是 c3 建的那些。rename/delete 不提供。
- **skill**:发现目录为项目级 `<project>/.cursor/skills`;CLI 扫描 `--workspace`
  指向的工作区取 rules / skills / `AGENTS.md`。支持度随 CLI 能否解析门控。

### 磁盘会话库的形状

工作区哈希是该工作区真实路径的 md5。它是**快路径而非真相**:列表先直接定位到该
目录,未命中则按 `meta.json` 里记录的 `cwd` 回退扫描(带时间窗截断),所以一个在
不同路径规范化下写入的库仍然找得到。

`store.db` 只有两张表:`meta` 的单行是十六进制编码的 JSON 头,指出 DAG 根;
`blobs` 是以内容 sha256 为键的存储。根 blob 是唯一的二进制节点 —— 一条 protobuf
记录,其重复的第一个字段按对话顺序列出子节点;每个子节点都是形如
`{ role, content: [...] }` 的纯 JSON。因此正文解码只需要"读一条记录的第一个字段"
这一点 wire 解析,其余都是普通 JSON。该格式没有兼容承诺,故每一步都软失败:库打不
开、根缺失、节点解析不出、字段布局挪位,结果都是**更短的转录**而非报错。恢复不受
影响 —— resume 重放的是 Cursor 自己的上下文,从不经过这里。

工具结果在库里是独立的 `tool` 角色消息,按原生 call id 回填到发起它的调用块上,
与直播流"一个块自带其结果"的形状一致。

## 能力台账

八个在途运行控制全部为 `false`,且各有所据:

- `perToolApproval: false` —— stdin 在派发后即关闭,没有逐工具批准信道;权限在轮次
  启动时一次定死。
- `interrupt: false` —— 只有整轮终止,没有"插话后同一 run 继续"的通道,而这正是
  本标志的语义。
- `inProcessMcp: false` —— **恒定为假,且是非目标**。c3 的工具统一经回环 HTTP MCP
  端口到达各厂商,与 Claude/Codex 同一条传输;为 Cursor 单独建一条进程内通道会让
  工具身份、鉴权与审计出现第二套规则。因此这一项不等待任何探针。
- `taskStore: false` —— 没有 task API;`updateTodos` 是对话内记账调用,不是 c3 可
  读写的存储。
- `nativeUserInput: false` —— headless 运行从不向人发问。
- `setActionMode` / `streamingPush` / `forkSession: false` —— 模式是 argv,在轮次
  启动时固定(可逐轮改变,但不能改活跃 run);下一轮是新的进程而非推入活跃会话;
  `--resume` 服务于中性 resume 语义而非 fork。

`canFormTeam`(依赖 `streamingPush`)因此对 Cursor 为假:Cursor 会话不能成为
agent-team 的常驻 lead。

## 会话能力等级

- `resume: full` —— `--resume <chat id>` 端到端恢复原生上下文(探针已证)。id 由
  Cursor 铸出,不可能被伪造。
- `list / read: full` —— 由 Cursor 自己的磁盘会话库服务,覆盖该工作区的全部历史,
  含用户在 Cursor IDE 或 `cursor-agent` 里产生的会话。
- `rename / delete: none` —— 这是用户自己的 IDE 数据;c3 不修改不属于自己的存储。

## 流式归一化

规范化器是有状态的(每运行一个实例)。**关键事实:`assistant` 与 `thinking` 帧都是
增量**,而 c3 全局契约是**一个 canonical 文本块 = 一整段话**:claude / codex 的
适配器交出的都是完整块,下游(浏览器气泡、automation 完成度裁判、讨论回写)也都按
"一条发出的文本 = 一条消息"读取。故规范化器**累积整段,只在 span 结束时发出一次**;
原样转发增量会把一次回复打散成几十条转录记录。

- 运行身份在 `session_id` 字段上,由 `system` 帧首先报出(driver 已在 spawn 前
  知道它,故这里只是确认)。
- **文本**累积进当前打开的 span;被工具调用、推理帧或轮次终局**结束**时整段发出,
  下一个增量开启新块。这样"工具调用之后说的话"不会被追加回它之前。
- **thinking** 仅来自原生 `thinking` 帧:增量拼接为单一块,不带文本的收束帧结束
  该 span。**绝不**从文本或事件名启发式伪造 thinking。
- **工具**按稳定 `call_id` 关联(started 与 completed 同 id),结果回填到同一
  `tool_use` 块;不按到达顺序配对并发调用。工具身份来自 `tool_call` 载荷里唯一
  的判别键 —— `{ editToolCall: { args, result } }` 这样的形状,去掉 `ToolCall`
  后缀即得工具名。无 `call_id` 时按确定性序号合成并标记降级;补全帧找不到对应开始
  帧时单独成块并标 `orphanCompletion`,不误绑到他工具。
- **未知事件 / 运行时记账帧(`task`/`usage`/`request`)**完整保存在 envelope 或
  block 的 `vendorExtra`,不丢弃也不伪造转录内容。
- **终局**是 `result` 帧:它带 `is_error` 与结果文本,是这条流里唯一可靠的轮次
  结束信号,因此它必须像终局那样关闭并交出仍然打开的 span。流耗尽而没有终局帧时
  (子进程被杀、静默结束),由 driver 调用 `flush()` 兜底。子进程退出码是第二道
  裁决:非零即失败,stderr 原文进错误消息。

## 权限与模式

argv 给出三组各自独立、且在轮次启动时固定的旋钮:工作区信任、对话模式、工具门。
没有逐工具运行期批准信道,故中性工具门无法逐调用兑现;能诚实兑现的是"全自动执行"
与"由 Cursor 自己的分类器把关"二选一 —— 只有显式的 `never-ask` 关闭审查。

- `--trust` **无条件下发**:不带它时 CLI 会停在工作区信任确认并直接退出,而 c3
  早已认定这个目录就是本轮的工作区,那个确认已无可问。
- `--workspace` 即便与进程 cwd 相同也照样下发:它决定加载哪一层项目配置。

模式目录三档:

- `plan` → plan × on-sensitive → `--mode plan`,一等的偏读对话模式,拒绝写入。
- `agent` → build × on-sensitive → 默认模式 + `--auto-review`,由 Cursor 的分类器
  逐调用裁决(headless 下不阻塞,探针已证)。
- `full-access` → build × never-ask → `--force`,工具全自动。

## 工具清单与风险

`listTools()` 向 `freezeTools()` 提供原生工具静态表 —— 工具名即帧里判别键去后缀后
的值(`read` / `shell` / `semSearch` / …),既是线上身份也是控制台显示名。每项归入
六个中立类别之一:`read` / `search` / `edit` / `execute` / `network` / `meta`;另附
MCP 命名空间前缀(保守按 write)。风险归一化只映射原生参数形状已知的工具;其余
(`mcp`/`task`/`createPlan`/`updateTodos`/`readLints`/`generateImage`/`recordScreen`)
保持 `unknown-tool` 并 **fail-closed**——未知工具永不因名字近似而默认放行。

## MCP

CLI 不接受 MCP 命令行参数,也没有任何环境变量能重定向它读配置的位置:它只认
`<工作区>/.cursor/mcp.json` 与用户级同名文件,而 `--workspace` 指向哪里,运行就在
哪里落文件 —— 配置根与工作根无法分离。因此 c3 的回环 HTTP MCP 服务器**在轮次期间
写入项目文件,轮次结束时还原**。

这条路径会碰用户自己的工作区,且回环 URL 携带**本轮绑定令牌**,所以四道约束都是
必需的,缺一条这个做法就不成立:

- **还原是字节级的**。写入前记下原内容(包括"本来没有这个文件"),`finally` 里无论
  成败都放回去;工作区自己声明的 MCP server 原样保留在合并结果里,c3 的条目叠加
  其上。
- **同一工作区的第二个运行拒绝启动**,而不是覆盖。文件锁只覆盖一次同步读改写,而
  需要互斥的是**整轮**:否则先结束的那一轮会把文件从仍在使用它的那一轮脚下抽走。
- **文件对 git 隐身**。条目写进该检出的 `.git/info/exclude`(幂等追加,链接式
  worktree 的 `.git` 指针会被跟随),因为唯一必须不可能发生的结局是令牌被提交 ——
  而一个执行 `git add -A` 的智能体就会那么做。用户自己的 `.gitignore` 不被触碰。
- **进程无论因何退出都还原自己写下的内容**;真的没来得及还原时,下一轮会认出那份
  残留(回环 URL 是 c3 自己的路由,别处没有理由写一个)并丢弃它,而不是把一个已死
  的令牌当成"用户的文件"再写回去。

argv 附 `--approve-mcps` 免去交互批准。该层不做 JSON 序列化,文件按文本拼装并逐值
转义。

## 认证与数据根

凭据有两条路,**API key 是可选的**:填了就用,留空则由 `cursor-agent login` 写入
操作系统钥匙串的登录态兜底 —— 订阅用户因此无需申请密钥。解析顺序:agent 配置的
`apiKey` → 本轮 `envOverrides.CURSOR_API_KEY` → 服务端环境变量;三者皆空不是错误。
两条路都不通时失败发生在子进程里,其 stderr 原样上浮,由它说清缺的是登录还是密钥。

agent 配置形状:`{ apiKey, model }`,**没有 `baseUrl`** —— c3 没有讲 Cursor 协议
的 relay,故 Cursor agent 不能被指向其他 provider,`configMode` 恒为 `system`
(schema 拒绝携带 baseUrl 的配置)。`apiKey` 落盘按 SEC-13 加密(与其他厂商同一
机制,按字段名而非厂商分支处理):线上与内存里是明文(故保存后仍可继续编辑),
落库时是带 `c3secretv1:` 前缀的密文(`config_type='secret'`)。

数据根恒为 `$HOME/.cursor`,沙箱内外同一个:会话落在 `chats/<工作区哈希>/<id>/`,
与运行加载的工作区 rules / skills 同根。该根**只存会话状态,不含凭据**。

## 控制台配置入口与消费面

系统设置的 Agent 配置面板把 Cursor 与 Claude/Codex 同列在 vendor 下拉里:选中即
重建判别联合的 cursor 分支(`configMode: 'system'` 且不可切 `custom`,config 仅
`{apiKey, model}`,任何路径都不产生 `baseUrl`);`apiKey` 输入框标明可留空,
`model` 留空则沿用 Cursor 的 `auto`。

可用性门控一律读上面那个中立信号,**不写 `if (vendor === 'cursor')`**:运行时不可用
时该选项禁用、原因就地标注(下拉选项与 agent 列表下方各一份),而**已经配置好的
cursor agent 的选项保持可选** —— 否则浏览器会把选中值挪走,等于 UI 悄悄改写了一条
既有配置。Runtime 诊断区为每个 vendor 各出一行,列的形状对三个 vendor 完全相同。

建成之后,Cursor agent 与其他真实 agent 走同一套排序、分组与选择规则,可出现在:
系统默认 agent 与工具/意图/规格/规格评审角色选择、降级链、工作区新会话与各类会话的
待定绑定、新建会话弹窗、讨论参与者、共识投票者。这些消费面**不额外过滤 cursor**。
会话首轮之后仍遵守既有 vendor 冻结规则(同 vendor 可换 agent,跨 vendor 重绑被拒);
讨论参与者可以是 Cursor,但研究会话的组织者仍只允许 Claude —— 本约定不借此放宽编排
约束。

**automation 同样不例外**:`AUTOMATION_VENDORS` 含 cursor,dispatcher 有自己的
cursor 分支,自动化表单因此按普通 vendor 处理它 —— 可新选、可绑定同 vendor 的启用
Agent、可保存,系统配置的 automation agent 跟随链解析到 Cursor 时直接作为默认执行
身份。表单灰显与分派门控读的仍是同一份列表,所以表单不可能提供一个 dispatcher 会
拒绝的选择;而"运行时此刻可不可用"是另一项独立条件:CLI 找不到时选项按
`host-cli-missing` 灰显并就地标注原因。

自动化里的 Cursor 与会话里的 Cursor 是同一套语义:mode 由 `cursorModeCatalog` 解析
(`plan` / `agent` / `full-access`,其余令牌降级到目录默认 `agent`),凭据仍是那条
三级链,c3 的回环 HTTP MCP 经 `driver.start({ mcpServers })` 注入(与 claude/codex
同一条路由,不额外开进程内工具通道)。失败在**分派期**就结清且可行动:CLI 解析不到
记 `cursor_cli_missing`,绑定 Agent 缺失/禁用/vendor 不匹配各记自己的原因码 —— 任何
一条都不改写 automation 的 vendor,也不跨 vendor 回退。

## 沙箱

Cursor 注册 arapuca auth profile,与其他宿主 CLI 同路:`createSandboxWrapper` 为它
生成 wrapper,子进程在 arapuca 的允许集内运行。profile 的三项决定:

- **钥匙串**:system 模式下开放 —— 登录态在宿主钥匙串里,没有任何环境变量能替代它。
  带密钥的 agent 不需要它,密钥按名经 `forwardEnv` 转发。
- **数据根**:宿主 `~/.cursor`,rw。沙箱运行写的会话必须与宿主端读的是同一个目录,
  否则沙箱里跑出来的会话在列表里就是不存在的;这也是该 vendor 的 store scope 在
  沙箱与宿主下同解的原因。
- **二进制**:官方安装器把它装进一个按版本命名的目录,并留一个 symlink 指过去,
  两条路径都要可读,否则 exec 会在解析链接目标时失败。两者都只在存在时挂载。

沙箱运行下发 `--sandbox disabled`:arapuca 已经把进程围起来了,再套一层内建沙箱会
在外层已经拿掉的系统调用上失败。没有 wrapper 的沙箱运行则相反,由 Cursor 自带
沙箱兑现隔离。

## 探针结论

准入探针 `scripts/e2e/cursor-cli-probe.mjs` 可复现地验证能力,其结论是本页台账的
唯一事实来源。它需要真实凭据与出网,非 CI 安全,不在 `pnpm e2e` 套件内;无凭据时
判 SKIP 而不是因机制通过就报 GO。

两个**阻断项**:

- **G1 铸出的 id 就是运行身份**:`create-chat` 返回的 id 与运行自报、落盘所用的
  是同一个。不成立则会话身份无法先于首帧确定,`sessionId()` 只能改为等待流。
- **G2 resume 恢复上下文**:第二轮经 `--resume` 记得第一轮建立的暗号。不成立则
  `sessions.resume` 不能标 `full`。

其余为信息项:帧词汇表、运行身份所在字段、终局帧形状、工具调用的判别载荷形状。

## 降级与非目标

已接受的降级:CLI 不接受图片输入,故附图会被显式丢弃并告警,而不是让整轮失败或
让模型收到一个提到图片却没有图片的提示。

非目标:不读取或逆向 Cursor IDE 的私有配置格式(会话库按上面描述的形状读,读不动
即降级);不建设进程内 customTools 工具通道(`inProcessMcp` 恒为 false ——
automation 的 c3 工具同样只经统一的回环 HTTP MCP 路由到达);不冒充 Cursor 可恢复
真相;不由 c3 分发或钉选 `cursor-agent` 版本;不支持 custom/relay 自定义 provider、
逐工具审批、partial streaming、完整 diff/patch、token 用量、subagent 嵌套展示。

## 待探针解锁

任何新增在途控制(如真正的在途 `interrupt`)需先有探针证据,再翻台账。
