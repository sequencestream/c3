# agent-session — Cursor vendor

实现规则见 [agent-session-spec](../agent-session-spec.md);厂商中立抽象见
[ADR-0011](../../../../architecture/adr/0011-vendor-neutral-agent-abstraction.md)、
二进制解析见 [ADR-0012](../../../../architecture/adr/0012-host-binary-probe-first-capability-gate.md)、
会话归属见 [ADR-0015](../../../../architecture/adr/0015-session-agent-binding-vendor-ownership.md)、
store scope 见 [ADR-0030](../../../../architecture/adr/0030-session-store-scope-vendor-neutral-data-root.md)。

Cursor 是 c3 驱动的第三个厂商,与 Claude、Codex 同质地落在厂商中立的三件套
(driver / approval / session-store)与能力台账上。唯一运行载体是用户自行安装
并完成登录的 `cursor-agent` CLI,以 `-p --output-format stream-json` 做单次
非交互运行;c3 负责规范化事件流、镜像展示历史、管理进程,但 **Cursor 自身保存
的上下文才是恢复真相**。

## 运行载体与二进制

Cursor 的二进制描述符是 **external**(区别于 Claude/Codex 的 managed):c3 不
从 npm 下载、不做远程版本选择、不做历史清理。解析链只有两级:`$CURSOR_AGENT_PATH`
显式覆盖 → 宿主 PATH 上的 `cursor-agent`。版本兼容按 **calver** 判定(Cursor 用
`YYYY.MM.DD-<sha>` 日历版本,没有 semver 区间可言):低于已验证下限的版本在解析
阶段即被判为不可用,设置页据此给出"自行安装 / 升级"的可操作提示,而不是在运行
深处对着未验证的流格式失败。

## 厂商接口契约

- **driver**:每次 `start()` 起一个独立子进程组(`detached`,使 CLI 成为进程组
  组长),读 stdout 上的 NDJSON。`sessionId()` 在流报告首个原生 chat id 前保持
  pending;进程在报告 id 前退出或失败则 **reject**,绝不合成替代 id(合成的 id
  日后会被交给 `--resume`,要么报错、要么误挂到他人会话)。续聊把 c3 会话绑定的
  原生 id 原样传给 `--resume`。`abort()` 向整个进程组发信号(SIGTERM → 宽限后
  SIGKILL)并等待子进程退出,确保 CLI 拉起的工具(如长跑 shell)不成为孤儿。
- **approval**:结构性 no-op。`-p` 流是单向只读的,没有"请求批准"事件,也没有
  回写半信道;`onRequest` 满足契约(可注册、可注销)但永不触发。批准被降级为
  启动期一次性策略(见下)。
- **session-store**:c3 自有镜像,**不读** Cursor 的私有存储(`~/.cursor/chats`
  下的 SQLite)。list/read 返回 c3 观察到的规范化消息;rename/delete 不提供。
- **skill**:发现目录为项目级 `<project>/.cursor/skills`,支持度随 CLI 是否在
  场门控。

## 能力台账

八个在途运行控制全部为 `false`,且各有所据:

- `perToolApproval: false` —— 无逐工具批准信道;权限在启动期一次定死。
- `inProcessMcp: false` —— MCP 确已可用,但只能是 CLI 经 HTTP 连接的
  **外部**服务器,不是 c3 进程内承载。
- `taskStore: false` —— 流中没有 todo/task 项可投影。
- `nativeUserInput: false` —— `-p` 运行从不向人发问。
- `interrupt` / `setActionMode` / `streamingPush` / `forkSession: false` ——
  无在途干预点;模式与沙箱在启动期固定;stdin 分发后即关闭;`--resume` 服务于
  中性 resume 语义而非 fork。

`canFormTeam`(依赖 `streamingPush`)因此对 Cursor 为假:Cursor 会话不能成为
agent-team 的常驻 lead。

## 会话能力等级

- `resume: full` —— 原生 `--resume <id>` 端到端恢复上下文,即便上一轮是被中止的
  (探针已证)。
- `list / read: partial` —— 由 c3 镜像服务,只覆盖 c3 亲自跑过的轮次;用户在
  Cursor IDE 或其他客户端产生的历史不在其中。这是真实的缩减,故标 `partial`
  而非 `full`(不夸大)或 `none`(不隐藏入口)。
- `rename / delete: none` —— CLI 不提供;c3 不假装修改不属于自己的存储。

## 流式归一化

规范化器是有状态的(每运行一个实例),遵守 `CanonicalMessage` 的
append-with-id-upsert 契约:

- **文本**按 `model_call_id` 稳定聚合,**累积**重发整段(wire 消费端只切片新增
  后缀,故同一 id 下必须发全量);无 `model_call_id` 的帧按确定性序号合成 id 并
  在 `vendorExtra` 标记来源。
- **thinking** 仅来自原生 `thinking` 帧:`delta` 拼接为单一 thinking 块累积重发,
  `completed` 收束当前 span。**绝不**从文本或事件名启发式伪造 thinking。
- **工具**按稳定 `call_id` 关联(该 id 可含换行,按字面作键,不解析不拆分):
  工具种类取 `tool_call` 下的**包装键**(`readToolCall`/`shellToolCall`/…),
  结果回填到同一 `tool_use` 块的 `result`。不按事件到达顺序配对并发调用;
  无 `call_id` 时按"turn 内原生事件种类 + 确定性序号"合成 id 并标记降级;
  补全事件找不到对应开始帧时单独成块并标 `orphanCompletion`,不误绑到他工具。
