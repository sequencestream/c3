---
name: defaultmode-per-vendor-record
description: '2026-06-07: ProjectConfig.defaultMode 从单值 ModeToken 改为 Record<VendorId, ModeToken>'
metadata:
  type: project
  tags: [normalize, migration, i18n, per-vendor]
---

`ProjectConfig.defaultMode` 现在是 `Record<VendorId, ModeToken>`(per-vendor 映射)，每个 vendor 配各自的默认 mode。

- 迁移: `normalizeProjectConfig` 的 `normalizeDefaultMode()` 处理旧 string → Record 转换
- `getDefaultMode(projectPath, vendor?)` 加 vendor 参数，未知时退化为 claude
- 服务端 `saveProjectConfigHandler` 按 vendor catalog 校验
- 前端按 vendor 分组渲染 select，使用 `vendorModes` prop
- i18n 五语 `projectConfig.defaultMode.section.{vendor}.label` + `error.projectConfig.invalidDefaultMode`
- 硬编码默认值: claude='default', codex='auto', opencode='build'（匹配 MODE_CATALOGS defaultToken）

**Why:** 三个 vendor 各有自己的 mode token 集合，单值无法分别配置。

**How to apply:** 参照 spec "per-vendor-default-mode" 的 AC-R8 和 normalizeDefaultMode 模式。

Related: [[c3-protocol-grep-snapshot-stale]], [[i18n-m1-extraction]], [[i18n-server-code-params]]
