# IM 机器人服务端文案注册表

> 适用范围:IM 机器人出站固定控制提示。与 Web vue-i18n 分离;详见 `doc/i18n/i18n-spec.md` §1.1。

## 语言与回退

- 支持短码:`en`(基准目录)、`zh`、`ja`、`ko`、`ru`。
- 发送时解析:**绑定主体当前 `uiLang` → 机器人 `locale`(NULL=系统默认 `en`) → `en`**,去重后逐层查找同一键。
- 未知 locale、缺键、参数校验失败 → 渲染 `system.safeFallback`(仍非空);基准目录不完整则启动期失败。

## 键与参数

- 键:稳定点分语义名(如 `binding.identityRequired`、`visibility.notVisible`)。
- 调用方只提交 `RobotMessageRef { key, params }`;不能传模板正文或额外字段。
- 导航类键的 `nav` 参数由服务端根据 `SystemSettings.baseUrl` 与路由白名单构造;`baseUrl` 非法时同键无链接变体。

## 使用策略

| 策略             | 出站类别     | 说明                                          |
| ---------------- | ------------ | --------------------------------------------- |
| `fixed_notice`   | 普通固定提示 | 运行期/可见性/令牌(L2 契约)等                 |
| `binding_notice` | 绑定提示     | 窄豁免;群内仅部分键                           |
| `broadcast_only` | _(未接线)_   | L0 播报键冻结契约,ADR-0046 后续裁决前不可发送 |

## 代码位置

- 目录:`server/src/features/im/robot-message-catalog.ts`
- 渲染:`server/src/features/im/robot-message-registry.ts`
- 出站:`server/src/features/im/outbound-guard.ts` → `sendGuarded`
