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
┌──────────────────────────┐                          ┌─────────────────────────────────────────┐
│  c3 server(本地单进程)   │                          │  license-server(独立部署)               │
│                          │  ① 拉起浏览器→Vue SPA(/) │                                         │
│  license 客户端切片      │ ───────────────────────► │  net/http ServeMux(无框架)             │
│   · 生成 installId       │                          │   浏览器/SPA 面:                        │
│     (安装级稳定)         │  ② checkbind 轮询(S2S)   │    · /v1/auth/login                      │
│   · 每轮生成 requestId    │ ◄───────────────────────►│    · /v1/auth/github/callback            │
│     (32 位唯一)          │  拿到 aliveToken+实体令牌  │    · /v1/license/activate · bind         │
│   · 实体令牌离线验签      │  ③ 心跳(S2S,JSON)       │    · /v1/checkout · /v1/orders · 内嵌 Vue│
│   · 新会话门禁           │ ◄───────────────────────►│   c3 S2S 面:                            │
│   · ~/.c3/license.json   │  刷新实体令牌            │    · /v1/license/checkbind · heartbeat   │
│     缓存(0600)          │                          │    · /v1/plans · /healthz                │
│   · 内嵌公钥(只验签)    │                          │   ┌──────────────┐  ┌────────────────┐  │
└──────────────────────────┘                          │   │ PostgreSQL   │  │ Ed25519 私钥   │  │
            ▲                                          │   │ (授权真相源) │  │ (签发实体令牌) │  │
            │ 内嵌 LS 公钥(ADR-0010 同款签名纪律)     │   └──────────────┘  └────────────────┘  │
            └───────────────────────────────────────  │   GitHub OAuth · WeChat Pay Native       │
                                                       └─────────────────────────────────────────┘
```

**信任方向是单向的:** LS 用 Ed25519 私钥签发**实体令牌**,c3 只内嵌**公钥**离线验签(甲案,见 §6)。
**绑定是浏览器中介的设备式流程:** c3 server 生成 `installId`(安装级稳定)与本轮 `requestId`(32 位唯一),
拉起系统浏览器打开 LS 的 **Vue SPA**(经 `/` 访问);用户在浏览器内登录并选定一条 license 完成绑定,
c3 server 则**带着同一对 `(installId, requestId)` 轮询 `/v1/license/checkbind`**,在绑定完成后取回 `aliveToken`
**与签名实体令牌**。二者走 **S2S 通道**返回 c3,**绝不**经浏览器暴露(PL-R2);心跳刷新实体令牌。
c3 二进制里除这把公钥外**不含任何 LS 机密**。

## 2. 进程形态与技术栈

LS 是一个**单 Go 二进制**,自带 `go.mod`,**不属于** c3 的 pnpm workspace。

| 维度       | 选择                                 | 说明                                                                                           |
| ---------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| HTTP       | Go 标准库 `net/http` `ServeMux`      | 无框架——小而可审计的攻击面(ADR-0026)                                                           |
| 持久化     | PostgreSQL(经 GORM 的 Postgres 驱动) | 授权真相源;每表一个幂等 DDL 文件内嵌进二进制,启动时全量应用                                    |
| 身份       | GitHub OAuth                         | **仅用于账号登录/注册**;买家登录与 admin 后台共用同一身份源                                    |
| 支付       | WeChat Pay Native                    | 以 CNY 结算                                                                                    |
| 前端       | Vue 3 + Vite,`//go:embed` 内嵌       | **所有页面均为 Vue SPA,经 `/` 访问**(登录/选 license/续费/账户);后端只提供 JSON API + SPA 回退 |
| 签名       | Ed25519                              | LS 签实体令牌,c3 验签;复用 release 签名纪律(ADR-0010)                                          |
| 进程内缓存 | LRU                                  | plan 目录已用;license/auth/payment 读路径预留                                                  |

## 3. 内部分层

LS 的内部按职责分包,入口 `cmd/license-server` 做接线:**config → caches → db/migrate → http**。
各组件按角色划分(代码级路径见 README):

