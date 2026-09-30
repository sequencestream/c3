# session-cleanup — 领域规格

## Overview

session-cleanup 按保留期删除厂商会话存储里过期的转录。这些文件让 resume 与回放成为可能,因此默认不删。

**范围:** 系统级开关与保留期、按约定发现会话存储、按修改时间删除过期文件、随服务进程周期执行。
**边界:** 不改变厂商存储布局(见 [sandbox 规格](../sandbox/sandbox-spec.md));不删会话存储之外的配置、凭证、技能或状态库;不清理 c3 自身台账;不碰 Cursor IDE 会话库(见下);与工作区沙箱勾选无关。

能力索引见 [features.md](../../../features.md) 的 system-setting 会话清理。

## Business rules

### 系统级、默认关闭

整份部署一份配置,不属于工作区。厂商 home 跨工作区共享,无法按工作区分割。未显式开启则不删任何文件。保留期可在关闭时保存,只是不生效。缺省保留 30 天,最短 1 天。删除对 resume 与回放不可逆;显式开启视为已授权。

### 厂商中立

不维护厂商注册表。按各厂商共用的会话存储约定识别,只清理其内部。新厂商沿用约定即纳入。覆盖隔离 home 与宿主厂商 home,不按工作区区分来源。

### Cursor

Cursor 的 rename / delete 为无,因为那是用户 IDE 数据。本域不扫、不删。见 [agent-session Cursor 能力边界](../agent-session/features/agent-session-cursor.md)。

### 执行与失败

随服务启停的进程级周期任务。关闭则本轮为空操作;开启则删除修改时间超过保留期的会话文件。改配置无需重启。单处不可读或删除失败则跳过该处,不中断本轮,不拖垮启动。

## Domain events

无独立线协议。配置经系统设置读写。

## Interactions

- **system-setting** — 开关与保留期。
- **sandbox** — 决定 run 写入哪一处 home;本域覆盖其可达的会话存储,不复制隔离裁定。
- **agent-session / session-registry** — 删除后不可 resume、不可回放。
