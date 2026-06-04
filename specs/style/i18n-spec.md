# 国际化(i18n)规范

> 适用范围:`web/`(`@ccc/web`)前端 UI 文案。本规范的命名约定为**冻结点**,是后续
> 全量文案抽取的全局解锁前提 —— 新增 namespace / 改约定须先改本文档再动 key。

## 1. 技术基建

- 库:`vue-i18n` v11(Composition API,`legacy: false`)。
- 编译:`@intlify/unplugin-vue-i18n`(`runtimeOnly: true` + `compositionOnly: true`),
  消息在**编译期预编译**,运行期不携带消息编译器。
- 基准语种:`en`,文件 `web/src/locales/en.json`。`fallbackLocale: 'en'`。
- 缺 key:`missingWarn: true` + `fallbackWarn: true` —— 缺失/回退时控制台**显式 warning,不静默**。
- 类型安全:`MessageSchema = typeof en`;`web/src/i18n/index.ts` 由 schema 推导出叶子路径
  有限并集 `LocaleKey`,并导出受约束的 `t` / `useTypedI18n()`,**key 拼错在 `vue-tsc` 阶段编译失败**。

> 注:vue-i18n 原生 `t` / 模板 `$t` 仅提供 key **自动补全**(其签名 `<Key extends string>`
> 会把入参推断为字面量,故不会对拼错报错)。需要编译期拦截拼错时,**使用本模块导出的
> `t` / `useTypedI18n().t`**,而非直接 `useI18n().t`。

## 2. Key 命名规范(冻结)

key 段结构:

```
<namespace>.<subject>[.<modifier>...][.<suffix>]
```

全小写;段内多词用 `camelCase`,段间用 `.` 分隔。

### 2.1 namespace(第一段,冻结九个)

| namespace     | 用途                                 | 示例                             |
| ------------- | ------------------------------------ | -------------------------------- |
| `common`      | 跨页复用的通用词(按钮 / 状态 / 动作) | `common.action.save.label`       |
| `nav`         | 导航 / 顶栏 / Tab                    | `nav.refresh.tooltip`            |
| `permission`  | 工具调用权限提示                     | `permission.tool.allow.label`    |
| `settings`    | 系统设置                             | `settings.theme.label`           |
| `session`     | 会话                                 | `session.list.refresh.tooltip`   |
| `schedule`    | 定时任务                             | `schedule.form.name.placeholder` |
| `discussion`  | 讨论                                 | `discussion.input.placeholder`   |
| `requirement` | 需求                                 | `requirement.detail.empty`       |
| `error`       | 错误 / 异常文案                      | `error.network.timeout`          |

- 通用词进 `common`,业务词归各自域;错误文案统一进 `error`。
- 需要新 namespace 时,**先在本表登记再加 key**。

### 2.2 后缀约定(可选 —— 表达 UI 角色)

| 后缀           | 含义                | 示例                           |
| -------------- | ------------------- | ------------------------------ |
| `.label`       | 可见标签 / 按钮文字 | `session.title.label`          |
| `.placeholder` | 输入框占位          | `discussion.input.placeholder` |
| `.tooltip`     | 悬浮提示            | `nav.refresh.tooltip`          |
| (无后缀)       | 普通正文 / 消息     | `requirement.detail.empty`     |

### 2.3 主语在前(subject-first)

主语(对象 / 实体)在前,动作 / 角色在后:

- ✅ `session.list.refresh.tooltip`、`permission.tool.allow.label`、`requirement.detail.empty`
- ❌ `refreshSessionList`、`tooltipForRefresh`、`allowToolPermission`

### 2.4 插值与复数

走 vue-i18n 原生机制:

- 具名插值:`"discussion.agendaItem.count": "{count} items"` → `t('discussion.agendaItem.count', { count: 3 })`
- 复数:`"common.item.count": "no items | one item | {count} items"` → `t('common.item.count', n)`

## 3. 用法

```ts
// 组件内
import { useTypedI18n } from '@/i18n'
const { t } = useTypedI18n()
t('common.action.save.label') // ✅
t('common.save') // ❌ vue-tsc 编译失败

// 组件外(composables / lib)
import { t } from '@/i18n'
t('error.network.timeout')
```

