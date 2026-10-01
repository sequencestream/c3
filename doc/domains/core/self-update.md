# Domain: self-update

- **Group:** core
- **One-line:** 把最新发行校验到暂存;管理员确认后按运行形态重启。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [system-setting](../settings/system-setting.md)(服务端出网);[auth](auth.md)(管理员门)。
- **Depended on by:** [web-console](web-console.md)(更新胶囊)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../shared/api-conventions/websocket-protocol.md)中定义。
- **notes:** 内部域。不拥有「是否有新版本」的检查,只消费其结果。桌面整包升级见 [release.md](../../non-functional/release.md)「桌面渠道」;本域在桌面形态下让位。
- **ADRs:** [0043](../../architecture/adr/0043-console-self-update-and-relaunch.md) 控制台自更新

本域拥有控制台驱动的下载、暂存与重启移交。不拥有版本检查、桌面整包升级、包管理器升级或出网路由。

## Overview

self-update 把最新发行下载并校验到暂存,管理员确认后替换已装二进制并按运行形态重启。目标恒为最新发行。

**范围:** 能否自更新、下载与校验到暂存、管理员确认后的替换与重启、跨重启对账。
**边界:** 不重造升级规则(与 `c3 upgrade` 同一套;CLI 仍只换盘、从不重启);不自带出网路由(见 [system-setting](../settings/system-setting.md)「服务端自身出网」);不接管桌面整包升级(见 [release.md](../../non-functional/release.md)「桌面渠道」);不越过包管理器;不拥有「是否有新版本」的检查,只消费其结果。

## Business rules

### 能力门,fail-closed

按桌面托管、开发/解释器运行、包管理器前缀、安装目录不可写依次判定,命中即止,让位给对应渠道。不可自更新时控制台退回提示,外链发行页。

### 暂存先于替换

检查到新版即后台下载;亦可手动开始或重试。下载中再开始无额外效果。校验通过并成为可运行的暂存包之后,安装位置仍是旧版本。就绪之前不碰已装二进制。失败与取消清空暂存。暂存随本实例,互不干扰。

启动时对账:已生效或属于另一安装位置的暂存丢弃;仍新于当前版本的保持就绪;上次替换或拉起失败如实呈现一次。

### 管理员确认重启

替换与重启只由管理员触发。一次重启断开所有连接、中断运行中的智能体。快照广播给所有连接;非管理员只看到已就绪、等待管理员。

### 按运行形态移交

谁拥有本进程,谁负责拉起后继。旧进程未退出不替换,以免端口仍被占用。替换失败则旧二进制仍可启动;替换成功但拉起失败则新二进制已装好,不谎报成功。

### 只升不降

目标恒为最新发行。不做降级,不提供版本选择。

## Domain events

消费 `start_self_update`、`apply_self_update`、`cancel_self_update`。发出 `self_update_state`。形状见[共享协议](../../shared/api-conventions/websocket-protocol.md)。「是否有新版本」走 `update_status`,本域不复制。

## 协作

**web-console.** 更新胶囊是视图:展示进度,管理员确认重启。浏览器不预测、不镜像。非管理员只看到等待。

**system-setting.** 版本检查与下载走系统代理。本域只负责拿到字节。判定见 [system-setting](../settings/system-setting.md)「服务端自身出网」。

**升级内核 / `c3 upgrade`.** 版本事实、传输、完整性与平台替换与 CLI 升级同一套规则。CLI 仍只替换磁盘上的二进制、从不重启;本域在其上编排暂存与重启。

**auth.** 下载与重启过管理员门;状态给所有连接。

**桌面渠道.** 壳与 sidecar 成对升级。单独替换 sidecar 会破坏包签名,本域整体让位。见 [release.md](../../non-functional/release.md)「桌面渠道」。

## 关键取舍

**就绪前不替换、不重启。** 先把可运行的包放进暂存。若下载完立刻换盘,用户迟迟不重启时盘上已是新版本、内存仍是旧的。

**桌面与包管理器不在范围内。** 桌面由壳做整包更新;包管理器前缀下的二进制由该管理器升级。本域 fail-closed,顶栏退回发行页。
