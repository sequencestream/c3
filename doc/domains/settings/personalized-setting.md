# Domain: personalized-setting

- **Group:** settings
- **One-line:** 按人偏好:显示语言、样式、字号;按身份存储与首次播种;外部钥匙自助;智能体输出语言。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [auth](../core/auth.md)(已验证身份,不过管理员门);[system-setting](system-setting.md#外部-mcp-api-key-存储-mcp_api_keys)(钥匙哈希);[external-mcp](../core/external-mcp.md)(钥匙用法);[im-robot](../core/im-robot.md)(绑定语义)。
- **Depended on by:** [web-console](../core/web-console.md)(设置页)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../shared/api-conventions/websocket-protocol.md)中定义。

本域拥有按人偏好与本人自助面。管理员配置见 [system-setting](system-setting.md);钥匙出示见 [external-mcp](../core/external-mcp.md);IM 绑定语义见 [im-robot](../core/im-robot.md)。不渲染控制台。

## Overview

personalized-setting 持有**因人而异**的偏好,以及本人名下的钥匙与 IM 绑定入口。三类设置中唯一不过管理员门:改自己的,碰不到别人。管理员配置见 [system-setting](system-setting.md);工作区旋钮见 [workspace-setting](workspace-setting.md)。

**范围:** 显示语言、显示样式、字体大小、按身份存储、首次登录播种、智能体输出语言、外部钥匙自助;同页的本人 IM 绑定入口。
**边界:** 不拥有钥匙存储与哈希(见 [system-setting](system-setting.md#外部-mcp-api-key-存储-mcp_api_keys));不校验钥匙出示(见 [external-mcp](../core/external-mcp.md));不拥有 IM 绑定语义(见 [im-robot](../core/im-robot.md));不裁定工作区范围;不渲染控制台。

## 按身份存储

存储跟身份走,与部署形态无关。已认证:按已验证主体一账号一份,客户端不能指定读写谁。无身份:只留在本浏览器,不跨设备。个人化不进系统设置快照,与通用保存互不触及。鉴权开启时未认证连接到不了本域。

解析:**账户记录 → 本机合法值 → 内置默认**。各字段独立归一,损坏不扩散。首屏不把浏览器或系统偏好当作已选择。显示项选中即生效再按身份保存,无草稿。

## 首次登录播种

取偏好时客户端可上报本机合法值作种子。仅当该主体尚无记录时创建一次;一旦有记录即为权威,本机值不覆盖、不合并。并发只成功一次。不从系统设置推导账户默认。保存成功后本机跟上,登出仍用最近选择,也可作其他无记录账户在此浏览器的种子。

## 显示语言

控制台界面语言,与系统语音输入语言解耦(见 [system-setting](system-setting.md#显示与本地化))。非法回落英语。

## 显示样式

控制台配色。可选项与配色见[风格设计规范](../../style/color-style-spec.md);本域只接纳合法 id。非法回落深色。不参与输出语言推进。

## 字体大小

控制台全局字号。非法或越界回落基准。与语言、样式各自归一。

## 智能体输出语言

无连接上下文的服务端提示词(意图、规格、自动化、讨论与共识)读一份部署级语言:任何客户端保存或上报界面语言时顺带推进,无记录则英语。不是任何账户的默认,也不会当作某人的偏好读回。

## 外部钥匙自助

本人名下的外部 MCP 钥匙。持有者即权威,管理员对别人的钥匙无权力。存储与哈希见 [system-setting](system-setting.md#外部-mcp-api-key-存储-mcp_api_keys);出示与求交见 [external-mcp](../core/external-mcp.md)。

不进个人化载荷:即时指令,无草稿。归属只从已验证连接推导,客户端不传所有者;无法解析身份则拒绝创建。未知 id 与他人 id 同一未找到、无变更。不显示不编辑工作区范围;新钥匙拿服务端默认只读集,本页不选工具。明文只在新建或重置成功时出现一次,不可再看。归属失效只留吊销。公开地址未配置则明说,不猜浏览器主机。

## IM 身份自助

同页承载本人 IM 绑定入口。不进个人化载荷,不过管理员门。绑定、挑战与撤销语义见 [im-robot](../core/im-robot.md)。群工作区白名单不在本页。切身份或离开本页即丢弃仍在手上的钥匙明文与挑战令牌。

## 失败处理

读失败不发伪成功;写失败不改已存。无连接则屏幕回到切换前,使所见与已存一致。

## Domain events

消费 `get_personalized_settings`、`save_personalized_settings`、`list_my_mcp_api_keys`、`create_my_mcp_api_key`、`reset_my_mcp_api_key`、`revoke_my_mcp_api_key`。发出 `personalized_settings`、`my_mcp_api_keys`。本人 IM 绑定消息属 [im-robot](../core/im-robot.md)。形状见[共享协议](../../shared/api-conventions/websocket-protocol.md)。钥匙与绑定不进个人化载荷。

## 协作

**auth.** 作用域来自已验证身份。不过管理员门,也不与工作区范围共写。

**system-setting.** 钥匙哈希与公开地址在该域。本域不写哈希、不猜主机。

**external-mcp.** 出示、求交与端点在该域。本域只做持有者自助。

**im-robot.** 绑定与挑战在该域。本域只放本人入口;群白名单在机器人管理面。

**web-console.** 渲染个人化页。浏览器提示不是关卡。

## 关键取舍

**按人一份,不过管理员门。** 语言与样式若进系统设置,一个人的选择会变成所有人的默认。

**只播种,不合并。** 账户记录一旦存在就是权威;把本机值持续写回等于用后登录的浏览器覆盖先登录的选择。

**输出语言不是账户偏好。** 背景任务没有连接,需要一份部署级语言;把它读回当某人的界面语言会污染按人作用域。

**自助不进个人化载荷。** 草稿保存若能携带钥匙或绑定,就能注入或抹掉别人够不到的凭据。

**明文只一次。** 磁盘与名册都不回放密钥;再看一次等于把一次性秘密变成可查询秘密。
