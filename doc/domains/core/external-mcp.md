# Domain: external-mcp

- **Group:** core
- **One-line:** 向外部智能体和自动化暴露受工作区授权约束的 MCP 能力。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [auth](auth.md)（主体范围与 policy epoch）；[session-registry](session-registry.md)（工作区身份）。工具行为由意图、讨论、交付各域拥有。
- **Depended on by:** [personalized-setting](../settings/personalized-setting.md)（钥匙自助）；[system-setting](../settings/system-setting.md)（钥匙存储）；[workspace-setting](../settings/workspace-setting.md)（只读访问一览）。
- **exposes-api:** true — Streamable HTTP `POST /mcp`。协议对齐见 [mcp](mcp.md)。
- **ADRs:** [0044](../../architecture/adr/0044-external-mcp-owner-scope-and-unified-endpoint.md) 求交、统一端点与会话钉定

本域拥有 c3 对**未拉起的 agent** 的唯一公开 MCP 入口。不拥有主体范围、钥匙存储或工具业务语义。工作区范围见 [auth](auth.md#工作区范围-user_workspace_scopes)，不复制 AUTH-R\*。

## Overview

external-mcp 是 c3 对**自己没有拉起的 agent** 开放的唯一入口：独立的厂商会话、CI、脚本与局域网进程，凭长期钥匙经 Streamable HTTP 访问本部署，并在管理员授权下写回。

**范围:** 公开 MCP 入口、每次调用的求交与钉定、可外部授权工具目录、写调用审计。
**边界:** 不拥有主体与工作区范围（[auth AUTH-R11](auth.md)）；求交含该范围（[AUTH-R12](auth.md)）。不拥有钥匙存储与哈希（[system-setting](../settings/system-setting.md#外部-mcp-api-key-存储-mcp_api_keys)）；不拥有钥匙自助（[personalized-setting](../settings/personalized-setting.md)）；不改内部 MCP 的信任模型。工具行为由意图、讨论、交付各域拥有。协议层对齐见 [mcp](mcp.md)。

## Business rules

### 请求与授权链

内部 MCP 与本域**并列，不是放宽**。内部面保留回环与一次性 per-run 令牌，作用域来自 run 闭包；本域用长期钥匙与账号求交。内部语义不受本域影响（[ADR-0044](../../architecture/adr/0044-external-mcp-owner-scope-and-unified-endpoint.md)）。传输形态相同，见 [规范对齐](#规范对齐)。

- **单一路径。** 入口恒为裸 `POST /mcp`。路径上任何后缀都不存在，不是兼容路由。凭据不进 URL、不进 query。
- **只认授权头。** 长期钥匙只从 `Authorization: Bearer` 读取。其它自定义凭据头与 query 不被解析。Web 登录会话与内部 per-run 令牌不能替代它。
- **凭据先于工作区。** 未通过认证不得解析工作区。拒绝不回显钥匙或授权头的值；失败形态不泄露「钥匙是否存在」或「工作区是否存在」。
- **出示即校验。** 授权头存在但值为空，仍算已出示，不进免凭据路径。打错的钥匙不降级为全权。
- **唯一卡口。** 每次调用按主体、工作区与工具名重新求交，得到当次冻结范围。目录不闭包任何范围。业务处理只接受这次求解的结果，拿不到调用方给的路径。
- **三层求交。** 有效工作区 = 钥匙自身范围 ∩ 归属账号的 [工作区范围](auth.md#工作区范围-user_workspace_scopes)（钥匙自身范围恒为全部已登记工作区，故账号范围是限制集）。有效工具 = 钥匙勾选 ∩ 可外部授权目录。缺范围、无法解释的模式、注册表已无的名称、名册不认识的归属，一律空集。与 [AUTH-R12](auth.md)、[C-SEC-3](../../constitution.md) 同向：缺失不是放行。
- **发现与执行同一次求解。** `tools/list` 与调用检查出自同一结果；未授权的名字不可调用。列表变更通知只是体验，不构成授权或新鲜度边界。

工作区在 initialize 时选定（`X-C3-Workspace`），并就此钉死该会话。该头是 c3 应用层选择，不是 MCP 协议字段。不支持自定义头的客户端用不了本端点，且不提供 query / path / body / 工具入参兜底。后续请求重复同一工作区是正常的；换成另一个是重定范围尝试，拒绝且不动会话。

会话钉在钥匙、密钥版本、该工作区与全局策略世代上。每个请求重新认证再比对。换一把钥匙复用同一会话身份，或密钥 / 策略世代变化，均使该会话失效。策略写入与世代推进同事务提交后才清连接；清理失败由逐请求比对兜底，不恢复旧权限。世代由 [auth](auth.md) 推进，一次策略编辑可断开全部外部会话。

### 本机与暴露

- 无管理员关卡（[AUTH-R1](auth.md)）且对端为回环时，统一端点默认可全部已登记工作区与全部可授权工具，合成主体 `local`。已出示的凭据仍须校验通过。非回环无凭据一律拒绝。
- 绑定非回环且未配置管理员时，整面拒绝并引导配置管理员或改回回环；回环请求同样不建会话。
- 监听默认回环、显式开放才对外，属 [system-setting](../settings/system-setting.md)，本域不改。

### 工具目录

服务端维护一份**显式**可外部授权目录，不是从内部工具全集做排除。新增内部工具不会自动外泄；进目录须声明读 / 写。读不改台账、讨论、规格或会话生命周期；写会。`publish_event` 属读：投递事实，envelope 的工作区与来源由钥匙绑定生成。

- **默认可调（读）：** `find_intents` `view_intent` `find_discussions` `view_discussion` `publish_event` `list_workspaces` `whoami`
- **可授权、默认不给（读）：** `find_deliveries` `view_delivery`
- **可授权、默认不给（写）：** `save_intents` `save_intent_directly` `submit_spec_review` `start_session_for_intent` `start_discussion` `continue_discussion`

目录与默认集解耦：「可被勾选」与「新钥匙自动获得」是两件事。默认集只含读；写永不因疏漏落进初值。交付侧无写工具进目录。PR 状态回填不在目录中。目录外的名字与空勾选都授予零；空不是通配。编辑只接受目录内名称，未知或重复使整次更新失败。客户端伪造的默认值被忽略。

工具行为复用各域既有核心，不绕过意图状态、规格审核或会话启动闸门。差别只在绑定与授权源：`save_intents` 在外部无人值守时，管理员勾选即替代对话确认，不放宽业务校验（见 [intent-management](intent-management.md)）。`submit_spec_review` 外部没有启动时刻，结论绑调用当时的规格内容。明确不注册其余内部写工具、资源面与提示面。

### 目标与自检

写工具可带当次目标工作区，只改这一次调用，不改会话钉定；取值必须落在可见集内。读工具不接受该入参。按工作区拆工具名会把授权判定散开，因此不采用。

带 id 的写先核对该记录不可变的工作区归属，发生在任何落库、广播、事件与会话拉起之前。不符即拒绝，**绝不**静默改到 id 真实归属处。范围内找不到与越权工作区的拒绝互不泄露「别处是否存在」。

`list_workspaces` 只返回有效范围内的名称，永不含磁盘路径。`whoami` 回显非秘密的身份与边界（钥匙、归属、本会话工作区、可访问工作区、可调工具），不含密钥、哈希、认证头或路径。两者与调用卡口用同一批解析。

来源由服务端派生。调用方不能声明 c3 的来源；事件 envelope 取校验后的工作区，载荷里的工作区 / 会话 / 来源字段只作数据。`save_intents` 剥掉调用方传入的会话回链。

### 写调用审计

每一次已知写工具的调用尝试落一行，含非秘密钥匙、归属、判定所用工作区、工具名与结果。三态：未进业务（授权、参数或归属拒绝）、进了但失败、完成。未授权与越权同样记——探测不得成为唯一不留痕的行为。未知工具名不算写工具。

行内不含入参、工具输出、授权头、密钥与哈希。先定业务结果，等这一次审计写入尝试完成再回响应。审计不进业务事务：落库失败保持原结果、不重试该调用，但须发出只含非秘密元数据的运维错误。表见 [database/tables.md](../../../database/tables.md) 的 external-mcp 模块。不提供审计查询界面。读调用不入审计。

### 规范对齐

与内部面同一 Streamable HTTP 传输。差距与协商版本见 [mcp](mcp.md)，本文不复述。

### 接受的限制

- 不内建也不强制 HTTPS。明文下同网可嗅探授权头；远程暴露由使用者自管 TLS 并抑制敏感头日志。
- 不提供发现端点，不提供逐次写操作二次确认，无速率限制。
- 不支持要求 OAuth 授权服务器的自定义连接器。
- 拒绝与成功均不输出钥匙明文。明文只在生成响应里出现一次，见 [system-setting](../settings/system-setting.md#外部-mcp-api-key-存储-mcp_api_keys)。

## Domain events

入口为 Streamable HTTP，不经 WebSocket。钥匙自助消息属 [personalized-setting](../settings/personalized-setting.md)。

## 协作

**auth.** 提供主体范围与全局 epoch。每次调用向该域求解，本域做三层求交与会话钉定。不复制 AUTH-R\*。见 [ADR-0044](../../architecture/adr/0044-external-mcp-owner-scope-and-unified-endpoint.md)。

**内部 MCP.** 并列。内部面用回环与 per-run 令牌，作用域来自 run 闭包，比账号求交更严。不把内部路由并进本模型。

**intent-management / discussion / delivery.** 工具行为在那些域。本域只提供目录、勾选与调用卡口。

**system-setting.** 钥匙哈希与监听。本域校验出示的钥匙，不拥有落盘。

**personalized-setting.** 持有者自助新建、重置、吊销。本域不提供管理面。

**workspace-setting.** 只读展示求交结果。不是授权入口。

**session-registry.** 工作区名称是求交输入。

## 关键取舍

**统一裸路径，凭据走头。** 路径含钥匙会进日志与历史，且令牌不得出现在 URL。双跑会漂移。见 [ADR-0044](../../architecture/adr/0044-external-mcp-owner-scope-and-unified-endpoint.md)。

**工作区用应用层头，不用 query 或工具入参。** query 进日志；入参把作用域交给调用方。代价是不支持自定义头的客户端不可用。

**epoch 全局。** 一次无关编辑会断开无关客户端；换来的是可审计的新鲜度，不必让每个变更点判断「动了谁」。

**显式目录，不继承内部全集。** 新增内部工具默认不外泄。

**写授权替代对话确认。** 外部无人值守没有对话方。勾选只跳过确认，不放宽业务校验。

**审计不含入参。** 入参可含正文与秘密；审计要的是归因，不是重放。
