# license-server(LS)架构

- **Status:** draft
- **Date:** 2026-06-17
- **References:** [ADR-0026](adr/0026-product-licensing-separate-license-server.md)（独立 license-server 的决策与例外记录）、
  [product-license 领域规范](../domains/commerce/product-license/product-license-spec.md)（业务行为与状态机）、
  [license-server API 契约](../shared/api-conventions/license-server-api.md)（c3 ↔ LS 的对外边界）、
  [license-server/README.md](../../license-server/README.md)（代码级实现索引）

> 本文描述 **license-server 自身的服务架构**:它的进程形态、内部分层、激活流程、数据模型与签名信任链。
> 它**不重复**三件已有文档:ADR-0026 记录"为何独立"的决策、领域规范记录"许可证如何运作"的业务行为、
> API 契约记录"c3 与 LS 如何通信"的线缆边界。需要这些内容时按 ID 引用,不在此处复述(C-DOC-1)。

## 1. 定位:一个与 c3 进程分离的授权方

c3 从免费本地工具转向**付费产品**后,需要一个权威回答单一问题的服务:**这个安装是否有权运行?**
这个答案不能只活在本地——纯本地校验可在机器间复制、可被伪造、且退款/滥用后永远无法**吊销**。
因此商业授权需要一个**服务端真相源**(ADR-0026)。

但 c3 的宪法基线在 **c3 进程内**禁止数据库、身份提供方、第二套 agent 运行时、非 loopback 监听。
授权方恰恰需要这些被禁能力。解法不是放松 c3 约束,而是把授权方放进一个**独立产品** license-server(LS):

```
┌──────────────────────────┐                      ┌────────────────────────────────────────┐
│  c3(本地单进程)          │                      │  license-server(独立部署)              │
│                          │   ① 登录注册(浏览器) │                                        │
│  license 客户端切片      │ ───────────────────► │  net/http ServeMux(无框架)            │
│   · 实体令牌离线校验     │   ② bind(S2S,JSON)   │   · /activate · /auth/github/callback  │
│   · 新会话门禁           │ ◄─────────────────── │   · /v1/license/bind · …/heartbeat     │
│   · ~/.c3/license.json   │   ③ 心跳(S2S,JSON)  │   · /v1/plans · 内嵌 Vue(//go:embed)  │
│     缓存(0600)          │ ◄──────────────────► │                                        │
│   · 内嵌公钥(只验签)    │                      │   ┌──────────────┐  ┌────────────────┐ │
└──────────────────────────┘                      │   │ PostgreSQL   │  │ Ed25519 私钥   │ │
            ▲                                      │   │ (授权真相源) │  │ (签发实体令牌) │ │
            │ 内嵌 LS 公钥(ADR-0010 同款签名纪律) │   └──────────────┘  └────────────────┘ │
            └──────────────────────────────────── │   GitHub OAuth · WeChat Pay(后续)     │
                                                   └────────────────────────────────────────┘
```

**信任方向是单向的:** LS 用 Ed25519 私钥签发实体令牌,c3 只内嵌**公钥**离线验签。
c3 二进制里除这把公钥外**不含任何 LS 机密**(私钥、OAuth client secret、支付凭证都只活在 LS)。

## 2. 进程形态与技术栈

LS 是一个**单 Go 二进制**,自带 `go.mod`,**不属于** c3 的 pnpm workspace。

| 维度       | 选择                                 | 说明                                                        |
| ---------- | ------------------------------------ | ----------------------------------------------------------- |
| HTTP       | Go 标准库 `net/http` `ServeMux`      | 无框架——小而可审计的攻击面(ADR-0026)                        |
| 持久化     | PostgreSQL(经 GORM 的 Postgres 驱动) | 授权真相源;每表一个幂等 DDL 文件内嵌进二进制,启动时全量应用 |
| 身份       | GitHub OAuth                         | **仅用于账号登录/注册**;买家登录与 admin 后台共用同一身份源 |
| 支付       | WeChat Pay(后续里程碑)               | 以 CNY 结算                                                 |
| 前端       | Vue 3 + Vite,`//go:embed` 内嵌       | 构建到 `web/dist/`,随二进制分发,带 SPA 回退                 |
| 签名       | Ed25519                              | LS 签实体令牌,c3 验签;复用 release 签名纪律(ADR-0010)       |
| 进程内缓存 | LRU                                  | plan 目录已用;license/auth/payment 读路径预留               |

