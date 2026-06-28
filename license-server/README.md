# license-server(LS)

c3 的**许可证授权方**——一个独立的 Go 服务,持有权威的商业授权记录、套餐目录以及面向买家/管理员的 Web。
它**刻意与 c3 进程分离**(c3 进程内禁止数据库、身份提供方、支付集成与对公网监听,这些都活在这里),
见 [ADR-0026](../doc/architecture/adr/0026-product-licensing-separate-license-server.md)。

> **设计与接口契约**(进程形态、绑定/心跳流程、数据模型、签名信任链、**每个接口的输入输出**)集中在
> [license-server 架构规范](../doc/architecture/license-server-architecture.md);对外边界语义见
> [license-server API 契约](../doc/shared/api-conventions/license-server-api.md)。本 README 只做**代码级索引**,不复述设计。

## 技术栈

- **HTTP:** Go 标准库 `net/http` `ServeMux`——无框架。
- **持久化:** PostgreSQL(经 GORM 的 Postgres 驱动)。三表:`c3_ls_user` / `c3_ls_license` / `c3_ls_order`;
  schema 在 [`database/sql/`](database/sql/),每表一个幂等 DDL 文件、启动时全量应用(无迁移台账,索引见
  [`database/tables.md`](database/tables.md))。
- **前端:** [`web/`](web/) 下的 Vue 3 + Vite,所有页面为 SPA;构建到 `web/dist/` 并 `//go:embed` 内嵌,带 SPA 回退。
- **支付:** 微信支付 Native(统一下单 + 回调验签/解密)。
- **缓存:** 进程内 LRU(套餐目录)+ 进程内 `(installId, requestId)→{aliveToken, 实体令牌}` 待绑映射(带 TTL,不持久化)。

## 目录结构

分层:**httpapi(薄传输)→ 领域模块(users/licenses/orders/plans/payments)→ store(仅 DB 句柄)→ database**。
每个领域模块自包含 `model.go`(类型)+ `data.go`(该表 CRUD 的 Repo)+ `service.go`(业务编排);CRUD 不在 store 里。

```
license-server/
  cmd/license-server/      入口(config → caches → db/schema → 建各领域 Repo → 订单对账 Ticker → http)
  internal/config/         环境变量驱动的配置 + 脱敏
  internal/cache/          泛型 LRU + 命名缓存注册表
  internal/agreement/      服务协议正文(内嵌)+ 版本(仅续费/支付时展示)
  internal/oauth/          账号登录用的 GitHub OAuth 客户端
  internal/token/          Ed25519 实体令牌签发原语
  internal/store/          仅 PostgreSQL 连接句柄(Available/DB);不含 CRUD——CRUD 在各领域模块 Repo
  internal/users/          c3_ls_user 身份 Repo + 登录/注册编排(注册即 provision 默认 license)
  internal/licenses/       c3_ls_license Repo(绑定/心跳/续期 tx)+ 激活/绑定/心跳业务 + 实体令牌签发 + 待绑注册表
  internal/orders/         c3_ls_order Repo(状态机)+ 续费规则;结算跨表事务协调 plans/licenses 的 tx 方法
  internal/plans/          代码内置套餐目录 + c3_ls_plan 持久化 Repo + 目录读穿(库优先,回退内置)
  internal/payments/       桥接微信支付网关到订单状态机(下单 Prepay / 回调 ProcessNotify);无自有表
  internal/wechatpay/      微信支付 Native 网关:统一下单 + 回调验签/解密 + 订单查询(对账)
  internal/reconcile/      订单对账 Ticker(经 orders.Repo 结算 pending 订单)
  internal/httpapi/        薄传输层:ServeMux、JSON API、静态 + SPA 回退;NewServer 由原始依赖组装领域服务层
  internal/version/        构建版本
  scripts/gen-keypair/     开发用 Ed25519 密钥对生成器
  database/                PostgreSQL schema——每表一个幂等 DDL 文件(内嵌)+ 索引
  web/                     Vue 源码;web/dist 提交进仓库并内嵌
```

接口清单与每个接口的请求/返回参数见
[架构规范 §10 接口参数明细](../doc/architecture/license-server-architecture.md)。

## 前端国际化(i18n)

