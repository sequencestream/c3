# 非功能需求 — 安全

安全是 c3 的核心价值（[constitution](../constitution.md) 使命与价值观）。本节把 `C-SEC-*` 细化为可核查的期望；MCP、认证、文件与密钥的不变量由各域规格拥有，此处只引用。

## 威胁模型

- **可信:** 运行 c3 的操作系统用户，以及其授权的浏览器会话（启用认证后即通过认证的会话）。
- **不可信:** 未经授权的连接与输入。是否把 c3 暴露到网络由使用者决定；暴露到非回环地址时应启用认证。
- **不在范围内:** 防范恶意的本地用户；对厂商进程做沙箱隔离；保护项目目录的内容。

## 需求

- **SEC-1**: 绑定地址由使用者显式决定，缺省回环；放开非回环时应启用认证（[AUTH-R6](../domains/core/auth/auth-spec.md)）。监听缺省见 [system-setting](../domains/settings/system-setting/system-setting-spec.md)「监听与续跑」；外部入口另有自己的凭据（SEC-14）。
- **SEC-2**: 只持久化被显式选择的结构化运行数据，落在本机实例库（[persistence](../shared/data-conventions/persistence.md)）；原始 prompt 与对话转录默认不落盘，工作区记忆见 [memory](../domains/core/memory/memory-overview.md)（[ADR-0045](../architecture/adr/0045-workspace-memory-as-allowed-local-persistence.md)），唯一转录例外是有界机器人 IM 上下文（[im-robot](../domains/core/im-robot/im-robot-overview.md)、[ADR-0048](../architecture/adr/0048-robot-im-context-as-bounded-local-persistence.md)）。
- **SEC-3**: 会话继承宿主与项目的 hook 与允许/拒绝规则；未被它们预先决定的敏感工具流经权限网关（[C-SEC-1](../constitution.md)、[ADR-0005](../architecture/adr/0005-inherit-user-project-settings.md)、[permission-gateway](../domains/core/permission-gateway/permission-gateway-spec.md)）。
- **SEC-4**: 敏感工具须有明确允许，或处于用户选择的、授权自动执行的权限模式（[C-SEC-2](../constitution.md)）；模式目录由 [agent-session](../domains/core/agent-session/agent-session-spec.md) 拥有。
- **SEC-5**: 无决策则拒绝；无法识别的消息与被中止的运行都不得当作允许（[C-SEC-3](../constitution.md)、[permission-gateway](../domains/core/permission-gateway/permission-gateway-spec.md)）。
- **SEC-6**: 不读取、存储或传输厂商 CLI 凭据；认证权归各 vendor CLI（[C-SEC-4](../constitution.md)）。
- **SEC-7**: 升级到更宽松的权限模式只能通过一次明确、可观察的 UI 操作，不得静默放宽。
- **SEC-8**: 分发信任见下文 DIST-1；渠道与升级见 [release.md](release.md)、[ADR-0010](../architecture/adr/0010-release-and-distribution-trust.md)。
- **SEC-9**: 工作区身份是服务端分配的不透明名称，磁盘路径只表示位置（[session-registry](../domains/core/session-registry/session-registry-spec.md)）；伪造或未登记的身份不得解析为文件系统根。
- **SEC-10**: 登记或拆除工作区是建立或撤销信任根，须过身份与管理员门（[auth](../domains/core/auth/auth-spec.md)、[session-registry](../domains/core/session-registry/session-registry-spec.md)）。
- **SEC-11**: 只读浏览限定在已登记根内，不把客户端路径当作信任根（[files](../domains/core/files/files-spec.md)）。
- **SEC-13**: 智能体 `apiKey` 在存储边界加密落库，仅达混淆级；见下文。与 SEC-6 的边界：SEC-6 管厂商 CLI 凭据，SEC-13 管配置里的上游密钥。
- **SEC-14**: 对未拉起 agent 的公开入口以长期钥匙为凭据，每次调用重新授权，写调用可归因审计；卡口与并列内部面见 [external-mcp](../domains/core/external-mcp/external-mcp-overview.md) [请求与授权链](../domains/core/external-mcp/external-mcp-spec.md#请求与授权链)。
- **SEC-15**: 模型提供方连通性探测是服务端出网面：已存钥只配已存地址，草稿钥只配草稿地址（[AC-R31](../domains/settings/agent-config/agent-config-spec.md)）；出网路由见 [system-setting](../domains/settings/system-setting/system-setting-spec.md#服务端自身出网)。

## 分发信任

凭据不在二进制内（SEC-6），分发威胁是工件冒充与供应链篡改。信任由公开 GitHub Release（HTTPS）与逐工件 sha256 校验和提供（DIST-1 / SEC-8；[ADR-0010](../architecture/adr/0010-release-and-distribution-trust.md)）。渠道、自更新与签名见 [release.md](release.md)。开源，不把混淆当作信任控制。

## Agent apiKey 静态加密

智能体配置中的 `apiKey` 在存储边界加密：内存明文、磁盘密文（[persistence](../shared/data-conventions/persistence.md)）。密钥内嵌于二进制，只防配置文件意外泄露，不防持有该二进制的本机用户——与下文非目标一致。线路仍明文携带；传输层安全不在此范围。

## 非目标:反反编译/混淆

抵抗反编译或逆向工程不是安全目标。发布构建去掉 sourcemap 只提高随意复制门槛，不是机密性或完整性控制。分发信任只来自 DIST-1。c3 开源，不做混淆，也不把许可校验或完整性自检当作信任手段。

## 反场景

- 无法识别的决策被当成允许（SEC-5）。
- 密钥出现在日志或错误信息中（SEC-6、SEC-13、SEC-14）。
- 被篡改的二进制通过校验和，或混淆被当作信任控制（SEC-8）。
- 伪造或未登记的工作区身份被解析为文件系统根（SEC-9、SEC-11）。
- 未过身份门的连接登记或拆除了工作区信任根（SEC-10）。
- 浏览请求把客户端路径当作信任根（SEC-11）。
- 违反 [请求与授权链](../domains/core/external-mcp/external-mcp-spec.md#请求与授权链)（SEC-14）。
- 连通性探测把已存钥随草稿地址发往操作者指定的主机（SEC-15）。
