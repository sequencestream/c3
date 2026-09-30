# Domain: session-cleanup

- **Group:** core
- **One-line:** 按保留期删除过期的厂商会话存储;系统级、默认关闭。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [system-setting](../../settings/system-setting/system-setting-spec.md)(开关与保留期);[sandbox](../sandbox/sandbox-spec.md)(隔离 home 与宿主 home)。
- **Depended on by:** 无。副作用落在厂商原生存储,resume 与回放随之不可用。
- **exposes-api:** false
- **notes:** 内部域。配置入口在系统设置;本域只执行清理。不碰 Cursor IDE 会话库。

本域拥有厂商会话存储的保留期清理。不拥有存储布局、会话台账或设置面板。

## Index

- [session-cleanup-spec.md](session-cleanup-spec.md) — 系统级、默认关闭、厂商中立、Cursor 边界、失败跳过
- [session-cleanup-design.md](session-cleanup-design.md) — 与 system-setting、sandbox、agent-session 的协作与取舍