```vue
<!-- 模板内可用 $t,获得补全(但拼错不报错);需编译期拦截请在脚本里用 useTypedI18n().t -->
<button :title="t('nav.refresh.tooltip')">{{ t('common.action.save.label') }}</button>
```

## 4. 文件布局

```
web/src/
  locales/en.json     # 基准文案(schema 来源)
  i18n/index.ts       # createI18n + 类型增强 + typed t / useTypedI18n
  main.ts             # app.use(i18n)
```

> 空 `en.json`(`{}`)可正常编译与启动;此时 `LocaleKey = never`,任何字面量 `t()` 调用
> 都会报错 —— 随 en.json 逐步填充自然解锁对应 key。

## 4. 测试 / 抽取桥接约定(冻结)

i18n 抽取会改变所有可见文案;组件测试中**依赖可见英文文案 / `title` / `placeholder` 等
会被翻译的属性的断言必须在抽取前解耦**,否则抽取即全红。两条配套约定如下。

### 4.1 `data-testid`(稳定测试选择器)

- 风格:**组件域-角色 kebab-case** —— `<组件/域>-<角色>`,全小写,`-` 分隔。
  示例:`session-list-refresh`、`session-row-rename`、`discussion-pending`、
  `disc-tab-<kind>`、`settings-save`、`task-more-completed`。
- 仅打在测试需要稳定选择的节点(交互元素、空态/状态文案节点),**不全量铺**。
- 断言**永不**比对可见译文;改为:`exists()` / class / emitted / 数量 /
  fixture 注入的业务数据。
- `@vue/test-utils` 无 `getByTestId`;用 `[data-testid="…"]` 属性选择器。

### 4.2 `data-i18n-key`(i18n 待抽取标记)

- 加在"承载 i18n 待抽取文案"的节点(可见文本节点;或文案在 `title` / `placeholder` 上的节点)。
- **本规范下值留空** `data-i18n-key=""` = "此节点文案待抽取";抽取阶段按 §2 命名填入
  真实 key 并接 `t()`(或 `:title="t('…')"` / `:placeholder="t('…')"`)。
- 抽取待办可由 `grep 'data-i18n-key=""'` 全量枚举;待 `en.json` 填齐后该标记可移除。

## 5. 质量门禁(自动化)

三道闸防硬编码与缺 key / 占位符漂移,串入 `typecheck` / `lint-staged` / CI。

### 5.1 `pnpm i18n:check`(脚本 `scripts/i18n/check.mjs`)

以 `en` 为基准,全量扫描(忽略命令行传入的文件名,故可安全挂 lint-staged),**四类**校验
(前三类守 web 文案,第四类守服务端 `code+params`):

| 校验                | 含义                                                                                             | 级别               |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------ |
| 覆盖(coverage)      | 各非 `en` locale 必须覆盖 `en` 的全部叶子 key                                                    | 缺 key = **error** |
| 多余 key(extra)     | locale 含 `en` 没有的 key                                                                        | **warn**           |
| 占位符(placeholder) | 同一 key 两端的 `{...}` token 多重集 + 竖线 `\|` 复数分支数必须一致                              | 篡改 = **error**   |
| code→key            | `web/src` 中 `t('…')`/`$t('…')` 字面量引用的 key 必须存在于 `en.json`                            | 缺失 = **error**   |
| 动态 key            | `t(变量)` / 含插值的模板串,无法静态判定                                                          | **warn**(跳过)     |
| 未使用 key          | `en.json` 中从未被字面量引用的 key                                                               | **warn**           |
| code→locale(SoT)    | `shared/src/ui-codes.ts` 每个 code 的 `key` 须在 `en.json`;声明的 `params` 须与该 key 占位符一致 | 不符 = **error**   |
| code 越界           | `server/src` 中 `error: { code: '…' }` 发送的 code 须登记于 SoT                                  | 未登记 = **error** |
| 未发送 code         | SoT 中从未被 `server/src` 发送的 code                                                            | **warn**           |

