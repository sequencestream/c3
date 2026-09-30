# permission-gateway — 数据模型

实体与不变量。行为见 [规格](permission-gateway-spec.md)，协作见 [设计](permission-gateway-design.md)。

## Permission Request

一次到达网关的工具调用所对应的待决问题。关联键是 `requestId`。携带工具名与不透明输入——供人查看；网关不解释输入，人机问答作答除外。

状态：`Pending` → `Allowed` | `Denied`。一旦离开 `Pending` 不能回去。

不变量:

- 同一 `requestId` 至多一条待决。
- 由一次敏感调用产生，至多被一个 Decision 解决。
- 驻内存，不持久化。切走视图不取消它；run 拆除才取消。

## Permission Decision

一次请求的结果：`allow` | `deny`。

来源:

- 人（`permission_response`）
- 运行中止（恒为 `deny`）
- 共识自动裁决（`consensus_auto`）

人机问答的 `allow` 可附带逐题答案；答案不合法则不算一次 Decision，请求仍待决。
