# im-robot — 领域规格

## Overview

im-robot 把智能体接到办公 IM:已绑定的人在群里提问,c3 在机器人自己的目录里跑一轮无人值守会话,把最终回答发回同一处。这是 c3 唯一一条主动把智能体产出送往第三方云的路径。机器人回答问题,不替代控制台——过程、工具与授权决策仍在 c3。

**范围:** 部署级名册与连接、IM 身份绑定、L0–L3 能力上限、外发授权与唯一出站守卫、无人值守回合、工具权限、响应面与发送者隔离对话、运行诊断、飞书应用开通。
**边界:** 不是工作区资源,不出现在工作区切换器或会话页;不裁定工作区范围;不驱动运行循环;不渲染 UI;不发卡片、不传文件、不做流式改写;不承诺散文级内容安全。

实体见 [im-robot-models.md](im-robot-models.md)。能力索引见 [features.md](../../../features.md) 的 im-robot 节。

## Business rules

### 部署级出入口

- 配置、连接与名册跨工作区一致。运行目录是隔离工作容器,不是授权范围或默认工作区。工作区、对象与用户权限不得从机器人、连接、线程或原生会话推断。否决按工作区配机器人,以及为连接或线程钉定工作区。
- 平台适配只持连接、解码与投递;是否响应、去重、串行、守卫与审计在中性层,第二个平台继承而非重写。
- 机器人会话不进会话页,见 [SR-R15](../session-registry/session-registry-spec.md)。自动化须显式点名该会话种类才匹配。

### IM 身份绑定

- 本人从已认证 Web 发起挑战,仅私聊消费。未绑定或已撤销只收固定引导,不启动回合,不读 c3 对象。群内出现相同令牌不消费,只提示去私聊。绑定控制可走私聊,不受单聊默认关闭挡住;其余出站约束不变。
- 个人工作区范围由 [auth AUTH-R11](../auth/auth-overview.md) 求解。本域在每次涉及 c3 对象的调用上与群白名单求交:私聊取个人范围,群内取交集。群白名单默认空;响应面白名单不是数据可见范围。授权变更推进 policy epoch,切断旧对话恢复。

### 能力上限与外发授权

L0 受控播报 / L1 只读问答 / L2 定向作答 / L3 受控写入是能力天花板,不是总开关。默认停用、启用前确认、只读默认与出站守卫仍生效。

- **L0** 只发已注册事件模板,不含智能体正文;与模型可发的通用事件隔离。默认关闭。
- **L1** 用户发起的只读查询,每次调用重算作用域。
- **L2** 仅对已指定对象与允许答案集合作确定性回应,独立授权,不读取工具勾选。
- **L3** 管理员逐项勾选的账本写工具,加上调用级作用域与领域业务门;未列入的变更仍回 Web。

启用是独立授权([ADR 0046](../../../architecture/adr/0046-im-robot-outbound-authorization.md)):默认停用;启用前不可跳过的外发范围确认由服务端校验;仅管理员可创建、修改、启用;每次外发记一行元数据。缺凭据或缺确认则拒绝启用。停用永远允许。

### 允许外发的内容

回合结束才外发智能体正文。执行中只发已注册固定进度提示,不进后续上下文。工具调用、工具结果、中间推理、文件内容、会话转录与未注册自由文本一律不外发。固定提示来自服务端注册表,不由模型补写。

### 出站与隔离

一切 IM 外发经唯一出站守卫。适配层原始发送只在守卫内可见。守卫或审计不可用时失败关闭,不降级为直发。`@` 只约束入站,不扩大外发目标。发出前拦凭据形状(拒绝不回显命中内容);超平台上限则截断并标明。

本地文件只读运行目录,越界在读到之前拒绝([ADR 0047](../../../architecture/adr/0047-robot-local-reads-scoped-to-run-root.md))。每回合进程隔离;隔离失败结束回合,不退化为宿主机裸跑。勾选账本写工具不放开本地可写沙箱。

### 无人值守

群里无人应答授权对话框。面向人的交互工具直接拒绝;观察到授权请求即以 `blocked` 结束,不等待。另有墙钟上限。未列入白名单的一律拒绝。

### 工具权限

与 [automations](../automations/automations-spec.md) 共用权限网格,不复制该域规则。创建默认只读;切换厂商清空上一份勾选。本域另有只读工作区名称列举,自动化网格不出现。勾选子集才挂载;未勾选不可调用。

### 响应与对话

群消息默认必须 @ 机器人;单聊默认不响应。同一发送者严格串行、不排队,忙时立即固定提示并以 `busy` 审计,不启动回合。不同发送者可并发。问答成对保留、按发送者隔离;绑定或授权版本变化切断旧上下文。未送达的回答不进可恢复上下文([ADR 0048](../../../architecture/adr/0048-robot-im-context-as-bounded-local-persistence.md)、[ADR 0049](../../../architecture/adr/0049-im-identity-binding-and-call-level-scope.md))。

每条进入回合的消息以回复或审计原因结束。审计结局:`complete` | `error` | `blocked` | `timeout` | `guard_refused` | `input_rejected` | `identity_required` | `scope_changed` | `busy`。`busy` 不是 `blocked` 或 `error`。

同一条平台消息只受理一次。存储不可用则错误回复并收敛,不启动回合,不降级到扫描目录。入站不可读(非文本、无发送者、其它机器人)静默丢弃,群里不产生噪音。

### 运行诊断

出入站与绑定只记元数据(机器人、聊天类型、发送者摘要、提示键、原因码)。不记正文、不记验证码。

### 飞书应用开通

管理员可扫码新建飞书应用并回填凭据(`start_app_registration`)。开通面向飞书中国区;失败且尚未取得凭据时不写入、不回填。凭据已出但长连接未就绪时,把凭据一次性交还发起连接,供手工补齐,不落库、不广播。取消走 `cancel_app_registration`。

## Domain events

消费 `list_robots`、`create_robot`、`update_robot`、`delete_robot`、`acknowledge_robot_outbound`、`set_robot_enabled`、`list_robot_turns`、`acknowledge_robot_write_capability`、`set_robot_write_grant_enabled`、`get_my_im_identity`、`create_im_identity_challenge`、`cancel_im_identity_challenge`、`revoke_my_im_identity`、`admin_revoke_im_identity`、`list_im_identity_bindings`、`list_im_group_workspace_scopes`、`set_im_group_workspace_scopes`、`start_app_registration`、`cancel_app_registration`。发出 `robots`、`robot_turns`、`my_im_identity`、`im_identity_challenge_created`、`im_identity_bindings`、`im_group_workspace_scopes`、`app_registration_progress`、`app_registration_result`。形状见[共享协议](../../../shared/api-conventions/websocket-protocol.md)。

## Interactions

- **auth** — 主体与工作区范围;本域求交,不复制 AUTH-R*。
- **agent-session** — 种类 `robot` 的无人值守回合。
- **permission-gateway** — 机器人闸,不把待决推到 IM。
- **automations** — 共用工具网格。
- **session-registry** — 工作区名称供求交;机器人会话不进会话页。
- **web-console / personalized-setting** — 名册与本人绑定入口;闸门以服务端为准。