退出码:有 **error → 1(CI 红)**;仅 warn → 0(绿)。**空 `en.json` 且无 `t()` 调用 → 绿**。

占位符校验采用「变量→不可译 token→比对」:把每条消息里的 `{name}`/`{0}`/ICU 块
(`{count, plural, …}`,嵌套花括号整块保留)抽成 token 多重集,翻译端重命名 / 增删 token
或改变复数分支数即报错——保护 `{name}` `{n}` 与复数块不被改坏。

### 5.2 `no-raw-text`(ESLint,`@intlify/eslint-plugin-vue-i18n`)

`eslint.config.js` 对 `web/src/**/*.vue` 启 `@intlify/vue-i18n/no-raw-text`,禁模板中
中英文硬编码文案(纯标点 / 数字 / 符号经 `ignorePattern` 豁免)。

> **当前级别 = `error`(阻断)**。M1 全量抽取已完成(26 个 .vue 可见静态文案 100% 走 `t()`,
> `eslint web/src` 0 raw-text),前置条件满足,已于 2026-06-04 由 `warn` 切 `error` —— 此后任何
> 新增硬编码文案即 `pnpm lint`/CI 红。
>
> 注:数据绑定的枚举/动态显示(如 `{{ status }}`)与绝对日期/数字(`toLocaleString` 等)不被
> `no-raw-text` 捕获,属另行跟踪的本地化专项,不在本闸范围。

### 5.3 接入点

- `typecheck`:受约束 typed `t` 在 `vue-tsc` 阶段拦截拼错 key(见 §1)。
- `lint-staged`(`.lintstagedrc.json`):提交触及 `web/src/**/*.{ts,vue,json}` 时跑 `pnpm i18n:check`。
- CI(`.github/workflows/ci.yml`):`typecheck` → `lint` → `i18n:check`,任一非零即红
  (lint 步不加 `--max-warnings 0`,故 `no-raw-text` 的 warn 现阶段不卡 CI)。

## 6. 文案抽取脚本(`pnpm i18n:extract`,脚本 `scripts/i18n/extract.mjs`)

半自动抽取全量可见文案、产出源语言基线的工具。**抽取是半自动的**:脚本只给
「候选 key → 原文」草稿,**key 命名与插值切分由人工/团队定稿**;en.json 定稿后 freeze 再分发。

### 6.1 两种模式

| 模式       | 命令                                                  | 行为                                                                                                                                                  |
| ---------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扫描(默认) | `pnpm i18n:extract`                                   | 用 `vue-eslint-parser` 全量 AST 扫 `web/src/**/*.vue` 的**模板文本节点** + **可译属性**,产出**稳定**候选清单到 `scripts/i18n/extract.candidates.json` |
| 合并       | `node scripts/i18n/extract.mjs --emit <mapping.json>` | 读人工定稿的 `{ "<dot.key>": "<原文>" }` 映射,展开为嵌套对象并**合并**进 `web/src/locales/en.json`(冲突即报错,**绝不静默覆盖**)                       |

扫描产出**确定性**(file → line → column 排序 + 同文件同文案去重计 `occurrences`):同一棵未变更的代码树两次运行**字节一致**。CLI 忽略多余入参(可安全挂 lint-staged),始终全量扫。候选清单是生成物、已 `.gitignore`,随时 `pnpm i18n:extract` 重生。

### 6.2 可译属性白名单(穷举兜漏)

`TRANSLATABLE_ATTRS` = `title`/`placeholder`/`alt`/`label`/`badge`/`content` +
`aria-label`/`aria-description`/`aria-placeholder`/`aria-roledescription`/`aria-valuetext`。
**刻意排除** ARIA 状态/关系属性(`aria-hidden`/`aria-expanded`/`aria-pressed`/`aria-haspopup`/
`aria-modal` 等)—— 它们载布尔/ID/token 而非文案,不可笼统前缀匹配 `aria-*`。

### 6.3 候选项 `kind` 与人工处理