```
入口(cmd)
  └─ 加载配置 → 建缓存注册表 → 连库并迁移 → 启动订单对账 Ticker(20min,库+支付就绪时)→ 构造 HTTP Server → 监听到中断

HTTP 层(httpapi)
  · ServeMux:JSON API(均 /v1 前缀:/v1/plans、/v1/auth/*、/v1/license/*、/v1/checkout、/v1/orders、
    /v1/payment/wechat/notify;外加运维 /healthz)+ 内嵌 Vue 的静态/SPA 回退;所有页面是 Vue,经 / 访问
  · API 路由在 handler 内自行校验方法 → 返回干净的 405,而非落到 "/" 静态回退被掩成 404
  · 浏览器登录面由 loginReady() 守卫:库 + OAuth + 签名私钥 + PublicURL 四者齐备才放行;
    c3 侧 checkbind/heartbeat 由 licenseAPIReady() 守卫:库 + 签名私钥即可(不需 OAuth/PublicURL)
  · bindreq:进程内 (installId, requestId) → {aliveToken, 实体令牌} 的待绑映射(带 TTL),
    bind 写入、checkbind 读取后消费;不持久化(承袭 ADR-0006 的进程内状态纪律)

领域/支撑组件
  · config    环境变量驱动的配置 + 日志/healthz 脱敏(机密只显示 set/unset)
  · cache     泛型 LRU + 命名缓存注册表
  · plans     固定 plan 目录(稳定 plan_key + 价格)
  · agreement 不退款服务协议(单一来源,PL-R9;仅在续费/支付时展示)
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

## 4. 登录与 license 绑定流程

绑定是**浏览器中介的设备式流程**:c3 server 生成 `installId` 与 `requestId` 后拉起浏览器,用户在 LS 的
Vue SPA 内登录(GitHub)并**选一条 license** 完成绑定;c3 server 不接触浏览器会话,而是带着同一对
`(installId, requestId)` 轮询 `checkbind` 取回 `aliveToken` 与签名实体令牌。每个用户在登录后**自动拥有一条默认 license**,
无需手动创建。登录页与激活页**不展示协议**——协议只在续费/支付时展示并按订单记录(PL-R9)。

```
c3 server                浏览器 / Vue SPA(/)            LS                       GitHub
 │                          │                            │                          │
 │ ① 生成 installId(稳定)、requestId(32 位唯一)          │                          │
 │ ② 拉起浏览器 /?installId&requestId ───────────────────►│                          │
 │                          │ ③ 未登录→登录页            │                          │
 │                          │   POST /v1/auth/login ────►│ 铸无状态 state(HMAC)    │
 │                          │                            │ ── authorize URL ───────►│
 │                          │◄──────────────── 用户授权 ──────────────────────────┤
 │                          │ ④ /v1/auth/github/callback►│ 校验 state→取身份        │
 │                          │                            │ upsert c3_ls_user        │
 │                          │                            │ 确保默认 license(自动建) │
 │                          │◄── set 会话 cookie→回 SPA ─│                          │
 │                          │ ⑤ GET /v1/license/activate │ 登记 (installId,         │
 │                          │    ?installId&requestId ──►│ requestId)→pending       │
 │                          │◄──── 该用户 license 列表 ──│                          │
 │                          │ ⑥ 用户选定一条 license     │                          │
 │                          │   POST /v1/license/bind ──►│ 独占绑定:写 aliveInstallId
 │                          │   {installId,requestId,    │ =本安装、轮换 aliveToken  │
 │                          │    licenseKey}             │ (库存哈希)、aliveTime=now │
 │                          │                            │ 签实体令牌;并把 (installId,
 │                          │◄──── {status, termEnd} ────│ requestId)→{aliveToken,令牌}
 │                          │  (aliveToken/令牌不回浏览器) │ 存内存(TTL)             │
 │ ⑦ GET /v1/license/checkbind?installId&requestId ─────►│ 命中内存映射:消费并返回  │
 │◄─ {status, aliveToken, entitlementToken, termEnd} ────│ aliveToken+令牌(S2S)    │
 │   (未完成则 {status:"pending"})                        │                          │
 │ ⑧ POST /v1/license/heartbeat {installId, aliveToken} ►│ 按 installId+aliveToken   │
 │◄ {status, entitlementToken, heartbeatIntervalSeconds, │ 哈希查活动绑定、刷新 time │
 │    termEnd}                                            │ 并重签实体令牌(active)   │
