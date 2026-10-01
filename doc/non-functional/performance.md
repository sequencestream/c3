# 非功能需求 — 性能

c3 的性能目标是响应速度与有界等待,不是吞吐量。端到端延迟由模型与宿主 CLI 主导;本页只约束 c3 自身不额外拖延。

## 需求

- **PERF-1**: 权限请求一经到达控制台立即渲染,不人为延迟。
- **PERF-2**: 权限等待只受限于人;无超时,c3 不加延迟。见 [AVAIL-2](availability.md)。
- **PERF-3**: 助手文本与工具活动随到随转,不攒批。
- **PERF-4**: 中止在收到停止类消息时同步发出,不排队到下一轮才生效。见 [AVAIL-4](availability.md)。
- **PERF-5**: 会话之间并发、无固定上限;同一会话串行。见 [agent-session](../domains/core/agent-session/agent-session-spec.md) AS-R2。

进行中的会话再发 `user_prompt` 被拒绝,不合并、不中止当前轮(AS-R2)。权限等待无界是设计,不是性能缺口。