| kind               | 含义                               | 人工处理                                                                                                                                             |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`             | 模板文本节点                       | 直接定稿 key                                                                                                                                         |
| `attr`             | 静态可译属性(`title="…"`)          | 直接定稿 key                                                                                                                                         |
| `bind-literal`     | 绑定到字符串字面量(`:title="'…'"`) | 直接定稿 key                                                                                                                                         |
| `mustache-literal` | `{{ '…' }}` 字面量插值             | 直接定稿 key                                                                                                                                         |
| `dynamic`          | 变量 / 三元 / 拼接 / 模板串        | **人工切分**:三元的每个字面量分支拆成独立 key;纯变量绑定(`:title="row.name"`)不产 key;模板串 `` `Open chat: ${x}` `` 切成具名插值 `"Open chat: {x}"` |

草稿 key 形如 `<namespace>.<subject>.<slug>[.<suffix>]`(见 §2),namespace 按文件路径启发式落到冻结九段;命不中 → `common` 且标 `nsGuess:true` 待人工复核归属。slug、suffix 同为草稿。

### 6.4 freeze → 分发流程

1. `pnpm i18n:extract` 产候选清单 → 人工据 §2 定稿 key、切分 `dynamic`、复核 `nsGuess`、剔除代码/环境标识符等非译项。
2. `--emit` 合并进 `en.json`(或手工编辑)→ 团队定稿措辞 → **freeze `en.json`**(源语言基线)。
3. 以 `en.json` 为 schema,新增非 en 语种文件并分发翻译;`i18n:check` 守覆盖率与占位符不漂移。

> 当前基线:`en.json` 已由本工具产出首版骨架(243 key,源语言覆盖率 100%,`i18n:check` 绿)。
> 组件模板尚未接 `t()`(留作下游接线任务),故现阶段全部 key 在 `i18n:check` 表现为 `unused` warning(不卡 CI)。

## 7. 服务端 code+params 协议(单一数据源)

> 适用范围:**服务端 → 前端展示**的错误/通知/toast。目标:消除 server 与 web 双份译文漂移
> —— 翻译只存 web 语言包,server 永不传译文。Hono 服务端日志/调试、发给 LLM 的 prompt 文案
> **保留英文,不纳入 i18n**。

### 7.1 原则

- server 对前端展示项**只回传机器可读 `{ code, params }`**(协议 `error: UiError`,见
  `websocket-protocol.md`),绝不回传译文。`params` 值可含英文技术细节(异常串)—— 属调试数据。
- web 收 `code` → 经**单一数据源** `UI_ERROR_CODES` 映射到 `error.*` key → `t(key, params)`。
- shared 协议层 key 与数据结构保持**英文常量不译**;`code`、`key` 皆英文。

### 7.2 单一数据源(SoT)= `shared/src/ui-codes.ts`

`UI_ERROR_CODES: Record<UiErrorCode, { key; params? }>` 一处登记 code→key(及允许的插值名);
`UiErrorCode` 由其 `keyof` 推导,server `send()` 因此类型安全。web 直接 import(shared 为
workspace 源链接,无运行期独立映射文件)。**这是唯一权威**;`en.json` 与 server 发送点都对它对齐。

### 7.3 构建期生成 + 校验

- `pnpm i18n:gen-codes`(`scripts/i18n/gen-code-map.mjs`):从 SoT 确定性派生
  `scripts/i18n/code-key.map.json`(排序、生成物 `.gitignore`,同 `extract.candidates.json` 模式)
  —— 供查阅/文档,**非第二数据源**。
- `pnpm i18n:check` 第四类校验(§5.1 末三行)守 SoT ↔ `en.json` ↔ `server/src` 三方一致,已接 CI:
  发未登记 code、key 缺失、params 与占位符漂移 → **CI 红**。

### 7.4 落地节奏

- Loop 1(基建先行):协议 `UiError`、SoT、生成脚本、第四类校验、2 样板 code。
- Loop 2(全量迁移,**已完成**):`server/src` 全部可见 error 点(24 code)迁到 `code+params`,
  协议 `error` **已移除 `message`、转必填**。`grep "type: 'error'" server/src` 全为 `error:{code}`。
- 仍属后续(spec 003 §9):web `.ts` composable 硬编码、no-raw-text 扩 `.ts`、枚举/原因码
  display label。
