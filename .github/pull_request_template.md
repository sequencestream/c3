<!-- 简述本次改动的目的与范围 -->

## What & why

-

## Checklist

- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` 通过
- [ ] specs 与代码同步(改了行为就更新对应 spec)
- [ ] **i18n 已抽取**:新增/改动的用户可见文案 100% 走 `t()`/`$t()`,零硬编码;
      key 命名遵循 [`specs/style/i18n-spec.md`](../specs/style/i18n-spec.md) §2,
      译法遵循 [`specs/style/i18n-terms.md`](../specs/style/i18n-terms.md);
      `pnpm i18n:check` 绿(en/zh 覆盖率 100%、占位符未漂移),`no-raw-text` 无报错。
- [ ] 不适用 i18n(本 PR 未触及 `web/` 可见文案)
