# license-server(LS)

c3 的**许可证授权方**——一个独立的 Go 服务,持有权威的商业授权记录、套餐目录以及面向买家/管理员的 Web。
它**刻意与 c3 进程分离**(c3 进程内禁止数据库、身份提供方、支付集成与对公网监听,这些都活在这里),
见 [ADR-0026](../specs/architecture/adr/0026-product-licensing-separate-license-server.md)。

> **设计与接口契约**(进程形态、绑定/心跳流程、数据模型、签名信任链、**每个接口的输入输出**)集中在
> [license-server 架构规范](../specs/architecture/license-server-architecture.md);对外边界语义见
> [license-server API 契约](../specs/shared/api-conventions/license-server-api.md)。本 README 只做**代码级索引**,不复述设计。

## 技术栈

- **HTTP:** Go 标准库 `net/http` `ServeMux`——无框架。
- **持久化:** PostgreSQL(经 GORM 的 Postgres 驱动)。三表:`c3_ls_user` / `c3_ls_license` / `c3_ls_order`;
  schema 在 [`database/sql/`](database/sql/),每表一个幂等 DDL 文件、启动时全量应用(无迁移台账,索引见
  [`database/tables.md`](database/tables.md))。
- **前端:** [`web/`](web/) 下的 Vue 3 + Vite,所有页面为 SPA;构建到 `web/dist/` 并 `//go:embed` 内嵌,带 SPA 回退。
- **支付:** 微信支付 Native(统一下单 + 回调验签/解密)。
- **缓存:** 进程内 LRU(套餐目录)+ 进程内 `(installId, requestId)→{aliveToken, 实体令牌}` 待绑映射(带 TTL,不持久化)。

## 目录结构

```
license-server/
  cmd/license-server/      入口(config → caches → db/schema → 订单对账 Ticker 20min → http)
  internal/config/         环境变量驱动的配置 + 脱敏
  internal/cache/          泛型 LRU + 命名缓存注册表
  internal/plans/          代码持有的套餐集(c3_ls_plan 的引导种子)
  internal/agreement/      服务协议正文(内嵌)+ 版本(仅续费/支付时展示)
  internal/oauth/          账号登录用的 GitHub OAuth 客户端
  internal/token/          Ed25519 实体令牌签发
  internal/store/          PostgreSQL 数据访问(用户、套餐、license + 活动绑定、订单 + 状态机)
  internal/wechatpay/      微信支付 Native 网关:统一下单 + 回调验签/解密 + 订单查询(对账)
  internal/httpapi/        ServeMux、JSON API(/healthz、/v1/plans、/v1/auth/*、/v1/license/*、/v1/checkout、/v1/orders、/v1/payment/wechat/notify)、静态 + SPA 回退
  internal/version/        构建版本
  scripts/gen-keypair/     开发用 Ed25519 密钥对生成器
  database/                PostgreSQL schema——每表一个幂等 DDL 文件(内嵌)+ 索引
  web/                     Vue 源码;web/dist 提交进仓库并内嵌
```

接口清单与每个接口的请求/返回参数见
[架构规范 §10 接口参数明细](../specs/architecture/license-server-architecture.md)。

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