`web/` 用 [`vue-i18n`](https://vue-i18n.intlify.dev/) 做中英双语,右上角有全局语言切换;
所选语言写入 `localStorage`(键 `c3ls.uiLang`),刷新后保持。首屏语言:`localStorage` →
`navigator.language`(`zh*` → 中文,其余 → 英文)→ 默认中文。

- **资源文件**:`web/src/locales/zh.json` 与 `web/src/locales/en.json`。`zh.json` 是基准,
  其结构推导出编译期 key 类型 —— 拼错的 key 会在 `npm run build`(`vue-tsc --noEmit`)阶段报错。
- **装配**:`web/src/i18n/index.ts`(`createI18n` + `setLocale` 切换/持久化 helper);
  `main.ts` 经 `app.use(i18n)` 注册。
- **用法**:组件里 `const { t } = useTypedI18n()`,模板用 `t('account.title')`;含变量的句子用
  `t('agreement.version', { version })` 或模板里的 `<i18n-t keypath="…">`(变量走具名插槽)。
  组件外(如 `lib/`)用 `import { t } from '../i18n'` 的全局 `t`。

**新增/维护文案约定:**

1. 按英文语义命名 key,沿用主 `web` 的 `doc/style/i18n-spec.md` 风格(`view.purpose` 点分层级)。
2. **`zh.json` 与 `en.json` 必须同时补齐同一 key**(键集合一致),否则会触发 fallback 警告;
   `web/src/i18n/i18n.test.ts` 有一条「键集合一致」测试守这条线。
3. 只本地化**前端渲染**的固定文案(标题、按钮、表单标签、前端生成的提示/错误兜底文案等)。
   **不翻译后端返回的展示数据**:套餐名 `PlanTier.name` / `Plan.name`、权益表 `TierCapability.*`、
   协议 `title`/`markdown`、接口 `error.message` —— 这些按服务端返回原样渲染。
4. 改完跑 `cd web && npm run build`(重建内嵌 `dist/`)与 `npx vitest run`。

## 配置

全部配置由环境变量驱动,无配置文件。机密绝不写入日志或 `/healthz`(脱敏为 `set`/`unset`)。

| 变量                               | 何时必需   | 默认     | 说明                                                              |
| ---------------------------------- | ---------- | -------- | ----------------------------------------------------------------- |
| `C3_LS_DATABASE_URL`               | 启用库时   | —        | PostgreSQL DSN(机密)。省略则 dbless 运行。                        |
| `C3_LS_LISTEN_ADDR`                | 否         | `:8787`  | HTTP 监听地址                                                     |
| `C3_LS_PUBLIC_URL`                 | 登录时     | —        | 进程自身基址(本地监听);开发用 http://localhost:8787;`C3_LS_BASE_URL` 留空时作对外 URL 的回退 |
| `C3_LS_BASE_URL`                   | 反代后     | —        | 对外可见基址,用于构造 OAuth 回调 / 微信 notify / Cookie Secure;留空回退 `C3_LS_PUBLIC_URL`;生产填 https://c3.sequencestream.com |
| `C3_LS_ED25519_PRIVATE_KEY`        | 登录时     | —        | 令牌签名私钥(机密,仅 LS 持有);`go run ./scripts/gen-keypair`     |
| `C3_LS_ED25519_PUBLIC_KEY`         | 登录时     | —        | 校验公钥(发布给 c3 内嵌;用上面命令的输出)                         |
| `C3_LS_GITHUB_OAUTH_CLIENT_ID`     | 登录时     | —        | GitHub OAuth 应用 id                                              |
| `C3_LS_GITHUB_OAUTH_CLIENT_SECRET` | 登录时     | —        | GitHub OAuth 应用 secret(机密)                                    |
| `C3_LS_WECHAT_PAY_MCH_ID`          | 支付时     | —        | 微信支付直连商户号                                                |
| `C3_LS_WECHAT_PAY_APP_ID`          | 支付时     | —        | 绑定商户的公众号/应用 AppID                                        |
| `C3_LS_WECHAT_PAY_CERT_SERIAL_NO`  | 支付时     | —        | 商户证书序列号                                                    |
| `C3_LS_WECHAT_PAY_API_KEY`         | 支付时     | —        | 微信支付 **APIv3 key**(签请求、解密回调)(机密)                   |
| `C3_LS_WECHAT_PAY_PRIVATE_KEY`     | 支付时     | —        | 商户私钥(apiclient_key.pem),**base64 编码**(机密)               |
| `C3_LS_WECHAT_PAY_CERT`            | 支付时     | —        | 商户证书(apiclient_cert.pem),**base64 编码**                     |
| `C3_LS_LRU_SIZE`                   | 否         | `1024`   | 每个缓存的容量                                                    |
| `C3_LS_GRACE_MINUTES`              | 否         | `30`     | 离线 grace 窗口                                                   |
| `C3_LS_ADMIN_ALLOWLIST`            | 否         | —        | 逗号分隔的 admin GitHub login                                     |
| `C3_LS_ARTIFACT_UPLOAD_TOKEN`      | 上传时     | —        | 构建产物上传端点的固定 bearer token(机密);与 dir 同时设置才启用端点 |
| `C3_LS_ARTIFACT_DIR`               | 上传时     | —        | 上传产物落盘根目录,布局 `<dir>/<version>/<batch>/<filename>`;留空则端点关闭 |
| `C3_LS_ARTIFACT_MAX_BYTES`         | 否         | `209715200`(200MiB) | 单次上传体积上限                                       |

## 产物上传端点

`POST /v1/artifact/upload` —— c3 发布流水线把每个**已签名**产物逐文件推到自建存储(替代上传到 GitHub Actions artifact)。

- **启用条件**:`C3_LS_ARTIFACT_UPLOAD_TOKEN` 与 `C3_LS_ARTIFACT_DIR` 同时设置;否则返回 `503 unavailable`。
- **认证**:`Authorization: Bearer <token>`,常量时间比较;失败 `401`。
- **请求**:`?version=<v>&batch=<ts>&filename=<name>`,body 为文件原始字节(`application/octet-stream`);可选 `X-Artifact-Sha256: <hex>` 由服务端比对。
- **落盘**:`<C3_LS_ARTIFACT_DIR>/<version>/<batch>/<filename>`;`version`/`batch`/`filename` 经白名单字符校验 + basename 强制,杜绝目录穿越;先写临时文件再原子 rename。
- **响应**:`200 {"path","size","sha256"}`。

发布端脚本见 `scripts/publish/upload-to-server.mjs`(配 `C3_ARTIFACT_SERVER_URL` / `C3_ARTIFACT_UPLOAD_TOKEN`)。

## 产物下载/查询端点

以下端点均为**匿名公开** GET，只需设置 `C3_LS_ARTIFACT_DIR`；未设置时统一返回 `503 unavailable`。它们只暴露每个版本字典序最新的时间批次(`YYYYMMDD-HHmmZ`)，不要求上传 bearer token。

- `GET /v1/artifact/latest`：返回最新稳定语义版本及其批次，形如 `{"version":"v1.2.3","batch":"20260622-1200Z"}`。预发布目录不会参与 latest 选择；没有可用版本返回 `404`。
- `GET /v1/artifact/{version}/targets`：`version` 必须与上传目录一致，使用 `vX.Y.Z` 格式。返回该版本最新批次的 `{version,batch,targets}`；每项 target 含 `target`(os_arch)、`file`、`sha256`、`bytes`。
- `GET /v1/artifact/download?version=vX.Y.Z&os_arch=<target>&type=binary|sha256`：`binary` 流式返回对应包文件，使用 `application/octet-stream` 和附件文件名；`sha256` 返回对应 `<package>.sha256` 文本。不存在的版本、目标或文件返回 `404`，非法参数返回 `400`。

目录扫描与 manifest 解析结果保存在进程内 LRU（沿用 `C3_LS_LRU_SIZE`）30 秒；上传成功会立即失效该版本及 latest 缓存。包体和 sidecar 不缓存，每次直接从磁盘读取。

## 构建与运行

```bash
make build                      # 单二进制 dist/license-server
make release                    # 先由 web/src 重建 web/dist,再构建
make test                       # 单元/构建检查
C3_LS_TEST_DATABASE_URL=postgres://… make test   # 同时跑实库 schema 测试
dist/license-server             # 运行(设 C3_LS_DATABASE_URL 启用 store)
```

设置了 `C3_LS_DATABASE_URL` 时,schema 在启动自动应用(幂等 DDL,重跑为 no-op,无迁移台账)。二进制由本目录自有的
Go module 构建——**不属于** pnpm workspace。
</content>
