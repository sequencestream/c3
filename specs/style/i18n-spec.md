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
