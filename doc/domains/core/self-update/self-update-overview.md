# Domain: self-update

- **Group:** core
- **One-line:** 把最新发行校验到暂存;管理员确认后按运行形态重启。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [system-setting](../../settings/system-setting/system-setting-spec.md)(服务端出网);[auth](../auth/auth-spec.md)(管理员门)。
- **Depended on by:** [web-console](../web-console/web-console-spec.md)(更新胶囊)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。
- **notes:** 内部域。不拥有「是否有新版本」的检查,只消费其结果。桌面整包升级见 [release.md](../../../non-functional/release.md)「桌面渠道」;本域在桌面形态下让位。
- **ADRs:** [0043](../../../architecture/adr/0043-console-self-update-and-relaunch.md) 控制台自更新

本域拥有控制台驱动的下载、暂存与重启移交。不拥有版本检查、桌面整包升级、包管理器升级或出网路由。

## Index

- [self-update-spec.md](self-update-spec.md) — 能力门、暂存先于替换、管理员确认、按形态移交、只升不降
- [self-update-design.md](self-update-design.md) — 与控制台胶囊、系统代理、CLI 升级内核的协作与取舍