```

**安全/语义不变量:**

- **aliveToken 与实体令牌只走 S2S,绝不经浏览器(PL-R2)**:aliveToken 由**每次绑定**生成、库内只存哈希;
  明文连同签名实体令牌先放进进程内 `(installId, requestId)` 映射,**仅由 c3 server 的 `checkbind` 取回一次**,
  浏览器/bind 响应里看不到它们。
- **实体令牌是离线门禁依据(甲案,PL-R5)**:c3 用内嵌公钥离线验签;令牌由 checkbind 首发、heartbeat 在 `active` 时重签刷新(见 §6)。
- **绑定是独占的(PL-R1/PL-R8)**:同一 license 同时只绑定一个安装。重新绑定会覆盖
  aliveInstallId/aliveToken,被取代的旧安装在下次心跳得到 `disabled` → 门禁,且**无法靠离线挽回**(等同吊销语义)。
- **requestId 一次性、带 TTL**:`(installId, requestId)` 待绑映射在 checkbind 命中后消费、过期后失效,
  避免一轮 request 被反复取走凭证。
- **默认 license 自动生成**:用户首次登录即拥有一条默认 license,激活页直接可选,无需手动创建/粘贴 key。
- **协议只在支付时**:登录/激活页不展示协议;续费下单时展示并把接受记录在订单上(PL-R9)。

## 5. 数据模型

LS 的 PostgreSQL schema 与 c3 的 `database/` 区**完全分离**(ADR-0026)。迁移内嵌进二进制、启动时幂等应用;
**表上不建数据库外键**,关系由业务逻辑维护(便于演进与分库)。完整索引见
[license-server/database/tables.md](../../license-server/database/tables.md)。

| 表              | 用途                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `c3_ls_user`    | GitHub 身份(买家 + admin 共用,GitHub 仅作账号登录/注册,PL-R9/PL-R11)                                                                   |
| `c3_ls_order`   | 购买记录 + 付款前记录的不退款接受;`license_id` 关联其延展的 license(付费订单延长 term/status);`order_no` 业务订单号(支付关联编号,见下) |
| `c3_ls_license` | 权威授权记录,以 `license_key`(随机唯一句柄)标识;内联独占绑定 `alive_install_id` / `alive_token`(哈希)/ `alive_time`                    |

模型被**简化**:激活与心跳状态内联到 license 行上(不再有一次性码、心跳令牌、心跳历史等辅助表),
`00_drop_legacy.sql` 在每次启动幂等地丢弃简化前的旧表(`activation_codes`/`activation_requests`/
`heartbeat_tokens`/`heartbeats` 及旧的 `user`/`orders`/`licenses`)。

schema **不设迁移台账**:每表一个 `IF NOT EXISTS` 的幂等 DDL 文件,启动时全量应用、重跑为 no-op,
演进表时**就地增量编辑**该文件即可,无需 `schema_migrations` 这类版本台账(保持服务简单)。

`alive_token` 作为 bearer 凭证**哈希后存储**(明文仅 bind 时生成、经 checkbind 由 c3 server 取回一次),
数据库泄露也无法还原原始凭证;`license_key` 是 license 的稳定句柄(非 bearer)。

**默认 license**:用户首次 GitHub 登录(`/v1/auth/github/callback`)时,LS 自动为其确保一条默认 license
(`c3_ls_license` 一行),激活页直接可选,无需手动创建。续费订单延长该 license 的 term/status。

**订单号 `order_no`**:`c3_ls_order` 的人类可读业务编号,创建订单时生成,格式
`C3 + YYYYMMDDHHmmssSSS + random(4)`(前缀 `C3` + 17 位毫秒级时间戳 + 4 位随机),库内**唯一**。
它**用作微信支付的关联编号**——下单时作为 `out_trade_no` 传给微信,回调按它(而非自增主键)定位订单。
自增主键 `id` 仍是内部关系键,`order_no` 是对外/对账面可见的订单标识。

**跨表写入的原子性**:履约时"把订单置 `paid`"与"延长关联 license 的 `term_end`/`status`"是**两张表的关联写入**,
必须在**单个数据库事务内**完成——要么同时生效,要么同时回滚,绝不出现"订单已 paid 但 license 未延期"(或反之)的中间态。
回调(§10.5)与定时对账(§11)走**同一条事务化履约函数**,并在事务内**先核对订单当前状态**(已 `paid`/`expired` 则跳过延期),
使整条履约对重复回调/重复对账**幂等**。表上虽不建外键,这条一致性由该事务保证。

## 6. 实体令牌与签名信任链

> **令牌投递通道(甲案,已定)**:`bind` 是浏览器调用,响应**不含**令牌(避免经浏览器暴露,PL-R2);
> 签名实体令牌经 **S2S 通道**到达 c3——由 **`checkbind` 首发**(随 `aliveToken` 一并返回),
> 并在 **`heartbeat` 的 `active` 应答中重签刷新**。`bind` 返回 `{status, termEnd}` 只供浏览器即时反馈,不承载信任。

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
- 🔧 **登录 + 浏览器中介绑定(本轮改版,待实现)**:GitHub 登录(无协议)→ 自动默认 license → Vue 激活页选 license →
  `POST /v1/license/bind`(`installId`+`requestId`)→ c3 server `GET /v1/license/checkbind` 轮询取回 `aliveToken` + 实体令牌。
- 🔧 **心跳(本轮改版,待实现)**:`POST /v1/license/heartbeat`(仅 `installId`+`aliveToken`)→ `{status, entitlementToken, heartbeatIntervalSeconds, termEnd}`;
  绑定被取代返回 `disabled`,非 active 返回 `expired`。
- 🔧 **支付/续期(本轮改名,待实现)**:`POST /v1/checkout`(`planKey`)创建订单(`order_no` 支付关联编号、**15 分钟支付超时**、**续期不超 1 年**)+ 微信支付 Native 扫码,回调延长 license 的 term/status;**20 分钟定时对账**收敛 pending 订单;MVP **无退款**(PL-R9/PL-R10)。`GET /v1/orders` 列已支付订单。
- ⏳ **admin 后台**:GitHub OAuth + allowlist 鉴权下的许可证/订单审查与 issue/force-expire(置 status `expired`)。

## 10. 接口参数明细

本节是本轮改版后的**目标接口契约**,逐接口给出请求/返回参数,与 [license-server/README.md](../../license-server/README.md) 同步
(README 不再复述设计,只指回本节)。约定:

- **路径**:所有功能 API 均以 `/v1` 前缀;`/healthz`(运维存活)与 `/`(Vue SPA)是仅有的例外。
- **命名**:请求/返回字段一律 **camelCase**;时间一律 UTC Unix 秒;金额 `*Cents` 为币种最小单位。
- **JSON 错误信封**:所有 JSON 接口出错统一为 `{"error":{"type":"<错误码>","message":"<说明>"}}`,以字符串 `type` 区分。
- **会话**:浏览器/Vue 调用的接口需登录会话 cookie;未登录返回 `401`(SPA 据此跳登录页)。
- **S2S**:`checkbind`/`heartbeat` 由 c3 server 直连调用,不需会话 cookie。
- **身份**:`installId` 为 c3 安装级稳定标识,**唯一、最长 128 字符**;`requestId` 为 c3 server 每轮生成的 32 位唯一 id。
  二者均由 c3 server 生成;服务端校验长度上限(`installId` ≤ 128、`requestId` = 32),超限即 `400 invalid_request`。

### 10.1 Foundation

**`GET /healthz`** — 存活探测 + 脱敏配置(运维端点,不带 `/v1`)。请求无参数。返回 `200` JSON:`status`(恒 `"healthy"`)、
`version`(构建版本)、`checks.database`(`ok`/`unreachable`/`not_configured`)、`config`(脱敏配置视图)。`config` 含 `listenAddr`/`publicUrl`/
`lruSize`/`graceMinutes`/`adminAllowlistCount`(数量)及各机密/密钥的 `set`/`unset` 存在指示,机密绝不显示值(PL-R12)。

**`GET /v1/plans`** — 公开套餐目录。请求无参数。返回 `200` JSON `{ "plans": Plan[] }`,每个 `Plan`:

| 字段             | 类型   | 说明                     |
| ---------------- | ------ | ------------------------ |
| `planKey`        | string | 稳定套餐键(原 `id` 改名) |
| `name`           | string | 展示名                   |
| `durationMonths` | number | 时长(月)                 |
| `priceCents`     | number | 价格(最小单位)           |
| `currency`       | string | ISO-4217(MVP `CNY`)      |

库不可达时回退代码内置目录。

**`GET /*`** — 内嵌 Vue SPA(登录/激活/续费/账户均为 Vue 路由),非 API 路由回退 `index.html`。

### 10.2 登录(浏览器 / Vue)

**`POST /v1/auth/login`** — 发起 GitHub OAuth 登录(原 `POST /activate/accept` 改名;**不再展示/校验协议**)。
请求体可携带 `installId`、`requestId`(透传,供回调后跳回激活页)。成功 → `303` 重定向到 GitHub authorize URL
(state 为无状态 HMAC 签名,透传回跳目标);未就绪(缺库/OAuth/签名私钥/PublicURL)→ `503`。

**`GET /v1/auth/github/callback`** — OAuth 回调。query:`code`、`state`(失败时 GitHub 带 `error`/`error_description`)。
校验 state → 取身份 → upsert `c3_ls_user` → **确保默认 license(自动创建)** → 写登录会话 cookie →
`303` 跳回 Vue 激活页(带回 `installId`/`requestId`)。失败 → `400`/`502`/`500`。

**`GET /v1/session`** — SPA 查询登录态(支撑接口)。返回 `200` JSON `{ "signedIn": bool, "login": string }`(未登录 `signedIn:false`)。

### 10.3 license 绑定

**`GET /v1/license/activate`** — 激活页拉取数据并登记本轮待绑请求(浏览器/会话)。

| 方向 | 字段/参数   | 类型  | 说明                                                                                                |
| ---- | ----------- | ----- | --------------------------------------------------------------------------------------------------- |
| 请求 | `installId` | query | 必填;c3 安装标识                                                                                    |
| 请求 | `requestId` | query | 必填;c3 本轮 32 位唯一 id                                                                           |
| 返回 | `licenses`  | array | 当前用户的 license 列表,每项 `licenseKey`/`planKey`/`termEnd`/`status`/`aliveInstallId`/`aliveTime` |

副作用:在内存登记 `(installId, requestId)` → pending(带 TTL)。未登录 → `401`;未就绪 → `503`。
**不**返回 `aliveToken`/`entitlementToken`(PL-R2)。

**`POST /v1/license/bind`** — 把所选 license 绑定到本安装(浏览器/会话)。

| 方向 | 字段         | 类型   | 说明                                        |
| ---- | ------------ | ------ | ------------------------------------------- |
| 请求 | `installId`  | string | 必填;c3 安装标识,独占绑定                   |
| 请求 | `requestId`  | string | 必填;本轮 32 位唯一 id(用于 checkbind 取回) |
| 请求 | `licenseKey` | string | 必填;用户在激活页选定的 license             |
| 返回 | `status`     | string | `"active"`                                  |
| 返回 | `termEnd`    | number | 期限结束(UTC Unix 秒)                       |

副作用:独占绑定(写 `aliveInstallId`=本安装、**轮换** `aliveToken` 存哈希、`aliveTime`=now),签发实体令牌,并把
`(installId, requestId)` → `{aliveToken, entitlementToken}`(明文)存进内存映射供 `checkbind` 取回。
**响应不含 `aliveToken`/`entitlementToken`**(不经浏览器,PL-R2)。
错误:`400 invalid_request`、`404 invalid_key`(license 不存在或不属本人)、`410 expired`、`401`(未登录)、`500 bind_failed`、`503 unavailable`。

**`GET /v1/license/checkbind`** — c3 server 轮询本轮是否已完成绑定(S2S)。

| 方向 | 字段/参数          | 类型   | 说明                                                           |
| ---- | ------------------ | ------ | -------------------------------------------------------------- |
| 请求 | `installId`        | query  | 必填                                                           |
| 请求 | `requestId`        | query  | 必填;须与 bind 时一致                                          |
| 返回 | `status`           | string | `"pending"`(未绑定)/ `"active"`(已绑定)                        |
| 返回 | `aliveToken`       | string | **仅 `active`** 时返回的明文 bearer 凭证(取回后映射消费)       |
| 返回 | `entitlementToken` | string | **仅 `active`** 时返回的 Ed25519 签名令牌 `v1.<payload>.<sig>` |
| 返回 | `termEnd`          | number | **仅 `active`** 时返回(UTC Unix 秒)                            |

未命中(未绑定 / TTL 过期 / 未知 request)→ `200` `{status:"pending"}`(便于 c3 继续轮询)。命中即消费该映射,重复取回得 `pending`。
错误:`400 invalid_request`、`503 unavailable`。

**`POST /v1/license/heartbeat`** — c3 server 周期确认活动绑定并刷新(S2S)。

| 方向 | 字段                       | 类型   | 说明                                          |
| ---- | -------------------------- | ------ | --------------------------------------------- |
| 请求 | `installId`                | string | 必填;定位活动绑定                             |
| 请求 | `aliveToken`               | string | 必填;bearer 凭证(按哈希匹配)                  |
| 返回 | `status`                   | string | `"active"` / `"disabled"` / `"expired"`       |
| 返回 | `entitlementToken`         | string | **仅 `active`** 时返回的重签实体令牌(甲案,§6) |
| 返回 | `heartbeatIntervalSeconds` | number | 下次心跳间隔(默认 `3600`)                     |
| 返回 | `termEnd`                  | number | 期限结束(UTC Unix 秒)                         |

按 `aliveToken` 哈希定位活动绑定:命中且 `installId` 匹配、在期内 → `active`,刷新 `aliveTime` 并重签实体令牌;
令牌不匹配任何活动绑定(被改绑/轮换)或 `installId` 不符 → `disabled`,离线无法挽回(PL-R8);非 active 或期限结束 → `expired`。
三种判定都是 `200`(便于区别于网络故障,heartbeat 不返回 404)。错误:`400 invalid_request`、`500 heartbeat_failed`、`503 unavailable`。

### 10.4 续费下单(浏览器 / Vue,面向买家)

**`POST /v1/checkout`** — 创建 `pending` 续费订单(会话)。**协议在此处展示并接受**(PL-R9)。

| 方向 | 字段        | 类型   | 说明                                                                                                     |
| ---- | ----------- | ------ | -------------------------------------------------------------------------------------------------------- |
| 请求 | `planKey`   | string | 必填;套餐键(原 `plan` 改名)                                                                              |
| 请求 | `licenseId` | number | 必填;续期目标 license id(须属本人)                                                                       |
| 请求 | `accept`    | bool   | 必填;接受服务协议(否则 `400`)                                                                            |
| 返回 | `orderId`   | number | 新建订单自增主键                                                                                         |
| 返回 | `orderNo`   | string | 业务订单号(`C3+YYYYMMDDHHmmssSSS+random(4)`,支付关联编号)                                                |
| 返回 | `status`    | string | `"pending"`                                                                                              |
| 返回 | `codeUrl`   | string | 配了微信支付时返回;Native 扫码支付 `weixin://` 链接                                                      |
| 返回 | `qrDataUri` | string | 配了微信支付时返回;服务端把 `codeUrl` 渲染成的 PNG 二维码 data URI(SPA 直接 `<img>` 展示,前端无需 QR 库) |

金额由服务端按 `planKey` 推导,**客户端金额一律忽略**(PL-R9)。订单生成唯一 `order_no` 并下 Native 统一下单(`time_expire`=创建+15min,见 §11)。
未登录 → `401`;未勾选/缺套餐/非本人 license → `400`;**目标 license 的 `term_end` 已超过当前 +1 年** → `400`(续期上限,见 §11);下单网关失败 → `502`;未就绪 → `503`。

**`GET /v1/orders`** — 当前用户的**已支付**订单列表(会话)。返回 `200` JSON `{ "orders": Order[] }`,每个 `Order`:
`orderId`、`orderNo`、`planKey`、`amountCents`、`currency`、`status`(恒 `paid`)、`paymentRef`、`createdAt`。仅含 `paid` 订单(pending/failed 不列)。未登录 → `401`。

### 10.5 支付(微信支付 Native)

**`POST /v1/payment/wechat/notify`** — 微信支付异步结果回调。请求:微信 POST 签名信封,body 为 APIv3 加密 resource,
验签材料在 `Wechatpay-*` 头中(body 上限 1 MiB)。LS 用平台证书验签 + APIv3 key 解密,伪造/篡改回调被拒、不推进订单、超窗拒重放(PL-R12)。
回调按解密出的 `out_trade_no`(= 订单的 `order_no`)定位订单。验签通过的成功 → **在单个数据库事务内**把订单 `pending→paid`(记 `transaction_id` 为 `payment_ref`)
并延长关联 license 的 `termEnd`/状态(两表写入原子提交,见 §5);其他交易态 → `failed`;已 paid 不变(幂等)。
**已超时订单**(下单超过 15 分钟、已被置 `expired`)收到迟到的成功回调时**不再延长 license**,记录后按幂等确认(见 §11)。
应答信封 JSON `{ "code": "SUCCESS"|"FAIL", "message": "<说明>" }`:成功 `200 SUCCESS`;
验签失败 `401`、`out_trade_no` 无法识别 `400`、订单不存在 `404`、落库失败 `500`、未配置 `503`、非 POST `405`(均 `FAIL`);非 200 或 FAIL 促使微信重投。

## 11. 订单状态机:支付窗口、定时对账与续期上限

订单状态机:`pending → paid`(支付成功)/ `failed`(其他交易态)/ `expired`(超时未付)。三条收敛路径互补:

**(a) 15 分钟支付窗口** — `POST /v1/checkout` 下 Native 统一下单时设 `time_expire = 创建时间 + 15min`,扫码二维码到点由微信自动关单,逾期不能再付。

**(b) 异步回调(主路径)** — 见 §10.5:微信验签成功回调把订单 `pending→paid`、记 `payment_ref`、延长 license,幂等。

**(c) 20 分钟定时对账(安全网)** — LS 进程内每 **20 分钟**跑一次对账任务(`time.Ticker`,仅库 + 微信支付都配置时启用),
弥补漏收/失败的回调,使订单最终一致:

- 取所有 `pending` 订单,逐个用 `order_no` 调微信支付**订单查询**(query order)核对真实交易态;
- **SUCCESS** → 调与回调**同一条事务化履约函数**:在单事务内 `pending→paid`、记 `payment_ref`、延长 license(幂等,见 §5);
- **CLOSED / 已关闭**(含逾 15 分钟被微信自动关单)→ 置 `expired`;
- **NOTPAY 且未超窗** → 保持 `pending`,下轮再查;
- 其他异常态 → 置 `failed`。

20min > 15min 窗口,确保跑批时支付窗口已闭合、未付订单在微信侧已关单,状态可被终结地推进。

**惰性兜底**:checkout 列表/回调读取时,对 `created_at` 超 15 分钟仍 `pending` 的订单按 `expired` 呈现(即便对账尚未跑到),
不据它延长 license;迟到的成功回调对已 `expired`/已 `paid` 订单一律幂等、不重复延长(§10.5)。

**续期上限(1 年)**:若目标 license 的 `term_end` 已在 **当前时间 + 1 年** 之后,`POST /v1/checkout` **拒绝创建订单**(`400`),
防止把有效期无限往前堆叠。上限为常量 `MaxLicenseTermAheadMonths = 12`。

> 注:此处的 20 分钟 `time.Ticker` 是 **LS 进程内**调度,属 LS 产品自身(ADR-0026 允许 LS 具备 c3 内被禁的能力),与 c3 的"无持久后台调度"无关。
> 窗口/对账周期为固定常量(`DefaultOrderPaymentWindowMinutes = 15`、`OrderReconcileIntervalMinutes = 20`);如需可调,后续再提升为 `C3_LS_*` 环境变量。

## 引用

- [ADR-0026](adr/0026-product-licensing-separate-license-server.md) — 独立 LS 的决策、宪法例外与合规条款。
- [product-license 领域规范](../domains/commerce/product-license/product-license-spec.md) — 业务行为、状态机、PL-R 规则。
- [license-server API 契约](../shared/api-conventions/license-server-api.md) — c3 ↔ LS 的线缆边界。
- [ADR-0010](adr/0010-release-and-distribution-trust.md) — 此处复用的 Ed25519 release 签名纪律。
- [ADR-0006](adr/0006-decouple-runs-from-connections.md) — "授权失效只挡新会话、保留在途 run" 的依据。
- [ADR-0023](adr/0023-auth-abstraction-network-exposure.md) — 刻意与 license 分离的 auth 边界。
- [license-server/README.md](../../license-server/README.md) — 代码级实现与端点索引。
