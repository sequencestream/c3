# Domain: im-robot

- **Group:** core
- **One-line:** 把智能体能力延伸到办公 IM:群里提问、无人值守跑一轮、最终回答发回群;部署级出入口,外发只经唯一出站守卫。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [auth](auth.md)(主体与工作区范围、policy epoch);[agent-session](agent-session.md)(无人值守回合);[permission-gateway](permission-gateway.md)(机器人闸);[automations](automations.md)(共用工具网格);[agent-config](../settings/agent-config.md)(厂商与智能体);[session-registry](session-registry.md)(工作区身份;机器人会话不进会话页)。
- **Depended on by:** [web-console](web-console.md)(名册、表单、审计与开通);[personalized-setting](../settings/personalized-setting.md)(本人身份绑定)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../shared/api-conventions/websocket-protocol.md)中定义。IM 长连接由平台适配持有,不另开 HTTP,不进外部 MCP 目录。
- **ADRs:** [0046](../../architecture/adr/0046-im-robot-outbound-authorization.md) 外发授权、[0047](../../architecture/adr/0047-robot-local-reads-scoped-to-run-root.md) 运行根只读、[0048](../../architecture/adr/0048-robot-im-context-as-bounded-local-persistence.md) 有界 IM 上下文、[0049](../../architecture/adr/0049-im-identity-binding-and-call-level-scope.md) 身份绑定与调用级作用域

