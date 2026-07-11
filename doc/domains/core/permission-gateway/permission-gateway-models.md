# permission-gateway — 数据模型

网关的实体定义。类型是业务语义层面的；物理表示见
[permission-gateway-design.md](permission-gateway-design.md)。

## Permission Request

关于一次工具调用的单个待决问题。

| Attribute   | Type        | Description                                       |
| ----------- | ----------- | ------------------------------------------------- |
| `requestId` | text (UUID) | 该请求的唯一关联键                                |
| `toolName`  | text        | 智能体想要运行的工具名称(例如 `Write`、`Bash`)    |
| `input`     | opaque      | 工具提议的输入，原样透传用于展示                  |
| state       | enum        | `Pending` → `Allowed` \| `Denied`(见 spec 状态机) |

Relationships: 由一次敏感工具回调调用产生；至多由一个 Permission Decision 解决。

## Permission Decision

一次请求的解决结果。

| Attribute  | Type | Description                                                  |
| ---------- | ---- | ------------------------------------------------------------ |
| `decision` | enum | `allow` \| `deny`                                            |
| source     | enum | `user`(浏览器响应) \| `abort`(运行被终止) \| `timeout`(环外) |

Relationships: 每个 Permission Request 至多一个 Decision(spec 不变式)。`abort`
来源总是携带 `deny`。`timeout` 来源**仅存在于环外厂商**——未被回答时超时归于
`deny`，而不是永远挂起。环内 Claude 路径没有 timeout 来源——其请求无限期等待
(PG-R2)。

### 厂商回写(仅限环外，2026-06-06-003)

对于环外厂商，中立的 `allow`/`deny` 会被转译为该厂商的原生响应:`allow` → "allow
once"，`deny` → "reject"("always allow" 形式不使用)。回写时收到结构化的
"permission not found"(404)意味着该 id 已过期失效，视为已解决。

## Notes

- 这些实体是瞬态且驻内存的；不做持久化(SEC-2)。
- `input` 在域边界处是不透明的，网关永远不会解释或修改它(规则 PG-R6)。
