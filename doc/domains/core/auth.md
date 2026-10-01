# Domain: auth

- **Group:** core
- **One-line:** 连接过身份门，改全局配置过管理员门。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [session-registry](session-registry.md)（工作区身份，供范围求解）。
- **Depended on by:** [web-console](web-console.md)（登录门）；[system-setting](../settings/system-setting.md)（管理员门与认证配置）；[personalized-setting](../settings/personalized-setting.md)（按人偏好，不过管理员门）；[external-mcp](external-mcp.md)（主体范围与 policy epoch）；[im-robot](im-robot.md)（调用级范围求解）。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../shared/api-conventions/websocket-protocol.md)中定义。
- **ADRs:** [0023](../../architecture/adr/0023-auth-abstraction-network-exposure.md) 认证抽象与暴露、[0044](../../architecture/adr/0044-external-mcp-owner-scope-and-unified-endpoint.md) 范围默认拒绝、policy epoch 与求交边界

本域拥有连接身份与账号级工作区范围。认证可选：是否启用、是否暴露到网络，由使用者决定；暴露时建议先启用认证。不拥有外部 MCP 入口、IM 出入口或设置面板本身。正式术语见[术语表](../../glossary.md)。

## 工作区范围 `user_workspace_scopes`

管理员配置的账号级授权：缺省拒绝，管理员与本地主体恒全部。不变量见 [业务规则](#business-rules)。

## Overview

auth 在连接驱动智能体之前确立它是谁，并按主体求解能碰哪些工作区。控制台、外部 MCP 与 IM 共用同一套主体与范围。

**范围:** 登录与会话令牌、连接与管理员门、多账号与唯一管理员、主体与工作区范围、调用级求交所用的范围与 policy epoch。
**边界:** 不拥有外部 MCP 端点与钥匙面（见 [external-mcp](external-mcp.md#请求与授权链)）；不拥有 IM 出入口（见 [im-robot](im-robot.md)）；不处理厂商 CLI 凭据（[C-SEC-4](../../constitution.md)）；个人化偏好不过管理员门（见 [personalized-setting](../settings/personalized-setting.md)）。权限网关的默认拒绝见 [C-SEC-3](../../constitution.md)，本域不复制。

## Business rules

### 登录与令牌

认证启用后，登录校验身份并签发与提供方无关的会话令牌。登出结束该会话。令牌只在进程内有效，重启后须重新登录。

- **AUTH-R3（绝不明文）**：口令只以哈希持久化。明文只在传输中存在，校验后丢弃。存储、示例与测试不以明文作为持久化值。
- **AUTH-R4（密钥按引用存放）**：令牌签名密钥不落系统设置，只存引用。
- **AUTH-R5（会话/消息与 provider 无关）**：令牌与登录、登出、未认证消息不含提供方字段。新增提供方不改它们。

### 连接与管理员门

认证启用后，未认证不得连接、不得驱动智能体。改全局配置另过管理员门。

- **AUTH-R1（默认 = 禁用）**：认证缺省、关闭、`none`、或无法解释的配置，一律视为无认证。非法块丢弃为缺省，不阻止启动。`none` 即未启用，种类是唯一真源。
- **AUTH-R2（向后兼容）**：没有认证配置的既有存储，加载后仍为无认证。
- **AUTH-R6（暴露时建议启用认证）**：是否暴露由使用者决定。绑定非本机时，面板建议先启用认证，且须先有管理员才能打开暴露。
- **AUTH-R10（仅管理员可变更系统配置）**：只有唯一管理员可改系统配置、账号名册与工作区注册表。无管理员可适用时关卡惰性，本地连接被信任。权威在服务端；控制台隐藏控件不是关卡。个人化设置不在此门内。

### 多账号

`basic` 为多账号目录，首位创建者为唯一管理员。任何账号均可登录；管理员是改配置的权威，不是登录特权。无角色分层。首位管理员落成后，当前连接须重新登录。

- **AUTH-R7（basic 账户存储由专用消息独占拥有）**：账号集合只经专用账户消息改写。通用保存设置不触碰它，陈旧草稿不得覆盖或清空名册。
- **AUTH-R8（改密关卡）**：改既有账号口令须证明当前口令。尚无管理员时允许创建首位账号；名册变更另受 AUTH-R10。
- **AUTH-R9（单管理员引用完整性）**：同一时刻一种提供方。`basic` 下账号非空时，恰好一个管理员且必须引用现存账号。用户名去首尾空白，区分大小写且唯一。删管理员且仍有其他账号则拒绝；删唯一账号则回到未配置。启用态由非空名册与有效管理员派生。

### 主体与范围

已验证账号即其自身；无认证、`none` 或未配置的 `basic` 映射为合成主体 `local`。工作区列表按主体求解，不是原始注册表。缺省拒绝，与 [C-SEC-3](../../constitution.md) 同向：缺失不是放行。

- **AUTH-R11（工作区可见性按主体求解）**：管理员与 `local` 见全部；其余按存储范围，无记录即空。`selected` 且零明细、无法解释的模式、注册表已无的名称，均空。已从名册删除的主体恒空。`all` 跟随注册表，`selected` 不跟随。控制台列表是可见性过滤，不是逐消息访问控制。内部系统任务可读未过滤注册表。

### 调用卡口

每次涉及 c3 对象的外部调用按主体范围求交。授权输入变更推进全局 policy epoch，使既有钉定会话失效。epoch 单调递增、对部署全局；工作区授权、账号名册、工作区注册表、以及钥匙工具授权的变更，与写入同事务推进。显示名与最后使用不推进。

- **AUTH-R12（外部 MCP 三层求交）**：外部调用的有效工作区含本域主体范围。`local` 归属只在无管理员关卡时有效；一旦配置 `basic`，该归属立即失效，不改派给任何真实账号。卡口、求交与冻结会话见 [external-mcp](external-mcp.md#请求与授权链)。

## Domain events

消费 `login`、`logout`、`set_admin_password`、`remove_account`、`set_admin_account`。发出 `login_result`、`admin_password_result`、`account_op_result`、`unauthenticated`。形状见[共享协议](../../shared/api-conventions/websocket-protocol.md)。

## 数据模型

### 认证提供方

认证后端按种类区分：`none` 或 `basic`。同一时刻一种。`none` 即未启用，不携带配置。`basic` 为多账号、恰好一个管理员。任何账号可登录；管理员是改配置的权威，不是登录特权。

### 主体

一次请求实际以谁的身份被授权。已验证的 `basic` 账号即其自身；无认证、`none` 或未配置的 `basic` 为合成主体 `local`。控制台、外部 MCP 与 IM 共用同一求解。

### 工作区范围

管理员配置的账号级授权：全部，或选定集合。缺省拒绝：无记录、选定但零明细、无法解释的模式，均空。管理员与 `local` 不进存储，恒为全部。已从名册删除的主体恒空。被约束者只读。

### 会话令牌

与提供方无关的已签发凭证，绑定主体与有效期。区别于智能体会话。密钥只按引用持有，不落系统设置。

## 协作

**system-setting.** 承载认证配置与「用户与访问」编辑面。账号凭据只走专用消息，通用保存不触碰名册。写过管理员门。

**personalized-setting.** 按人偏好，不过管理员门，也不与工作区范围共写路径。

**web-console.** 渲染登录门与设置面板。浏览器提示不是关卡。

**session-registry.** 工作区名称是范围求解的输入。`all` 跟随注册表；注册表变更推进 epoch。增删工作区过管理员门。

**external-mcp.** 公开 MCP 入口的求交与冻结会话在该域。本域提供主体范围与全局 epoch，不复制其规格。见 [ADR-0044](../../architecture/adr/0044-external-mcp-owner-scope-and-unified-endpoint.md)。

**im-robot.** 绑定把发送者映射到主体。每次涉及 c3 对象的调用向本域求解，再与群白名单求交。不复制 AUTH-R*。

## 关键取舍

**提供方抽象，不把 basic 焊进各层。** 会话令牌与登录消息与提供方无关；新增种类只加一个分支。见 [ADR-0023](../../architecture/adr/0023-auth-abstraction-network-exposure.md)。

**范围与个人偏好分存。** 工作区范围是管理员管、被约束者只读的授权；个人化是用户自管的偏好。共用写路径会把「可以自己改」和「绝不能自己改」压在一起。

**选定空集可表达。** 范围与明细分开，才能区分「选定了但一个都没选」与「压根没配」。两者都拒绝，但前者是管理员打出的状态。

**管理员与 `local` 不进存储。** 已配置管理员恒为全部，否则能改掉自己的恢复权限、把部署锁死。无认证的 `local` 同样恒全部，且只在无管理员关卡时有效。

**epoch 全局，不按人。** 按人要求每个变更点判断「动了谁的权限」，分错一次就留下旧权限。全局会断开无关客户端，重新初始化即可。

**账号只走专用消息。** 通用保存若能改名册，陈旧草稿就能清空或改派管理员。