本域拥有部署级 IM 出入口、身份绑定与外发守卫。身份绑定由本人在 Web 发起、私聊完成。工作区范围由 [auth](auth.md) 拥有,每次调用求交,不复制 AUTH-R*。工具网格与 [automations](automations.md) 共用,不复制 SCH-R*。正式术语见[术语表·机器人](../../glossary.md#机器人)。

## Overview

im-robot 把智能体接到办公 IM:已绑定的人在群里提问,c3 在机器人自己的目录里跑一轮无人值守会话,把最终回答发回同一处。这是 c3 唯一一条主动把智能体产出送往第三方云的路径。机器人回答问题,不替代控制台——过程、工具与授权决策仍在 c3。

**范围:** 部署级名册与连接、IM 身份绑定、L0–L3 能力上限、外发授权与唯一出站守卫、无人值守回合、工具权限、响应面与发送者隔离对话、运行诊断、飞书应用开通。
**边界:** 不是工作区资源,不出现在工作区切换器或会话页;不裁定工作区范围;不驱动运行循环;不渲染 UI;不发卡片、不传文件、不做流式改写;不承诺散文级内容安全。

## Business rules

### 部署级出入口

- 配置、连接与名册跨工作区一致。运行目录是隔离工作容器,不是授权范围或默认工作区。工作区、对象与用户权限不得从机器人、连接、线程或原生会话推断。否决按工作区配机器人,以及为连接或线程钉定工作区。
- 平台适配只持连接、解码与投递;是否响应、去重、串行、守卫与审计在中性层,第二个平台继承而非重写。
- 机器人会话不进会话页,见 [SR-R15](session-registry.md)。自动化须显式点名该会话种类才匹配。

### IM 身份绑定

- 本人从已认证 Web 发起挑战,仅私聊消费。未绑定或已撤销只收固定引导,不启动回合,不读 c3 对象。群内出现相同令牌不消费,只提示去私聊。绑定控制可走私聊,不受单聊默认关闭挡住;其余出站约束不变。
- 个人工作区范围由 [auth AUTH-R11](auth.md) 求解。本域在每次涉及 c3 对象的调用上与群白名单求交:私聊取个人范围,群内取交集。群白名单默认空;响应面白名单不是数据可见范围。授权变更推进 policy epoch,切断旧对话恢复。

### 能力上限与外发授权

L0 受控播报 / L1 只读问答 / L2 定向作答 / L3 受控写入是能力天花板,不是总开关。默认停用、启用前确认、只读默认与出站守卫仍生效。

- **L0** 只发已注册事件模板,不含智能体正文;与模型可发的通用事件隔离。默认关闭。
- **L1** 用户发起的只读查询,每次调用重算作用域。
- **L2** 仅对已指定对象与允许答案集合作确定性回应,独立授权,不读取工具勾选。
- **L3** 管理员逐项勾选的账本写工具,加上调用级作用域与领域业务门;未列入的变更仍回 Web。

启用是独立授权([ADR 0046](../../architecture/adr/0046-im-robot-outbound-authorization.md)):默认停用;启用前不可跳过的外发范围确认由服务端校验;仅管理员可创建、修改、启用;每次外发记一行元数据。缺凭据或缺确认则拒绝启用。停用永远允许。

### 允许外发的内容

回合结束才外发智能体正文。执行中只发已注册固定进度提示,不进后续上下文。工具调用、工具结果、中间推理、文件内容、会话转录与未注册自由文本一律不外发。固定提示来自服务端注册表,不由模型补写。

### 出站与隔离

一切 IM 外发经唯一出站守卫。适配层原始发送只在守卫内可见。守卫或审计不可用时失败关闭,不降级为直发。`@` 只约束入站,不扩大外发目标。发出前拦凭据形状(拒绝不回显命中内容);超平台上限则截断并标明。

本地文件只读运行目录,越界在读到之前拒绝([ADR 0047](../../architecture/adr/0047-robot-local-reads-scoped-to-run-root.md))。每回合进程隔离;隔离失败结束回合,不退化为宿主机裸跑。勾选账本写工具不放开本地可写沙箱。

### 无人值守

群里无人应答授权对话框。面向人的交互工具直接拒绝;观察到授权请求即以 `blocked` 结束,不等待。另有墙钟上限。未列入白名单的一律拒绝。

### 工具权限

与 [automations](automations.md) 共用权限网格,不复制该域规则。创建默认只读;切换厂商清空上一份勾选。本域另有只读工作区名称列举,自动化网格不出现。勾选子集才挂载;未勾选不可调用。

### 响应与对话

群消息默认必须 @ 机器人;单聊默认不响应。同一发送者严格串行、不排队,忙时立即固定提示并以 `busy` 审计,不启动回合。不同发送者可并发。问答成对保留、按发送者隔离;绑定或授权版本变化切断旧上下文。未送达的回答不进可恢复上下文([ADR 0048](../../architecture/adr/0048-robot-im-context-as-bounded-local-persistence.md)、[ADR 0049](../../architecture/adr/0049-im-identity-binding-and-call-level-scope.md))。

每条进入回合的消息以回复或审计原因结束。审计结局:`complete` | `error` | `blocked` | `timeout` | `guard_refused` | `input_rejected` | `identity_required` | `scope_changed` | `busy`。`busy` 不是 `blocked` 或 `error`。

同一条平台消息只受理一次。存储不可用则错误回复并收敛,不启动回合,不降级到扫描目录。入站不可读(非文本、无发送者、其它机器人)静默丢弃,群里不产生噪音。

### 运行诊断

出入站与绑定只记元数据(机器人、聊天类型、发送者摘要、提示键、原因码)。不记正文、不记验证码。

### 飞书应用开通

管理员可扫码新建飞书应用并回填凭据(`start_app_registration`)。开通面向飞书中国区;失败且尚未取得凭据时不写入、不回填。凭据已出但长连接未就绪时,把凭据一次性交还发起连接,供手工补齐,不落库、不广播。取消走 `cancel_app_registration`。

## Domain events

消费 `list_robots`、`create_robot`、`update_robot`、`delete_robot`、`acknowledge_robot_outbound`、`set_robot_enabled`、`list_robot_turns`、`acknowledge_robot_write_capability`、`set_robot_write_grant_enabled`、`get_my_im_identity`、`create_im_identity_challenge`、`cancel_im_identity_challenge`、`revoke_my_im_identity`、`admin_revoke_im_identity`、`list_im_identity_bindings`、`list_im_group_workspace_scopes`、`set_im_group_workspace_scopes`、`start_app_registration`、`cancel_app_registration`。发出 `robots`、`robot_turns`、`my_im_identity`、`im_identity_challenge_created`、`im_identity_bindings`、`im_group_workspace_scopes`、`app_registration_progress`、`app_registration_result`。形状见[共享协议](../../shared/api-conventions/websocket-protocol.md)。

## 数据模型

### Binding

某一平台命名空间内,外部发送者与 c3 主体之间的显式对应。挑战由已认证 Web 发起,仅私聊消费,不进模型。

不变量:

- 同一命名空间内,active 发送者与 active 主体均唯一;变更须先撤销再绑。
- 未绑定只收固定引导,不启动回合,不读 c3 对象。
- 绑定、撤销或 policy epoch 推进切断旧对话恢复;工作区集合后来相同也不接回。
- 群白名单默认空,与响应面名单分属授权与是否应答。

### Robot

部署级聊天机器人:平台连接、执行身份、冻结的工具策略与响应面。身份是名称,创建后不可改——改名等于换一个机器人。

不变量:

- 默认停用。启用须管理员、可连接凭据、以及一次记录在案的外发范围确认。停用永远允许。
- 不持有工作区。运行目录是隔离工作容器,不是授权范围;删除或重建目录不改变对话归属。
- 创建默认只读。连接状态是进程内运行时事实,不落库。
- 群默认须 @;单聊默认不响应。密钥只以「是否已配置」出现在线上,不明文回传。

### Outbound message

允许离开本机的 IM 内容。类别封闭:回合结束的最终智能体文本、已注册固定提示(含进度与绑定引导)、L0 事件模板。一律经唯一出站守卫。

不变量:

- 工具过程、推理、文件与未注册自由文本不外发。守卫或审计不可用则失败关闭。
- 审计只记发生(何时、对谁、多长、结局),不记正文。结局为 `complete` | `error` | `blocked` | `timeout` | `guard_refused` | `input_rejected` | `identity_required` | `scope_changed` | `busy`。
- 可恢复上下文是发送者隔离、成对、有界的持久化例外([ADR 0048](../../architecture/adr/0048-robot-im-context-as-bounded-local-persistence.md)):只存已投递的问答;每对话最多 50 个已提交回合,自提交起最多 30 天;单侧最多 4000 码点。超出硬删除完整回合。凭据形状命中则不存正文。

## 协作

**auth.** 绑定把 IM 发送者映射到主体。每次涉及 c3 对象的调用按该域范围求解,再与群白名单求交。授权变更走 policy epoch,切断旧上下文。不复制 AUTH-R*。

**automations.** 工具网格共用;本域加机器人专属只读列举。不复制 SCH-R*。机器人会话默认不唤醒自动化。

**agent-session.** 无人值守回合复用运行时,种类为 `robot`。授权请求立即结束回合,不在 IM 里等待。缺执行身份则拒绝启动,不给无约束的默认值。

**permission-gateway.** 机器人闸在服务端允许或拒绝,不把待决推到 IM 或浏览器。

**session-registry.** 工作区名称供求交;路径不从机器人目录推断。机器人会话不进会话页([SR-R15](session-registry.md))。运行根不是已登记工作区。

**web-console.** 渲染名册、启用确认、审计与飞书扫码开通;本人绑定在个人化设置。按钮是窗口,闸门以服务端为准。

## 关键取舍

**无人值守压过人在回路。** 群里无人应答授权框。交互工具直接拒绝;见授权即结束。代价是需要人决策的工作回到控制台。

**外发唯一。** 所有出站经同一守卫;适配层原始发送只在守卫内。第二个平台继承中性策略,不重写出站。长连接用平台 SDK,出站走 c3 自己的通道,使守卫与审计不可绕过([ADR 0046](../../architecture/adr/0046-im-robot-outbound-authorization.md))。

**每回合进程隔离。** 本地文件只在运行根可达;没有逐次回调的写/执行由进程边界兜底。隔离失败结束回合,不裸跑([ADR 0047](../../architecture/adr/0047-robot-local-reads-scoped-to-run-root.md))。

## 非功能

存储不可用则不启动回合。错误必须对人可见。诊断不含正文与验证码。
