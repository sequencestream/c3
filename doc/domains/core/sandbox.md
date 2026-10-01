# Domain: sandbox

- **Group:** core
- **One-line:** 入选会话的 run 进进程级隔离:限制可见目录,无容器、无凭证注入;驱动不可用则失败不裸跑。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [workspace-setting](../settings/workspace-setting.md)(启用、补充挂载、会话种类);[agent-session](agent-session.md)(启动与执行根);[agent-config](../settings/agent-config.md)(连接解析决定是否开钥匙串)。
- **Depended on by:** [agent-session](agent-session.md)(入选 run 启动前接入);[im-robot](im-robot.md)(回合强制隔离复用本能力)。
- **exposes-api:** false
- **notes:** 内部域。配置入口在工作区设置;本域只执行隔离。
- **ADRs:** [0028](../../architecture/adr/0028-process-level-lightweight-sandbox-arapuca.md) 进程级隔离取代容器

本域拥有进程级隔离的放行边界与失败语义。哪些种类进箱由工作区设置裁定,本域不复制其勾选清单。

## Overview

sandbox 给入选 run 的厂商 CLI 加一层进程级隔离:同一用户、同一文件系统、收窄可见目录。不是容器,不注入供应方真钥。

**范围:** 进程隔离、固定与补充放行、代理与认证继承、哪些种类进箱、隔离驱动失败关闭。
**边界:** 不裁定工作区是否启用或勾选哪些种类(见 [workspace-setting](../settings/workspace-setting.md));不挑选智能体;不安装厂商 CLI;不覆盖机器人回合的无条件隔离(见 [im-robot](im-robot.md));当前不收窄出站网络;不做远程沙箱。

## Business rules

### 进程级隔离

入选 run 的厂商 CLI 作为宿主进程启动,由隔离驱动收窄文件系统可见范围。无容器、无镜像、无独立根文件系统。进程看到的绝对路径即宿主路径。未放行的目录不可见,含 home 内凭证目录。

### 放行范围

- 执行根(本次 run 的实际代码目录)可写。独立工作树时源工作区只读;执行根就是源工作区时合并为一条可写。
- 规格目录可写,路径与宿主相同。
- 工作区可再挂载补充目录,默认只读、可逐项放开写入;不得覆盖执行根、源工作区、规格目录。
- 是否进箱不取决于 run 来源、是否使用工作树或分支模式。

### 代理与认证

宿主已有出网代理时,隔离内一并使用。不向隔离环境注入供应方真钥。订阅态(无上游连接)可开宿主钥匙串,走厂商 CLI 自身登录;自备连接不因此打开钥匙串,见 [agent-config](../settings/agent-config.md) 连接解析。

### 会话种类

工作区指定哪些会话种类进箱,缺省与勾选见 [workspace-setting](../settings/workspace-setting.md)。本域只执行该裁定。

### 驱动

隔离驱动由本域自动安装。平台不支持、驱动不可用、放行路径非法或启动失败时,该 run 失败结束,不退回宿主裸跑。宿主已处于隔离中则同样失败,不再套一层。未登记的厂商启动失败,不裸跑。

## Domain events

无独立线协议。失败作为该次 run 的错误结束呈现。

## 协作

**agent-session.** 入选 run 启动前接入。执行根取该次运行的实际工作目录。沙箱不改已解析的智能体,只决定该厂商 CLI 是否被包进隔离。失败则该 run 以错误落定。隔离随运行时走,不随浏览器连接(见 [ADR 0006](../../architecture/adr/0006-decouple-runs-from-connections.md))。

**workspace-setting.** 启用开关、补充挂载与会话种类是工作区配置。本域读取规范化结果,不复制勾选清单与设置面板。

**agent-config.** 是否开宿主钥匙串问连接是否为空;悬挂引用的 fail-soft 回落不打开钥匙串。

**im-robot.** 机器人回合无条件调用同一隔离能力,与工作区种类勾选无关;失败语义相同。

**system-setting.** 系统代理注入新会话;本域在隔离内保留宿主代理可见,不另设代理开关。

## 关键取舍

**进程级,不是容器。** 日常 run 只需收窄目录。容器的路径映射、真钥下沉与网络旁路过重。隔离弱于容器,不承诺不可信代码的强隔离。见 [ADR 0028](../../architecture/adr/0028-process-level-lightweight-sandbox-arapuca.md)。

**失败关闭,不裸跑。** 工作区既已入选,隔离建不成则结束 run。静默降级会让「已启用」失去意义。

**真钥不进箱,订阅用钥匙串。** 自备连接沿用启动路径已有的认证面;真钥留在宿主中继。订阅态没有可注入的令牌,故打开宿主钥匙串。home 其余敏感目录仍不可见。

**网络不收窄。** 当前只控目录。进程即宿主,回环上的本机服务天然可达。

## 非功能

隔离驱动缺失或平台不支持必须对人可见。自动安装不阻塞当次判定:当次仍须有可用驱动,否则失败。