- **未知事件 / 原生工具名 / 无法表达的富消息**完整保存在 envelope 或 block 的
  `vendorExtra`,不丢弃也不伪造。

## 权限与模式

权限策略在运行启动时一次确定,无逐工具交互信道。模式目录只暴露真实可兑现的
**build** 策略:`agent`(build × on-sensitive,沿用用户自己的 `~/.cursor`
allowlist)与 `full-access`(build × never-ask,即 `--force`)。

**`plan` 显式不可用**:目录中不提供 plan 令牌;且 driver 对任何中性
`ActionMode === 'plan'` 的运行**直接拒绝启动**(`CursorUnsupportedError`),
而非静默降级成可写模式。CLI 虽有 `--mode plan` 只读面,但其"绝不改动"尚未被
探针证明,故暂不开放。

## 工具清单与风险

`listTools()` 向 `freezeTools()` 提供 CLI 构建中证实存在的原生工具静态表,每项
归入六个中立类别之一:`read` / `search` / `edit` / `execute` / `network` /
`meta`;另附自检可达的 MCP 命名空间前缀(保守按 write)。风险归一化先按已知
类别,工具名未命中规则时保持 `unknown-tool` 并 **fail-closed**——未知工具永不
因前缀近似而默认放行。

## MCP 注入与自检

c3 的回环 HTTP MCP 服务器被注入 **数据根**的 `mcp.json`(`~/.cursor/mcp.json`),
而非项目级 `.cursor/mcp.json`——后者会污染用户仓库。注入**合并**用户已有的
服务器,并在运行结束后**还原**先前内容(若本不存在则删除),既不覆盖用户配置,
也不残留 c3 的临时项。注入后以 `cursor-agent mcp list` **自检可见性**:某个必需
服务器对 CLI 不可见(注入失败)即 **hard-fail**,运行不启动;`--approve-mcps`
负责运行期的批准。

## 认证与数据根

Cursor 的登录凭据在 **操作系统钥匙串**(macOS 登录钥匙串的
`cursor-access-token` / `cursor-refresh-token`),**不在** `~/.cursor` 内。
数据根恒为 `$HOME/.cursor`,CLI 无任何覆盖环境变量。沙箱 profile 因此必须同时
做两件事:挂载并持久化**整个** `~/.cursor` 数据根(rw),以及开放钥匙串访问
(`allowKeychain`)——只挂数据根而不给钥匙串,沙箱内会报"未登录"。Cursor 是
仅 system-auth 的厂商:无 relay、无自定义 provider 三元组,其 agent 配置形状为
**空**且 `configMode` 恒为 `system`(schema 拒绝携带 baseUrl/apiKey 的 custom
配置)。

## 探针结论

准入探针脚本 `scripts/e2e/cursor-cli-probe.mjs` 可复现地验证各项能力,其结论是
本能力台账的唯一事实来源。两个**阻断项**均为 GO:

- **SIGTERM 续聊**:向进程组发 SIGTERM 中止一轮后,`--resume <id>` 仍能续聊并
  恢复上下文。
- **数据根持久化**:在隔离 HOME(持久化整个 `~/.cursor` + 钥匙串访问)下,同一
  chat id 仍能续聊;chat 数据确实落在被持久化的数据根内。

MCP 条件门槛亦通过:注入 + `mcp enable` 后 `mcp list` 报 `ready`,`-p` 运行真实
调用到注入的 MCP 工具——故 Cursor **可**参与依赖 c3 MCP 的 intent/spec 流程,
无需条件降级。探针同时固定:calver 兼容下限、认证落点(钥匙串)、无稳定会话
列表子命令(list/read 走 c3 镜像)、工具稳定 `call_id`、六类原生工具包装键、
`--mode` 仅 plan/ask(build 为默认无标志)。

## 降级与非目标

已接受的展示降级:c3 镜像可能与 Cursor 原生记录漂移(用户 elsewhere 的运行不在
镜像中)——这只影响列表/回放展示,`resume` 始终以 Cursor 原生上下文为准,故
漂移不改变恢复来源。

非目标:不经 `@cursor/sdk` 运行;不读取或逆向 `~/.cursor/chats` 私有库;不冒充
Cursor 可恢复真相;不支持 custom/relay、自定义模型、逐工具审批、用户 `hooks.json`
修改、Cursor IDE 历史同步、partial streaming、完整 diff/patch、token 用量、
subagent 嵌套展示、自动托管安装、automation 执行、真正的 plan 模式。Cursor
automation 无执行路径,会在调度期 hard-fail,而非借道 Claude 引擎。

## 待探针解锁

以下能力在相应探针证明后才开放,此前保持关闭:

- **plan 模式**:需探针证明 `--mode plan` 端到端绝不改动,方可在模式目录加入
  plan 令牌并解除 driver 的 plan 拒绝。
- **会话 list/read 升级**:若未来出现稳定的非交互会话列表/读取通道,可把
  `partial` 升为 `full`(仍不读私有库)。
- 任何新增在途控制(如真正的在途 `interrupt`)需先有探针证据,再翻台账。
