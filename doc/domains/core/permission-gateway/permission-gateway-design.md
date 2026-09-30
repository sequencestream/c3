# permission-gateway — 设计

实现[规格](permission-gateway-spec.md)。本域不拥有运行，也不拥有浏览器；它是敏感工具与人类（或共识）之间的阻塞点。

## 协作

**agent-session / Session Runtime.** 运行把到达网关的敏感调用交给本域，并提供推送通道与该 run 的取消信号。待决请求跟 run 走，不跟连接走（[ADR 0006](../../../architecture/adr/0006-decouple-runs-from-connections.md)）：切走视图或关闭 socket 不解决、不拆除请求；回到该会话仍可按 `requestId` 作答。只有停止、删除会话或移除工作区才走中止 ⇒ `deny`。

无逐工具审批的厂商把门控落在启动策略上，调用到不了本网关。Cursor 的人机问答接到同一对 `permission_request` / `permission_response`，见 [Cursor](../agent-session/features/agent-session-cursor.md)。

**web-console.** 消费 `permission_request` 与 `consensus_auto`，回 `permission_response`。控件如何排布由控制台拥有。

**workspace-setting.** 按工作区提供共识旋钮。网关用工作区根读取配置，不用本次运行的工作目录——worktree 与项目根不同时，按运行目录读会静默关掉共识。

## 关键取舍

**待决活在进程里，绑在 run 上。** 刷新或换连接必须还能回答同一个问题。代价是注册表占用进程内存、不持久化；进程退出即丢失待决（运行本身也在拆）。当前规模可接受。

**无限期阻塞，而不是超时自动拒绝。** 与 CLI 提示一致（[C-SEC-3](../../../constitution.md)）。唯一的非用户解出路径是 run 被拆除。推送失败时请求保持待决，直到中止（仍为 deny）。

**网关不是唯一权威。** 继承规则与厂商预批准可以在浏览器看不见的情况下放行（[ADR 0005](../../../architecture/adr/0005-inherit-user-project-settings.md)）。c3 保证的是：凡到达本网关且未被共识合法裁决的，默认拒绝。

## 非功能

人工等待无界。每一条解出路径都必须清掉待决，中止也不泄漏。运行与权限状态驻内存，不持久化。
