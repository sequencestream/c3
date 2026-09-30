# sandbox — 领域规格

## Overview

sandbox 给入选 run 的厂商 CLI 加一层进程级隔离:同一用户、同一文件系统、收窄可见目录。不是容器,不注入供应方真钥。

**范围:** 进程隔离、固定与补充放行、代理与认证继承、哪些种类进箱、隔离驱动失败关闭。
**边界:** 不裁定工作区是否启用或勾选哪些种类(见 [workspace-setting](../../settings/workspace-setting/workspace-setting-spec.md));不挑选智能体;不安装厂商 CLI;不覆盖机器人回合的无条件隔离(见 [im-robot](../im-robot/im-robot-spec.md));当前不收窄出站网络;不做远程沙箱。

能力索引见 [features.md](../../../features.md) 的 sandbox 节。

## Business rules

### 进程级隔离

入选 run 的厂商 CLI 作为宿主进程启动,由隔离驱动收窄文件系统可见范围。无容器、无镜像、无独立根文件系统。进程看到的绝对路径即宿主路径。未放行的目录不可见,含 home 内凭证目录。

### 放行范围

- 执行根(本次 run 的实际代码目录)可写。独立工作树时源工作区只读;执行根就是源工作区时合并为一条可写。
- 规格目录可写,路径与宿主相同。
- 工作区可再挂载补充目录,默认只读、可逐项放开写入;不得覆盖执行根、源工作区、规格目录。
- 是否进箱不取决于 run 来源、是否使用工作树或分支模式。

### 代理与认证

宿主已有出网代理时,隔离内一并使用。不向隔离环境注入供应方真钥。订阅态(无上游连接)可开宿主钥匙串,走厂商 CLI 自身登录;自备连接不因此打开钥匙串,见 [agent-config](../../settings/agent-config/agent-config-spec.md) 连接解析。

### 会话种类

工作区指定哪些会话种类进箱,缺省与勾选见 [workspace-setting](../../settings/workspace-setting/workspace-setting-spec.md)。本域只执行该裁定。

### 驱动

隔离驱动由本域自动安装。平台不支持、驱动不可用、放行路径非法或启动失败时,该 run 失败结束,不退回宿主裸跑。宿主已处于隔离中则同样失败,不再套一层。未登记的厂商启动失败,不裸跑。

## Domain events

无独立线协议。失败作为该次 run 的错误结束呈现。

## Interactions

- **workspace-setting** — 启用、补充挂载、种类勾选。
- **agent-session** — 启动时接入;执行根来自该次 run。
- **agent-config** — 连接解析决定是否开钥匙串。
- **im-robot** — 强制隔离复用本能力。
- **system-setting** — 系统代理进入会话环境后,本域继承其可见性。
