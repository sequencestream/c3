# permission-gateway — 设计

实现[spec](permission-gateway-spec.md)。一个待决决策的注册表，加上一个敏感工具
回调，用于发起请求并传递该次运行的取消信号。

## Data model

仅驻内存，作用域限于服务器进程:

| Structure         | Shape                                       | Purpose                             |
| ----------------- | ------------------------------------------- | ----------------------------------- |
| Pending approvals | 一个从 `requestId` 到一次性 resolver 的映射 | 每个 Pending 请求一条(PG-R1、PG-R2) |
| Decision          | `allow` \| `deny`                           | 结果值                              |

## Decision flow

```mermaid
sequenceDiagram
    participant SDK
    participant GW as sensitive-tool callback
    participant REG as pending registry
    participant WS as WebSocket
    participant UI as browser

    SDK->>GW: tool wants to run (toolName, input)
    GW->>GW: mint a unique requestId
    GW->>WS: send permission_request{requestId,toolName,input}
    GW->>REG: wait for decision (requestId, cancellation signal)
    REG->>REG: on abort → delete entry, resolve as deny
    REG->>REG: register the pending resolver under requestId
    Note over REG: blocks indefinitely — no timeout
    UI->>WS: permission_response{requestId, decision}
    WS->>REG: resolve the pending decision
    REG->>REG: remove abort listener; delete entry; resolve(decision)
    REG-->>GW: decision
    alt allow
        GW-->>SDK: allow with the original, unchanged input
    else deny / abort
        GW-->>SDK: deny with message "User denied in c3 UI"
    end
```

## Key capabilities

| Capability   | Contract                                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 等待一个决策 | 注册一个 resolver 并返回一个在决策解出时 resolve 的 promise。永远不会自行解出——它会阻塞直到匹配的响应到达，或直到取消信号触发 abort(删除条目，以 deny 解出)。恰好解出一次。实现 PG-R2、PG-R3、PG-R4。 |
| 解出一个决策 | 解出一个待决请求。对未知/过期的 id 是空操作(PG-R5)。                                                                                                                                                  |
| 待决计数     | 在途请求计数；供测试/诊断使用。                                                                                                                                                                       |

## Technology choices

- **一个阻塞 promise 加一个取消信号**，而非调度器/队列:网关始终只为一个本地用户
  持有少量并发请求。请求会无限期阻塞(类似 CLI 提示);运行的 abort 信号是唯一的
  非用户解出路径。理由为非正式记录;无需 ADR。
- **一个密码学随机 UUID** 作为请求 id——一个无碰撞的关联键。
- **无依赖注册表。** 该注册表不导入任何 SDK 代码，因此可被独立单元测试。
- **allow 时保留原始输入**——网关原样返回提议的输入(PG-R6);它不是一个输入
  重写层。

## Non-functional considerations

- **延迟:** 唯一增加的等待是人类决策——按设计是无界的，与 CLI 的阻塞式提示
  一致(PERF-2)。
- **安全:** abort 时与过期 id 时默认拒绝(SEC-5);无输入修改。
- **内存:** 每条解出路径都会删除该 map 条目并移除 abort 监听器——即便在提示
  过程中运行被中止，也不会泄漏待决条目或监听器。

## Dependencies

- **Inbound:** agent-session 调用该回调并提供发送通道。
- **Outbound:** 除平台的加密源外没有其他依赖。降级:如果发送失败，请求会一直
  待决，直到用户中止该运行(此时会被解出为 deny)。