## 3. 内部分层

LS 的内部按职责分包,入口 `cmd/license-server` 做接线:**config → caches → db/migrate → http**。
各组件按角色划分(代码级路径见 README):

```
入口(cmd)
  └─ 加载配置 → 建缓存注册表 → 连库并迁移 → 构造 HTTP Server → 监听到中断

HTTP 层(httpapi)
  · ServeMux:基础端点 /healthz、/v1/plans + 登录与 license bind/heartbeat 端点 + 静态/SPA 回退
  · API 路由在 handler 内自行校验方法 → 返回干净的 405,而非落到 "/" 静态回退被掩成 404
  · 浏览器登录面由 loginReady() 守卫:库 + OAuth + 签名私钥 + PublicURL 四者齐备才放行;
    c3 侧 bind/heartbeat 由 licenseAPIReady() 守卫:库 + 签名私钥即可(不需 OAuth/PublicURL)

领域/支撑组件
  · config    环境变量驱动的配置 + 日志/healthz 脱敏(机密只显示 set/unset)
  · cache     泛型 LRU + 命名缓存注册表
  · plans     固定 plan 目录(稳定 id + 价格)
  · agreement 不退款服务协议(单一来源,PL-R9)
  · oauth     GitHub OAuth 客户端(账号登录/注册)
  · token     Ed25519 实体令牌签发(PL-R5)
  · store     PostgreSQL 数据访问(c3_ls_user / c3_ls_license / c3_ls_order)
  · version   构建版本

数据层(database)
  · 每表一个幂等 DDL 文件(sql/<table>.sql,IF NOT EXISTS),启动时全量应用、重跑为 no-op
  · 刻意无迁移台账(无 schema_migrations 表)——幂等 DDL 让"记录已应用版本"变得多余,保持简单
  · 关系由业务逻辑维护,表上不建外键约束(故文件应用顺序无关,按文件名排序仅为日志稳定)
```

**依赖是单向的**:入口接线一切;httpapi 依赖各支撑组件;支撑组件之间互不反向依赖。

## 4. 登录注册与 license 绑定流程

激活被简化为两步、相互解耦:**(A) 浏览器侧** 用户用 GitHub 登录账号、拿到一个 **license key**;
**(B) c3 侧** 用 license key + 安装标识做绑定,换回签名实体令牌。GitHub **只用于账号登录/注册**,不再承载激活。

```
用户/浏览器                  LS                         GitHub
 │                            │                            │
 │ ① 打开 /activate ─────────►│ 渲染不退款协议页           │
 │ ② POST /activate/accept ──►│ 校验勾选 → 铸无状态签名     │
 │    (勾选接受)              │  state(HMAC over seed)    │
 │                            │ ─── authorize URL ────────►│
 │◄───────────────────────────────── 用户授权 ────────────┤
 │ ③ /auth/github/callback ──►│ 校验 state → 取 token/身份  │
 │                            │ upsert c3_ls_user          │
 │                            │ 若无 license 则发试用许可   │
 │◄── 渲染 license_key 列表页 ─│ (随机唯一 license_key)     │

c3                                       LS
 │ ④ 用户把 license_key 粘进 c3            │
 │   POST /v1/license/bind ───────────────►│ 按 key 查 license(校验未吊销/未过期)
 │   {licenseKey, installationId}          │ 写 alive_install_id=本安装、轮换 alive_token
 │                                         │ (库存哈希)、alive_time=now → 独占绑定
 │◄── 签名实体令牌 + aliveToken(明文一次) ─│ + plan + termEnd + heartbeatIntervalSeconds
 │ ⑤ 离线验签(内嵌公钥)→ 写 license.json(0600)
 │ ⑥ POST /v1/license/heartbeat ──────────►│ 按 key 查;install_id+alive_token 都匹配且
 │   {licenseKey, installationId, aliveToken}  active 未过期 → 刷新 alive_time + 返回刷新令牌
 │◄── status(active/disabled/expired) + (active 时)刷新实体令牌 + 下次 interval
```

**安全/语义不变量:**

