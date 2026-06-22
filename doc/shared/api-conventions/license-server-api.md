# License-Server API 契约

c3 ↔ license-server(LS)对外边界的**唯一真相源**。它定义 c3 调用的端点、面向买家的 LS Web 表面、
凭证/令牌生命周期与错误语义。业务行为与依据见
[product-license 领域规范](../../domains/commerce/product-license/product-license-spec.md)与
[ADR-0026](../../architecture/adr/0026-product-licensing-separate-license-server.md);服务自身架构与**逐接口字段明细**见
[license-server 架构规范 §10](../../architecture/license-server-architecture.md)。本文是**契约**——按引用,不在他处复述线缆形状。

这是一份**外部 HTTP 契约**(独立产品,ADR-0026),不是 c3 的 WebSocket 协议。下文字段/端点名是外部契约词汇(C-DOC-1)。

## 传输与约定

- **传输:** 仅 HTTPS。c3 绝不在明文 HTTP 上发送凭证或密钥。
- **路径:** 所有功能 API 以 `/v1` 前缀(`/healthz` 运维存活、`/` Vue SPA 为例外)。
- **编码:** JSON 请求/响应体;字段一律 **camelCase**;时间为 UTC Unix 秒;金额 `*Cents` 为币种最小单位。
- **错误信封:** `{"error":{"type":"<错误码>","message":"<说明>"}}`,以字符串 `type` 区分结果。
- **会话:** 浏览器/Vue 调用的端点需登录会话 cookie(签名、HMAC keyed on 签名种子,无服务端会话表);未登录 → `401`。
- **S2S:** `checkbind`/`heartbeat` 由 c3 server 直连调用,不需会话。
- **信任:** `checkbind`/`heartbeat` 返回的**实体令牌**由 LS 用 Ed25519 **签名**,c3 用内嵌公钥**离线验签**。HTTP 通道只是传输,签名(而非通道)才是信任根(PL-R5)。

## 绑定模型:浏览器中介的设备式流程

c3 是**浏览器外**的本地进程。绑定经浏览器中介完成:

1. c3 server 生成 `installId`(安装级稳定,唯一、≤128 字符)与本轮 `requestId`(32 字符唯一)。
2. c3 server 拉起系统浏览器打开 LS 的 Vue SPA(`/`,带 `installId`/`requestId`)。
3. 用户在浏览器内用 GitHub 登录(仅账号登录,**不展示协议**),浏览器调用 `GET /v1/license/activate` 拿到本人 license 列表,选定一条后 `POST /v1/license/bind` 完成绑定。**自动绑定:** 当账户**只有一条** license 且其剩余有效期**超过 1 个月**(`termEnd > now + 1 月`、状态 `active`)时,`activate` 直接在服务端完成绑定并把密钥暂存进待绑映射(等价于一次 `bind`),响应带 `autoBound:true` 与 `termEnd`;SPA 据此直接进成功态、**不再调用 `bind`**(再次绑定会轮换 alive token、使刚激活的 c3 心跳失效)。默认一个月试用 license(剩余期恰在阈值上)不触发自动绑定。
4. c3 server 带同一对 `(installId, requestId)` 轮询 `GET /v1/license/checkbind`,绑定完成后**经 S2S 通道**取回 `aliveToken` 与签名实体令牌(**绝不经浏览器**,PL-R2)。
5. c3 server 周期 `POST /v1/license/heartbeat` 确认绑定并刷新实体令牌。

## 凭证与令牌

| 凭证 / 令牌           | 由谁/何时签发                        | 生命周期         | 用途                                                                                      |
| --------------------- | ------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------- |
| **installId**         | c3,安装级稳定                        | 稳定             | 标识哪个安装。一个安装独占绑定一条 license。请求体/查询参数中携带,≤128 字符。             |
| **requestId**         | c3,每轮绑定生成                      | 一轮绑定(带 TTL) | 32 字符唯一 id;配对 `installId` 在 `bind`/`checkbind` 间关联同一轮绑定。                  |
| **license key**       | LS,创建/签发 license 时              | 随 license       | 可分享的稳定句柄,标识一条 license;用户在浏览器内选定后由 `bind` 引用。非心跳凭证(PL-R2)。 |
| **alive token**       | LS,`bind` 时生成、轮换               | 每次绑定,可吊销  | 每次心跳鉴权该绑定。明文经 **`checkbind` S2S** 返回一次;库内只存 sha256 哈希。            |
| **entitlement token** | LS,签名,`checkbind`/`heartbeat` 返回 | 有限有效期窗口   | c3 缓存、离线 Ed25519 验签以推导 `active`(PL-R5)。                                        |

**硬规则(PL-R2):** alive token 绝不经浏览器返回;它由 `bind` 生成、暂存进程内 `(installId, requestId)` 映射,仅由 c3 server 的 `checkbind` 取回一次。

## c3 → LS 端点(S2S)

### Checkbind

