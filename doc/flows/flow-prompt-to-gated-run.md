# Flow — Prompt → Gated Run

**场景。** 用户对当前查看会话提交提示词。智能体跑到结束；敏感工具先共识后人工门控；文本与工具活动实时回传。

**领域。** web-console · session-registry · agent-config · agent-session · permission-gateway。

核心循环。当前查看会话见 [工作区与会话生命周期](flow-workspace-session-lifecycle.md)；断连与故障见 [运行的韧性](flow-run-resilience.md)；从意图启动见 [意图 → 开发](flow-intent-to-development.md)。

## 流程图

```mermaid
flowchart TD
    P[user_prompt] --> R[启动运行<br/>工作目录 · 模式 · resume]
    R --> S[文本流 · 工具活动]
    S --> T{敏感工具?}
    T -- 否 --> S
    T -- 是 --> G[permission-gateway]
    G --> C{共识 | 人工}
    C -- 裁决 --> S
    C -- 回退人工 --> H[permission_request]
    H --> S
    S --> E[完成]
    R -. 团队 .-> TM[lead 保活]
```

## 步骤

1. **web-console → agent-session。** 对当前查看会话发 `user_prompt`。按该会话工作目录、权限模式与 resume 启动运行，提示词回显（`AS-R1`）。启动解析智能体；首次运行绑定真实 id 并冻结厂商（`AC-R4`、`AC-R6`、`AS-R10`、`SR-R7`、`AC-R16`）。
2. **agent-session → web-console。** 文本与工具活动流式扇出，并缓冲供切回重放（`AS-R9`、`AS-R11`）。
3. **敏感工具 → permission-gateway。** 模式判定为敏感则阻塞，恰好一个权限请求（`AS-R5`、`PG-R1`、`PG-R2`）。共识启用且有其他投票者时先表决；形成裁决则自动解决，否则回退人工（`PG-R9`、`PG-R13`）。人回答 `permission_response`；默认拒绝（`PG-R3`、`PG-R4`）。
4. **循环直至完成。** 决议后继续流式，直到该轮结束（`AS-R7`、`AS-R15`）。

## 分支与异常

- **团队 lead 保活。** 使用团队工具则升为团队：lead 轮次间存活，后续 `user_prompt` 推入同一进程，仅显式停止才结束。见 [agent-session](../domains/core/agent-session/agent-session-spec.md) 与 [ADR-0008](../architecture/adr/0008-streaming-input-for-agent-teams.md)（`AS-R14`、`AS-R15`、`AS-R16`、`AS-R17`、`AS-R21`）。
- **会话内串行。** 进行中的 `user_prompt` 拒绝且不启动第二次运行（`AS-R2`）；团队走推入（`AS-R17`）。
- **断连不停止运行。** 关连接或切视图只取消订阅，待决权限仍可回答。见 [运行的韧性](flow-run-resilience.md)（`AS-R6`、`AS-R8`、`PG-R3`）。
- **默认拒绝。** 无显式允许即拒绝；停止运行将待决视为拒绝（`PG-R4`）。
- **无静默敏感执行。** 未经模式授权的敏感工具必须经网关（`AS-R5`，C-SEC-2）。
- **预批准不是 c3 决策。** 厂商规则引擎自行放行只审计，不构成第二条通道（`PG-R12`）。
