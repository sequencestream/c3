# Domain: product-license

| Field          | Value                                                                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responsibility | 管理一个 c3 安装是否**具备商用授权**来创建新工作,并向用户呈现该状态。在 c3 内强制执行;权威记录存放在独立的 **license-server(LS)** 中。                                                                                                         |
| API            | 通过 [license-server API 契约](../../../shared/api-conventions/license-server-api.md) 出站至 LS;经由 c3 WebSocket 入站呈现(见 [shared protocol](../../../shared/api-conventions/websocket-protocol.md))                                        |
| Status         | 进行中 —— LS 基础设施已建成(配置、缓存、PostgreSQL schema、健康检查、公开套餐目录、内嵌 web、单二进制);浏览器中转的 GitHub 登录 + 默认许可发放 + activate/bind/checkbind + 心跳已上线;续费支付(微信支付 Native)+ 订单对账已上线;后台管理待完成 |

product-license 域权威地回答一个问题:**该安装是否已付费?**
绑定是**浏览器中转**的:c3 生成一个 `installId` + `requestId`,打开浏览器跳转至
license-server,用户在此登录并**选择要绑定的许可**,随后 c3 server 通过 **checkbind**
收集绑定结果,并周期性地**心跳**(携带 `installId` + alive token)以确认授权仍然
有效、未过期或未被顶替。在心跳之间——以及经历短暂的网络或 LS 故障期间——c3 信任一个
**LS 签名的授权令牌**,该令牌会被**离线**验证(Ed25519),在距最近一次成功心跳的
**30 分钟离线宽限期**内有效。当授权状态不为 `active` 时,c3 会**阻止创建新会话**,
但不影响已有会话及正在进行的运行。

这**不是**身份认证。[auth 域](../../core/auth/auth-overview.md) 控制*谁*
可以在 c3 实例上驱动智能体(本地访问控制,即便在免费/未授权安装下也存在);
product-license 控制*产品是否已付费*(服务端权威的授权状态,与当前生效的
认证提供方无关)。二者被刻意设计为独立的限界上下文(ADR-0026)。

**范围:** 账户登录 + 默认免费许可发放(LS 侧)、许可密钥绑定、心跳 +
离线宽限期生命周期、授权令牌的离线签名验证、新会话阻断、许可徽标/菜单呈现、
续费支付 + 无退款协议流程(LS 侧),以及管理员许可操作(LS 侧)。

**边界 —— 该域不是什么:**

- **不是身份认证**([auth](../../core/auth/auth-overview.md)) —— 它从不决定谁
  可以连接或登录。
- **不是权限网关**([permission-gateway](../../core/permission-gateway/permission-gateway-spec.md)) ——
  它从不决定单次工具调用;只阻断是否可以创建**新**会话。
- **不是运行控制器** —— 它从不打断进行中的运行或已有会话
  (ADR-0006:运行会存续;授权失效只停止*新*工作,而非*当前*工作)。

## Index

- [product-license-spec.md](product-license-spec.md) —— 实体、授权状态机、业务规则 `PL-R*`、
  无退款政策、管理员操作、安全不变式、用户场景与非目标。
- [product-license-design.md](product-license-design.md) —— c3 侧的阻断机制、磁盘上的授权缓存、心跳调度器
  与宽限期计时器、离线 Ed25519 验证,以及 license-server 的技术形态。
- [license-server API 契约](../../../shared/api-conventions/license-server-api.md) —— c3 ↔ LS 的公开边界(许可密钥绑定、心跳、错误语义)。

## Roadmap (rollout milestones)

1. **本次交付 —— 架构/规格基础。** ADR-0026 记录了为何需要 LS 及所采用的技术;
   该域 + LS API 契约定义了行为与边界。尚无运行时。
2. **LS MVP(权威核心)。** _已上线_ —— 独立的 Go 服务从环境配置启动,应用幂等的
   PostgreSQL schema,提供脱敏的健康信号与公开的套餐目录(`1m`/`6m`/`1y`),
   将其 web 作为单二进制内嵌;**GitHub 登录/注册**与**免费许可发放**
   (向用户展示随机许可密钥);**许可密钥绑定**
   (Ed25519 签名的授权令牌 + alive token,每个安装独占);以及**心跳**
   (active / disabled / expired)。_待完成_ —— 通过 GitHub OAuth 后台进行
   管理员发放/强制到期/查看。
3. **续费支付流程(LS web)。** 基于 GitHub 账户结账;微信支付;支付前必须在订单上
   接受**无退款服务协议**;支付成功的订单 → 延长关联许可的期限与状态。
4. **c3 侧强制执行。** 许可密钥绑定、心跳调度器、磁盘上的授权缓存、
   30 分钟离线宽限期、离线 Ed25519 验证、新会话阻断,以及控制台中的许可徽标/菜单。
5. **加固。** 授权缓存文件权限 + 日志脱敏;绑定/心跳限流;
   顶替/吊销传播延迟目标。

每个里程碑的验收标准均可追溯至 [product-license-spec.md](product-license-spec.md)
中的规则与不变式,以及 [ADR-0026](../../../architecture/adr/0026-product-licensing-separate-license-server.md) 中的决策。
