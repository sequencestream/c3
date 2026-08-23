# 0049 — IM 身份绑定与调用级工作区作用域

- **Status:** accepted
- **Date:** 2026-08-22

## Context

IM 机器人是部署级入口。外部 `senderId`、连接、线程或机器人目录都不能推出 c3 账号与工作区权限。
若不先建立显式身份绑定与逐次求交，跨工作区 L1 只读、主动播报与受控写入都会把台账内容暴露给未绑定者或共享群上下文。

外部 MCP（ADR-0044）已用连接级 `X-C3-Workspace` 钉定单一工作区。机器人若复用同一语义，会把一次上下文选择变成隐形长期授权；若在 run 启动时计算一次 scope 整轮复用，中途撤权仍可能读到旧范围。

## Options considered

- **A. 从 IM 显示名 / 邮箱自动匹配 c3 账号** —— 被否决。可变字段、跨租户撞名、冒用成本低。
- **B. 群成员名册即信任域，个人 scope 可替代群白名单** —— 被否决。群不是 c3 授权源；个人可见不等于群内可播报。
- **C. 连接或线程钉定工作区（镜像 MCP）** —— 被否决。钉定会把一次选择固化为授权，与机器人跨工作区查询目标冲突。
- **D. run 启动时求交一次，工具调用复用快照** —— 被否决。撤销与 ACL 收窄必须在下一次调用立即生效。
- **E. Web 发起、仅私聊完成的一次性绑定 + 每次工具调用重读求交** —— 采纳。

## Decision

### 平台账号命名空间 → c3 主体

显式绑定：`(platform, providerAccountKey)` 命名空间内的外部 `senderId` ↔ c3 `AuthorizationSubject`。
飞书命名空间为 `platform + appId`（`open_id` 仅应用内稳定）；同一应用下多机器人共用绑定，不以机器人记录 id 划身份边界。一个命名空间内 active 外部身份与 active subject 均唯一；变更须先 Web 撤销再重新挑战，验证码不可抢占。

无认证部署沿用 trusted-local：唯一 `local` 主体可见全部已注册工作区；同命名空间内首个完成绑定者独占，第二人得统一唯一性冲突失败。多人部署须先启用 basic auth。

### Web → 私聊绑定链

挑战由已认证 Web 连接解析出的 subject 发起（客户端不可声明 subject）；目标机器人须存在、已启用且已外发确认。令牌 ≥128 bit 熵，明文仅挑战成功响应回显一次，库内只存哈希，10 分钟 TTL，同 subject+命名空间新建会使旧 pending 失效。

私聊提交完整令牌走确定性控制路径（不进模型 / Conversation / Context Turn）；群内同文不查询不消费挑战，只回「请在私聊完成」。未绑定者只得固定绑定引导，不启动 run、不读台账、不存正文。失败原因统一，并按机器人+发送者限速。

`binding_notice` 在 `chatType = p2p` 时仅豁免 `dmMode`/`dmAllowlist`，且 `chatId`/`senderId`/`replyTo` 必须来自触发控制流的原始私聊，内容只能引用固定 notice id。

### 调用级求交

`robot-mcp` 绑定不携带已授权 `workspacePath`。每次 L1 handler 与管理员显式勾选的机器人 c3 MCP 写 handler 重读 active binding、subject、`user_workspace_scopes`、群白名单与 `auth.policyEpoch`，求交：

```
详细可见 = 个人 scope ∩（私聊？全集 : 群白名单）
```

对象型工具先按对象 id 反查候选 `workspaceName`，只有候选位于详细可见集且仍能由注册表解析时才取得路径；不存在 / 越权 / 群外均返回相同 `{ code: "not_visible" }`。列举型在个人全部有效 scope 内按注册顺序合并，每项带 `workspaceName`；群内仅返回交集明细，群外匹配只允许总 `hiddenCount`（或通用「存在群外结果」标志），不得带对象标识。新建型写工具必须显式给出详细可见的 `workspaceName`，不得隐式选择唯一工作区。

群白名单默认空；`chatAllowlist` 只决定是否响应，不是数据可见白名单。机器人运行根永远不是台账候选工作区。外部 MCP 继续连接级钉定，二者不得共用「连接选中工作区」语义。

### 会话键与发送前复核

Conversation 身份含 `(platform, robotId, threadKey, senderId, bindingId, subject, scope_hash)`。
`scope_hash` 是对规范化授权版本（subject、binding version、`policyEpoch`、聊天类型/群身份、当次详细可见工作区集）的不可逆摘要，非权限凭据。绑定、撤销或 epoch 推进切断旧上下文；集合后来恢复也不接回。

工具调用发现授权版本相对本轮起点变化则失败关闭并记 `scope_changed`。最终外发前再算一次：已撤权只发绑定引导；仍绑定但 scope 变则发固定「权限已变化」提示；均丢弃 agent 文本与原生会话缓存，不提交 Context Turn。

## Consequences

- 升级后所有 IM 发送者未绑定；不自动回填。
- 全局 `policyEpoch` 会使无关编辑切断更多机器人上下文（有意取舍）。
- 绑定消费与平台投递非同一事务：库提交为准，确认消息失败不回滚绑定。
- 旧四维 Conversation / Context Turn 安全切断，不复制到新主键。
- 管理员勾选机器人 c3 MCP 写工具会授予真实写能力；风险由默认不勾选、服务端按勾选子集注册、逐调用作用域与领域业务门共同承担。`save_intents` 另保留用户文字确认。

## Compliance

- 身份挑战、绑定、群范围、审计表与 `im_robot_threads` / `im_robot_context_turns` / `im_robot_turns` 迁移同边界幂等收敛。
- `ImTurnOutcome` 含 `identity_required` / `scope_changed`。
- 测试覆盖冒用绑定、逐调用 scope 变化、多工作区枚举、对象反查、群成员更替、上下文隔离与探测，并逐项覆盖六个机器人写工具的勾选注册、未勾选直调拒绝、跨工作区拒绝与零副作用。

## References

- [0044](0044-external-mcp-owner-scope-and-unified-endpoint.md) — 外部 MCP 连接级钉定（并列、不共用）
- [0046](0046-im-robot-outbound-authorization.md) — 出站授权与审计
- [0048](0048-robot-im-context-as-bounded-local-persistence.md) — 发送者隔离上下文（本 ADR 扩展归属维）