`GET /v1/license/checkbind?installId&requestId` — c3 server 轮询本轮绑定是否完成。

- **查询参数:** `installId`、`requestId`(须与 `bind` 一致)。
- **返回 `200`:** 未完成 `{status:"pending"}`;完成 `{status:"active", licenseKey, aliveToken, entitlementToken, termEnd}`(`licenseKey` 供 c3 落盘以驱动徽标与心跳)。命中即**消费**该映射(重复取回得 `pending`)。
- **错误:** `400 invalid_request`、`503 unavailable`。

### Heartbeat

`POST /v1/license/heartbeat` — c3 server 周期确认活动绑定并刷新实体令牌。

- **请求体:** `installId`、`aliveToken`(**不含 license key**)。
- **返回 `200`(以 `status` 区分,非 active 也是 200,便于区别于网络故障):**
  - `active` — alive token 命中活动绑定、`installId` 匹配、在期内:刷新最后成功时间,返回刷新的 `entitlementToken`、`termEnd`、下次 `heartbeatIntervalSeconds`。
  - `disabled` — token 不匹配任何活动绑定(被改绑/轮换)或 `installId` 不符(PL-R8):c3 门禁,**离线无法挽回**。
  - `expired` — license 非 `active`(被 admin 强制过期)或期限已结束。
- **错误:** `400 invalid_request`、`500`、`503 unavailable`。**heartbeat 不返回 404**。

## 公开端点(无需凭证)

- **`GET /v1/plans`** — 公开套餐目录。返回 `{plans: Plan[]}`,每个 `Plan` 含 `planKey`(稳定键)、`name`、`durationMonths`、`priceCents`、`currency`(ISO-4217)。MVP:`1m`/`6m`/`1y`,CNY。
- **`GET /healthz`** — 存活 + **脱敏**配置视图(机密只显示 `set`/`unset`,绝不显示值,PL-R12)。

## 登录与会话(LS Web,面向买家)

GitHub 登录**仅用于账号登录/注册**,**不再展示协议**(协议在续费时展示)。

- **`POST /v1/auth/login`** — 发起 GitHub OAuth。请求体可携带 `installId`/`requestId`(透传)。`303` 重定向到 GitHub authorize URL(state 为无状态 HMAC 签名)。
- **`GET /v1/auth/github/callback`** — OAuth 回调:校验 state → 取身份 → upsert 账户 → **确保一条默认 license(自动创建)** → 写会话 cookie → `303` 跳回 SPA(带回 `installId`/`requestId`)。
- **`GET /v1/session`** — SPA 查询登录态:`{signedIn, login}`。

浏览器内**不暴露**任何签名令牌或 bearer 凭证:只展示可分享的 license key 与绑定元数据(PL-R2)。

## LS Web(买家)表面

c3 不调用这些,记于此以保边界完整。

### license 绑定(浏览器/会话)

- **`GET /v1/license/activate?installId&requestId`** — 确保账户有默认 license、登记本轮 `(installId, requestId)` 待绑请求,返回本人 license 列表(每项 `licenseId`/`licenseKey`/`status`/`termEnd`/`aliveInstallId`/`aliveTime`;license 不含套餐字段——套餐记录在订单上)。当且仅当满足自动绑定条件(唯一 license、`active`、剩余期 > 1 月)时,额外返回 `autoBound:true` 与 `termEnd`(已在服务端完成绑定并暂存待 `checkbind` 取回)。未登录 `401`。
- **`POST /v1/license/bind`** — 请求体 `{installId, requestId, licenseKey}`(license 须属本人):独占绑定、轮换 alive token、签实体令牌,并把 `(installId, requestId) → {aliveToken, entitlementToken}` 暂存内存供 `checkbind` 取回。**响应只回 `{status:"active", termEnd}`**(不含 alive token/令牌,PL-R2)。错误:`400`、`404 invalid_key`、`410 expired`、`401`、`503`。

### 续费购买流程

用户可持**多条 license**;延长 license 的期限/状态需一笔已支付订单(PL-R9):

1. **登录**(GitHub)。checkout 端点需会话;未登录 `401`。
2. **选套餐 + 接受协议**(PL-R9):结算页提供协议正文的独立查看页；用户阅读后勾选同意。`GET /v1/plans`(可购买,排除试用)、`GET /v1/licenses`(续期目标)、`GET /v1/agreement`(协议正文)。
3. **下单** `POST /v1/checkout` — 请求体 `{planKey, licenseId, accept}`。金额由服务端按 `planKey` 推导(客户端金额一律忽略)。创建唯一 `orderNo`(`C3+YYYYMMDDHHmmssSSS+random4`,作 WeChat `out_trade_no`)的 `pending` 订单;若目标 license 的 `termEnd` 已超过当前 +1 年则拒绝(`400`,续期上限)。配了微信支付则下 Native 统一下单(`time_expire`=创建+15min)并返回 `{orderId, orderNo, status, codeUrl, qrDataUri}`(扫码二维码)。
4. **支付** WeChat Pay **Native**(扫码)。微信异步回调结算,详见下。
5. **查看** `GET /v1/orders`(仅**已支付**订单)、`GET /v1/licenses`(license 与绑定状态)。

