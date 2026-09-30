# 国际化(i18n)规范

前端 UI 文案契约。key 为英文。命名约定为冻结点:新增 namespace / 改约定须先改本文档再动 key。译法见 [i18n-terms.md](./i18n-terms.md)。

## 与 IM 机器人服务端文案的边界

本规范只管浏览器 UI。IM 出站固定提示由独立的服务端注册表渲染,见 [robot-message-registry-spec](./robot-message-registry-spec.md);外发范围见 [im-robot](../domains/core/im-robot/im-robot-spec.md)「允许外发的内容」。两者仅共享 `en` / `zh` / `ja` / `ko` / `ru` 短码与术语约束。机器人控制台配置的 locale 是注册表语言,不是 Web 显示语言。

## Key 命名规范

结构:`<namespace>.<subject>[.<modifier>...][.<suffix>]`。全小写;段内多词 camelCase,段间 `.`。主语(对象 / 实体)在前,动作 / 角色在后。通用词进 `common`,业务词归各自域,错误文案统一进 `error`。

冻结的十一个 namespace:

- `common` — 跨页复用的通用词(按钮 / 状态 / 动作)
- `nav` — 导航 / 顶栏 / Tab
- `permission` — 工具调用权限提示
- `settings` — 系统设置
- `session` — 会话
- `automation` — 自动化
- `discussion` — 讨论
- `delivery` — 交付
- `intent` — 需求
- `error` — 错误 / 异常文案
- `robot` — IM 聊天机器人

后缀表达 UI 角色:

- `.label` — 可见标签 / 按钮文字
- `.placeholder` — 输入框占位
- `.tooltip` — 悬浮提示

## 基线与缺 key

基准与回退语种均为 `en`。缺失或回退时显式警告,不静默。合法 key 在类型检查阶段校验,拼错即编译失败。模板可见文案走翻译,不硬编码。非 `en` locale 覆盖 `en` 的全部 key;占位符在 locale 间守恒。

服务端对前端展示项只回传机器可读码,不回传译文;形状见 [websocket-protocol](../shared/api-conventions/websocket-protocol.md)。服务端日志、调试与发给模型的 prompt 保持英文,不纳入 UI 文案。

译文落地与是否出现在语言下拉是两件事:`en` / `zh` 无条件出现,其余已支持语种须经人工复核才进入下拉。