- **license key 是句柄,不是凭证(PL-R2)**:它可被展示/分享,单凭它无法完成心跳;心跳由**每次绑定**生成、
  库内只存哈希、明文仅在 bind 时返回一次的 **alive token** 鉴权。
- **绑定是独占的(PL-R1/PL-R8)**:同一 license 同时只绑定一个安装。重新绑定到新安装会覆盖
  alive_install_id/alive_token,被取代的旧安装在下次心跳得到 `disabled` → 门禁,且**无法靠离线挽回**(等同吊销语义)。
- **协议接受**:试用走"GitHub 登录前勾选不退款协议"门;正式购买时把协议接受记录在订单上(PL-R9)。

## 5. 数据模型

LS 的 PostgreSQL schema 与 c3 的 `database/` 区**完全分离**(ADR-0026)。迁移内嵌进二进制、启动时幂等应用;
**表上不建数据库外键**,关系由业务逻辑维护(便于演进与分库)。完整索引见
[license-server/database/tables.md](../../license-server/database/tables.md)。

| 表              | 用途                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `c3_ls_user`    | GitHub 身份(买家 + admin 共用,GitHub 仅作账号登录/注册,PL-R9/PL-R11)                                                |
| `c3_ls_order`   | 购买记录 + 付款前记录的不退款接受;`license_id` 关联其延展的 license(付费订单延长 term/status)                       |
| `c3_ls_license` | 权威授权记录,以 `license_key`(随机唯一句柄)标识;内联独占绑定 `alive_install_id` / `alive_token`(哈希)/ `alive_time` |

模型被**简化**:激活与心跳状态内联到 license 行上(不再有一次性码、心跳令牌、心跳历史等辅助表),
`00_drop_legacy.sql` 在每次启动幂等地丢弃简化前的旧表(`activation_codes`/`activation_requests`/
`heartbeat_tokens`/`heartbeats` 及旧的 `user`/`orders`/`licenses`)。

schema **不设迁移台账**:每表一个 `IF NOT EXISTS` 的幂等 DDL 文件,启动时全量应用、重跑为 no-op,
演进表时**就地增量编辑**该文件即可,无需 `schema_migrations` 这类版本台账(保持服务简单)。

`alive_token` 作为 bearer 凭证**哈希后存储**(明文仅 bind 时返回一次),数据库泄露也无法还原原始凭证;
`license_key` 是可分享的句柄、明文存储并展示给用户(非 bearer)。

## 6. 实体令牌与签名信任链

实体令牌是 c3 在两次心跳之间**离线校验**的授权断言。信任来自 Ed25519 签名,**永远不来自网络**。

**线缆格式**(紧凑、URL 安全、无外部依赖,Go 端与 c3 端是孪生实现):

```
v1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
```

- 签名覆盖**确切字节** `v1.<payloadB64>`——即校验方从令牌自身重建的同一串字节,
  因此两端**无需**一个规范 JSON 编码器达成一致即可验签。
- Payload 携带:`installationId / licenseId / plan / status / termStart / termEnd / issuedAt / kid`(时间为 UTC Unix 秒,跨语言稳定)。
- `status` 在签发时恒为 `active`;**失效(grace/expired/disabled)由 c3 端**从令牌有效期窗口与心跳推导,
  绝不签发一个非 active 的令牌。
- `kid`(key id)= 公钥 SHA-256 前 16 个 hex 字符,便于将来轮换密钥时识别。

**c3 端的信任与门禁**(与本服务对称,细节见领域规范):c3 离线验签通过、且令牌在有效期内、且最近一次成功心跳在
grace 窗口(默认 30 分钟)内时,视为 `active`;否则**只门禁新会话创建**。验签失败按**不授权**处理(deny-by-default),
但在"绝不打断在途工作"与 deny-by-default 之间权衡——**只挡新会话,保留运行中的会话与在途 run**(承袭 ADR-0006)。

## 7. 配置与降级运行

LS **全部配置由环境变量驱动,无配置文件**。机密**绝不**写入日志或 `/healthz`(PL-R12,脱敏为 `set`/`unset`)。
关键变量(完整表见 README):

