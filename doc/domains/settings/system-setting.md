# Domain: system-setting

- **Group:** settings
- **One-line:** 管理员全局配置:显示与本地化、公开地址、导航、CLI 版本、代理、会话清理、鉴权与访问、外部钥匙存储、监听与续跑、环境诊断。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [auth](../core/auth.md)(管理员门与 AUTH-R*)。
- **Depended on by:** [agent-config](agent-config.md)(CLI 版本与宿主是否可跑);[sandbox](../core/sandbox.md)(系统代理);[self-update](../core/self-update.md)(出网);[session-cleanup](../core/session-cleanup.md)(开关与保留期);[external-mcp](../core/external-mcp.md)(钥匙存储与监听);[personalized-setting](personalized-setting.md)(钥匙哈希);[workspace-setting](workspace-setting.md)(账号范围);[web-console](../core/web-console.md)(设置页);[automations](../core/automations.md)(时区)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../shared/api-conventions/websocket-protocol.md)中定义。

本域拥有部署级一份的管理员配置。智能体档案见 [agent-config](agent-config.md);按人偏好见 [personalized-setting](personalized-setting.md);工作区旋钮见 [workspace-setting](workspace-setting.md)。不执行隔离、不校验钥匙出示、不跑保留期删除。

## Overview

system-setting 持有本部署一份的管理员配置,既非按工作区、也非按人。写过 [AUTH-R10](../core/auth.md)。智能体档案与路由属 [agent-config](agent-config.md);按人偏好属 [personalized-setting](personalized-setting.md),不过管理员门。

**范围:** 显示与本地化、公开访问地址、导航显示、CLI 版本、代理、会话清理开关与保留期、鉴权配置与账号范围编辑面、外部钥匙存储与哈希、监听与续跑、环境诊断。
**边界:** 不持有智能体档案;不执行工作区隔离(见 [sandbox](../core/sandbox.md)、[workspace-setting](workspace-setting.md));不校验钥匙出示(见 [external-mcp](../core/external-mcp.md));不执行保留期删除(见 [session-cleanup](../core/session-cleanup.md));不渲染控制台。

## 显示与本地化

语音输入语言与界面语言解耦。系统时区解释每一条自动化 cron(含夏令时);非法回退服务端本地时区;改时区平移既有自动化的实际触发时刻。

## 公开访问地址

可选对外基址,用于拼接可分享深链。空即未配置,消费者自行回退。保存时去掉首尾空白与尾斜杠。不做协议/主机校验,不探测可达。

## 导航显示

两个独立开关,缺省均隐藏:会话聚合页是否进主导航;工具类会话是否进列表。关闭聚合页不删除功能内的会话入口。

## CLI 版本

只对 c3 托管的厂商有效。空即最新兼容版;非空必须是已安装版,否则降到最新兼容并保留固定值、给出可见诊断,不静默清空。固定值与实际生效允许不同。同步始终跟踪最新兼容,不因固定而冻结升级。显式环境覆盖优先于托管解析。管理员可立即同步一次,不写入设置草稿。诊断与失败可同时呈现,不得互相遮蔽。

## 代理

一份配置同时管新会话出网与服务端自身出网。总开关关闭则两者都不走代理,已填地址保留。只影响此后新开的会话,运行中的不追溯。

### 服务端自身出网

版本检查与自更新走同一份配置。回环与环境排除名单直连;开关开则用配置地址;否则回退宿主环境代理;都没有则直连。配置了会话侧可接受、服务端不支持的代理方案时,服务端请求明确失败,不悄悄直连。每次请求重读配置。

## 会话清理

开关与保留期在本域;未开启不删任何文件。执行见 [session-cleanup](../core/session-cleanup.md)。

## 鉴权与访问

承载认证配置。缺省关闭([AUTH-R1](../core/auth.md))。账号凭据只走专用消息,不经通用保存([AUTH-R7](../core/auth.md))。运行语义见 [auth](../core/auth.md)。

## 用户与访问

账号 × 工作区授权的管理员编辑面。存储与解析见 [AUTH-R11](../core/auth.md)。不属于系统设置对象:不进通用保存。读写作管理员门([AUTH-R10](../core/auth.md));名册列出全部账号与工作区,隐藏页签不是关卡。管理员与 `local` 以只读行呈现,无法把自己锁在门外。无策略与选空可区分,均不放行。保存整笔生效或整笔拒绝。搜索不改变将提交的勾选集合。新工作区:`all` 立即可见,`selected` 不自动加入。本页不新建账号、不改口令、不指派管理员。

## 外部 MCP API Key 存储 `mcp_api_keys`

独立账本,不属于系统设置对象,通用保存既不能注入也不能读出哈希。磁盘无明文。归属与密钥版本不可缺;缺则不是可用钥匙。无归属的历史记录启动时吊销,不凭空指派。

钥匙不绑定工作区:名称只是归档位置,能到达哪些工作区由归属账号的 [AUTH-R11](../core/auth.md) 决定;自助钥匙归档为空,不经工作区寻址改动。标识一半非秘密,校验按它定位唯一记录。明文只在生成响应出现一次。空工具范围是零权限,不是通配。校验每次重读记录,不缓存「此钥匙有效」。

用法见 [external-mcp](../core/external-mcp.md);自助生命周期见 [personalized-setting](personalized-setting.md)。

## 监听与续跑

监听缺省回环,显式放开才对外。绑定非回环且无管理员时,外部 MCP 入口拒绝(见 [external-mcp](../core/external-mcp.md))。断连自动续跑缺省开、一次为限;关闭则该次以错误结束,由用户继续。运行语义见 [AS-R18](../core/agent-session.md)。

## 环境诊断

只读展示各厂商 CLI 探测结果,不落库、不可编辑。与「能不能新开一轮」的门控分开,见 [AC-R26](agent-config.md)。

## Domain events

消费 `get_settings`、`save_settings`、`sync_vendor_cli`、`get_user_workspace_access`、`save_user_workspace_access`。发出 `settings`、`vendor_cli_sync_result`、`user_workspace_access`。钥匙自助消息属 [personalized-setting](personalized-setting.md)。形状见[共享协议](../../shared/api-conventions/websocket-protocol.md)。账号范围与钥匙不进通用保存载荷。

## 协作

**auth.** 认证配置与「用户与访问」编辑面在本域;身份、范围求解与管理员门在该域。账号凭据只走专用消息。

**agent-config.** CLI 版本与宿主诊断在本域。该域只取能不能跑。

**session-cleanup.** 开关与保留期在本域;该域读取后执行。

**external-mcp / personalized-setting.** 用法与自助面分属那两域。本域只存哈希。监听默认回环。

**sandbox / self-update / automations.** 新会话继承系统代理;服务端出网走同一份配置。自动化读系统时区。

**web-console.** 渲染设置页。浏览器提示不是关卡。

## 关键取舍

**全局一份。** 时区、代理、公开地址、清理保留期若按工作区拆,出网路径与厂商存储会对不齐。

**钥匙与系统设置分存。** 通用保存若能携带哈希,草稿就能注入或抹掉凭据。

**沙箱跟工作区走,不是系统模板。** 启用、挂载与种类见 [workspace-setting](workspace-setting.md)。

**固定版本与生效版本可分离。** 选历史版不得冻结同步,也不得在固定值失效时悄悄清空选择。

**代理一份声明、两类流量。** 会话与自更新若各走各的,只能经代理出网的网络里永远看不到新版本。地址明文存放。

**监听默认回环。** 对外暴露是显式选择;非回环且无管理员则外部入口拒绝。