MVP **无退款端点**(PL-R10):虚拟商品,协议不支持退款。

### 支付回调

`POST /v1/payment/wechat/notify` — WeChat Pay **异步**支付结果回调。

- **请求:** 微信 POST 签名信封,body 为 APIv3 加密 resource,验签材料在 `Wechatpay-*` 头中。
- **校验(安全边界):** LS 用微信**平台证书验签**并以 **APIv3 key 解密**;验签/解密失败的伪造或篡改回调被**拒绝**,不推进任何订单(PL-R12)。回调按解密出的 `out_trade_no`(= 订单 `orderNo`)定位订单。
- **效果:** 验签通过的成功 → **单事务内**订单 `pending→paid`(记 `transaction_id` 为 `paymentRef`)并延长关联 license 的 `termEnd`/状态;其他交易态 → `failed`;已 `paid`/`expired` 幂等不变,迟到成功不重复延长。
- **应答:** WeChat 的 `SUCCESS`/`FAIL` 信封;非 2xx 或 FAIL 促使微信重投。

### 订单超时与对账

- **15 分钟支付窗口:** Native 统一下单设 `time_expire`=创建+15min,逾期微信自动关单。
- **15 秒定时对账:** LS 进程内每 15 秒用 `orderNo` 调微信订单查询核对 `pending` 订单:SUCCESS→paid(延长 license)、CLOSED→`expired`、NOTPAY 未超窗→保持、其他→`failed`。是异步回调的安全网,高频以便回调缺失时仍能数秒内确认支付;是否过期按每单 `created_at` 与 15min 窗口逐单判定,与对账周期解耦。
- **`GET /v1/checkout/status?orderNo`:** 已登录买家轮询本人某订单当前状态(`pending`/`paid`/`expired`/`failed`),供续费页扫码后自动收尾(支付成功即跳账户页,无需手动刷新)。仅可查本人订单,他人订单返回 `404`。
- **续期上限:** 目标 license 的 `termEnd` 在当前 +1 年之后则拒绝下单。

### admin 后台

经 GitHub OAuth + allowlist 鉴权的 admin(PL-R11)可签发、强制过期(置 `expired`)、审查 license/绑定/订单。Admin 改动改写权威记录,只在 c3 下次心跳到达(PL-R8)。

## 错误语义

c3 对 LS 响应**fail-soft**——错误绝不崩溃 c3 或打断运行中的会话;只影响 grace 窗口耗尽后**新**会话能否创建(PL-R6/PL-R13)。

| 条件                          | 对 c3 的含义                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| **checkbind `pending`**       | 本轮绑定尚未完成,继续轮询。                                                                          |
| **heartbeat `disabled`(200)** | install/alive token 不再匹配活动绑定——被改绑他处(PL-R8)。门禁,离线无法挽回。                         |
| **heartbeat `expired`(200)**  | license 非 active(admin 强制过期)或期限已结束。门禁。                                                |
| **unavailable(503)**          | bind/checkbind/heartbeat 暂时禁用(LS 未完全配置或维护)。c3 提示重试并回退到 30 分钟离线 grace。      |
| **network / unreachable**     | 非 LS 裁决;按一次失败心跳处理,依赖 30 分钟离线 grace(PL-R4)。与 `disabled`/`expired`(HTTP 200)区分。 |
| **签名验签失败**              | c3 端,非 HTTP 状态:实体令牌 Ed25519 验签不过即按**不授权**处理(deny-by-default,PL-R5)。              |

## 不变量(交叉引用)

- alive token 与实体令牌**只走 S2S(checkbind/heartbeat),绝不经浏览器**(PL-R2)。
- 绑定**独占**:一条 license 同时只绑一个安装;一个安装也只绑一条 license(改绑displaces 旧绑定,旧安装下次心跳得 `disabled`,无法 out-wait grace,PL-R8)。
- 信任是 **Ed25519 签名**、**离线**验签;HTTP 通道绝非信任根(PL-R5)。
- 错误对当前工作 **fail-soft**:只门禁**新**会话,绝不打断运行中的(PL-R6/PL-R13)。
- 只有**公钥**活在 c3;签名私钥、OAuth secret、支付凭证只活在 LS(PL-R12)。

## 引用

- [product-license 领域规范](../../domains/commerce/product-license/product-license-spec.md) — `PL-R*` 规则与授权状态机。
- [product-license 设计](../../domains/commerce/product-license/product-license-design.md) — c3 侧机制与 LS 技术形态。
- [license-server 架构规范 §10](../../architecture/license-server-architecture.md) — 逐接口字段明细。
- [ADR-0026](../../architecture/adr/0026-product-licensing-separate-license-server.md) — 为何存在 LS 与所采技术。
