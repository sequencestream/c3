# agent-session — 设计

实现[规格](agent-session-spec.md)。本域不拥有厂商 SDK,也不拥有工作区目录;它编排一次运行,并把控制面接到统一协议上。

## 协作

**session-registry** 播种工作目录、每会话模式与 resume id。本域拥有进程级 Session Runtime:运行句柄、回放用的 baseline + buffer、当前 viewers 与状态([ADR 0006](../../../architecture/adr/0006-decouple-runs-from-connections.md))。pending→真实 id 绑定时,buffer、viewers 与在途 run 一起搬到新键上。公开 `c3SessionId` 必须解析到同一原生 runtime,不能另开冷会话。

**permission-gateway** 是敏感工具的阻塞点。具备逐工具审批的厂商(Claude)在回合内把调用交给网关;不具备的厂商(Codex、Cursor)把门控落在启动策略上,审批桥不触发。待决请求跟 run 走,不跟连接走。

**vendor adapter** 是三件套:driver(启动、消息流、中止)、审批桥、会话存储([ADR 0011](../../../architecture/adr/0011-vendor-neutral-agent-abstraction.md))。上层先看能力台账再碰有分歧的控制,不按厂商名分支。Claude 独有流式推入与 team;Cursor 的独有边界见 [Cursor](features/agent-session-cursor.md)。

**agent-config** 提供启动覆盖与同厂商候选。降级链与手动切换共用那条同厂商规则;失败在内核事件总线上旁路发布,供 automations 等订阅,不插入运行循环。

**web-console** 是视图。服务端对非 team 会话严格执行单 turn;控制台用客户端排队向用户隐藏这次拒绝。图片附件可进入各厂商路径;非图片媒体整 turn 拒绝。Cursor 不接受图片,见 Cursor 文档。

## 关键取舍

**运行活在进程里,不活在连接上。** 切走或刷新必须能回到同一条流。代价是 runtime 占用进程内存、暂无淘汰;当前规模可接受。

**流式输入,而不是一次性字符串。** 字符串 prompt 在结果到达时结束进程,team lead 会在队友回来之前死去,运行中途的改模式与中止也会被吞掉。统一用流式输入:非 team 在结果处关掉输入,复现一次性退出;team 保持打开,只在明确停止时关闭([ADR 0008](../../../architecture/adr/0008-streaming-input-for-agent-teams.md))。

**c3 自己的工具走回环 MCP,不走进程内通道。** 每次运行绑定一条回环 HTTP 路由,按厂商译成各自的远程 MCP 配置,结束时释放。厂商子进程必须能直达该回环;若被 HTTP 代理拐走,工具会从模型工具集里静默消失。需要长期本地 MCP 进程的厂商另有监督者(独立进程组、健康检查、有界重启);宕机是临时不可用并自我修复,不是把该厂商标死。

**宿主 CLI 是第一道能力门。** 解析不到二进制,该 agent 类型不可用,而不是运行到一半再失败([ADR 0012](../../../architecture/adr/0012-host-binary-probe-first-capability-gate.md))。c3 不分发 Cursor 的 CLI([ADR 0040](../../../architecture/adr/0040-cursor-as-host-cli-vendor.md))。

## 中止

停止关闭流式输入(这是结束 team 的唯一方式),并中断在途 turn。对已经结束或尚未开始流的运行,中断失败被吞掉,进程不崩溃。切换视图与关闭 socket 不走这条路径。

## 非功能

每会话至多一个在途 run;跨会话无上限。错误必须终结为可见的 `turn_end`,不得挂起。运行与权限状态驻内存,不持久化;会话连续性来自厂商转录上的 resume,工作区/会话目录由 session-registry 持久化。
