# external-mcp — 设计

实现[规格](external-mcp-spec.md)。本域拥有公开 MCP 入口的求交与钉定，不拥有主体范围、钥匙存储或工具业务语义。

## 协作

**auth.** 提供主体范围与全局 epoch。每次调用向该域求解，本域做三层求交与会话钉定。不复制 AUTH-R\*。见 [ADR-0044](../../../architecture/adr/0044-external-mcp-owner-scope-and-unified-endpoint.md)。

**内部 MCP.** 并列。内部面用回环与 per-run 令牌，作用域来自 run 闭包，比账号求交更严。不把内部路由并进本模型。

**intent-management / discussion / delivery.** 工具行为在那些域。本域只提供目录、勾选与调用卡口。

**system-setting.** 钥匙哈希与监听。本域校验出示的钥匙，不拥有落盘。

**personalized-setting.** 持有者自助新建、重置、吊销。本域不提供管理面。

**workspace-setting.** 只读展示求交结果。不是授权入口。

**session-registry.** 工作区名称是求交输入。

## 关键取舍

**统一裸路径，凭据走头。** 路径含钥匙会进日志与历史，且令牌不得出现在 URL。双跑会漂移。见 [ADR-0044](../../../architecture/adr/0044-external-mcp-owner-scope-and-unified-endpoint.md)。

**工作区用应用层头，不用 query 或工具入参。** query 进日志；入参把作用域交给调用方。代价是不支持自定义头的客户端不可用。

**epoch 全局。** 一次无关编辑会断开无关客户端；换来的是可审计的新鲜度，不必让每个变更点判断「动了谁」。

**显式目录，不继承内部全集。** 新增内部工具默认不外泄。

**写授权替代对话确认。** 外部无人值守没有对话方。勾选只跳过确认，不放宽业务校验。

**审计不含入参。** 入参可含正文与秘密；审计要的是归因，不是重放。
