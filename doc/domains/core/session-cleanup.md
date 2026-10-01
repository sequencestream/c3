# Domain: session-cleanup

- **Group:** core
- **One-line:** 按保留期删除过期的厂商会话存储;系统级、默认关闭。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [system-setting](../settings/system-setting.md)(开关与保留期);[sandbox](sandbox.md)(隔离 home 与宿主 home)。
- **Depended on by:** 无。副作用落在厂商原生存储,resume 与回放随之不可用。
- **exposes-api:** false
- **notes:** 内部域。配置入口在系统设置;本域只执行清理。不碰 Cursor IDE 会话库。

本域拥有厂商会话存储的保留期清理。不拥有存储布局、会话台账或设置面板。

## Overview

session-cleanup 按保留期删除厂商会话存储里过期的转录。这些文件让 resume 与回放成为可能,因此默认不删。

**范围:** 系统级开关与保留期、按约定发现会话存储、按修改时间删除过期文件、随服务进程周期执行。
**边界:** 不改变厂商存储布局(见 [sandbox](sandbox.md));不删会话存储之外的配置、凭证、技能或状态库;不清理 c3 自身台账;不碰 Cursor IDE 会话库(见下);与工作区沙箱勾选无关。

## Business rules

### 系统级、默认关闭

整份部署一份配置,不属于工作区。厂商 home 跨工作区共享,无法按工作区分割。未显式开启则不删任何文件。保留期可在关闭时保存,只是不生效。缺省保留 30 天,最短 1 天。删除对 resume 与回放不可逆;显式开启视为已授权。

### 厂商中立

不维护厂商注册表。按各厂商共用的会话存储约定识别,只清理其内部。新厂商沿用约定即纳入。覆盖隔离 home 与宿主厂商 home,不按工作区区分来源。

### Cursor

Cursor 的 rename / delete 为无,因为那是用户 IDE 数据。本域不扫、不删。见 [agent-session Cursor 能力边界](agent-session.md#cursor-能力边界)。

### 执行与失败

随服务启停的进程级周期任务。关闭则本轮为空操作;开启则删除修改时间超过保留期的会话文件。改配置无需重启。单处不可读或删除失败则跳过该处,不中断本轮,不拖垮启动。

## Domain events

无独立线协议。配置经系统设置读写。

## 协作

**system-setting.** 开关与保留期是系统配置。本域读取规范化结果,不复制面板。

**sandbox.** 沙箱只决定这次 run 写进隔离 home 还是宿主 home。本域覆盖两处可达的会话存储,不问工作区是否入箱。

**agent-session / session-registry.** 转录只在厂商原生存储。删掉的文件不能 resume,也不能回放。不碰 Cursor 会话库,见规格所引能力页。

## 关键取舍

**全局,不按工作区。** 厂商 home 跨工作区共享,一份开关才能描述它们。按工作区开关会让「本工作区关闭仍被别处清掉」或反过来,语义不成立。

**默认关闭。** 删除对 resume 与回放不可逆。未表态即不删;显式开启视为已授权。