| 变量                                  | 何时必需 | 说明                                    |
| ------------------------------------- | -------- | --------------------------------------- |
| `C3_LS_DATABASE_URL`                  | 启用库时 | PostgreSQL DSN(机密);省略则 dbless 运行 |
| `C3_LS_LISTEN_ADDR`                   | 否       | 监听地址,默认 `:8787`                   |
| `C3_LS_PUBLIC_URL`                    | 激活时   | 外部基址(OAuth 回调)                    |
| `C3_LS_ED25519_PRIVATE_KEY`           | 激活时   | 令牌签名私钥(机密,仅 LS 持有)           |
| `C3_LS_ED25519_PUBLIC_KEY`            | 激活时   | 校验公钥(发布给 c3 内嵌)                |
| `C3_LS_GITHUB_OAUTH_CLIENT_ID/SECRET` | 激活时   | GitHub OAuth 应用凭证(secret 为机密)    |
| `C3_LS_GRACE_MINUTES`                 | 否       | 离线 grace 窗口,默认 `30`(PL-R4)        |
| `C3_LS_ADMIN_ALLOWLIST`               | 否       | 逗号分隔的 admin GitHub login(PL-R11)   |

**分级降级**是设计原则——缺失依赖不让服务崩溃,而是缩小可用面:

- **无 DSN / 库不可达**:仍提供 `/healthz`(degraded)与静态前端;迁移失败则视为真实运维错误而**致命退出**。
- **缺 OAuth / 签名私钥 / PublicURL 任一**:激活面返回清晰的 "unavailable",而非半可用流程。
- **私钥格式错误**:视为运维拼写错误,记录日志并容忍(签名禁用),让激活面报 unavailable 而非崩溃。

## 8. 构建与部署

```bash
make build      # 单二进制 dist/license-server
make release    # 先由 web/src 重建 web/dist,再构建
make test       # 单元/构建检查;设 C3_LS_TEST_DATABASE_URL 则跑实库迁移测试
```

迁移在 `C3_LS_DATABASE_URL` 配置时**启动自动应用**(幂等,重跑为 no-op)。二进制由本目录自有 Go module 构建,
**不属于** pnpm workspace。前端 `web/dist` 提交进仓库并随二进制内嵌。

## 9. 与 c3 的边界 + 后续里程碑

c3 ↔ LS 的对外契约(激活、心跳、支付、错误语义)**只在**
[license-server API 契约](../shared/api-conventions/license-server-api.md)记录一次,他处按 ID 引用(C-DOC-1)。

**里程碑状态:**

- ✅ **Foundation**:config、caches、迁移、`/healthz`、plan 目录、静态服务。
- ✅ **登录 + license 绑定**:不退款协议 + GitHub 登录 → 发试用许可(随机 license_key)→ c3 用 key 绑定本安装(`/v1/license/bind`)→ 签名实体令牌 + alive token。
- ✅ **心跳**:`/v1/license/heartbeat` 以 alive token 周期确认绑定 + 刷新令牌 + grace 窗口;绑定被取代返回 `disabled`,非 active(status `expired` 或到期)返回 `expired`。
- ⏳ **支付/续期**:WeChat Pay(CNY 结算)付费订单延长 license 的 term/status;MVP 为**无退款**(故意业务非目标,PL-R9/PL-R10)。
- ⏳ **admin 后台**:GitHub OAuth + allowlist 鉴权下的许可证/订单审查与 issue/force-expire(置 status `expired`)。

## 引用

- [ADR-0026](adr/0026-product-licensing-separate-license-server.md) — 独立 LS 的决策、宪法例外与合规条款。
- [product-license 领域规范](../domains/commerce/product-license/product-license-spec.md) — 业务行为、状态机、PL-R 规则。
- [license-server API 契约](../shared/api-conventions/license-server-api.md) — c3 ↔ LS 的线缆边界。
- [ADR-0010](adr/0010-release-and-distribution-trust.md) — 此处复用的 Ed25519 release 签名纪律。
- [ADR-0006](adr/0006-decouple-runs-from-connections.md) — "授权失效只挡新会话、保留在途 run" 的依据。
- [ADR-0023](adr/0023-auth-abstraction-network-exposure.md) — 刻意与 license 分离的 auth 边界。
- [license-server/README.md](../../license-server/README.md) — 代码级实现与端点索引。
