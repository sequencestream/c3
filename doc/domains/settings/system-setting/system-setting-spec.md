# system-setting 系统设置

`system-setting` 域承载 `SystemSettings`(见 [`shared/src/protocol.ts`](../../../../shared/src/protocol.ts))中管理员级的**全局**配置——既非按会话、也非按工作区。所有改动过管理员门(见 [auth](../../core/auth/auth-overview.md))。系统设置面板分 agent / runtime / security / general 四页;其中 agent 页属 [agent-config](../agent-config/agent-config-overview.md) 域,不在本域范围。

配置持久化路径、单一写入路径、`projectConfigs` 分层等**组级共享上下文**见 [settings 组概览](../settings-overview.md)。

## 显示与本地化

- **`uiLang`** — Web 控制台界面语言,缺省 `en`。与 `voiceLang` 解耦。
- **`voiceLang`** — 浏览器语音输入的 BCP-47 语言标签(如 `zh-CN`),缺省 `zh-CN`。
- **`timezone`** — 系统级 IANA 时区(如 `Asia/Shanghai`),用于解释**每个自动化 cron 字段**并计算 `next_run_at`(DST 感知)。缺省/非法回退服务端本地时区。修改会平移既有自动化的实际触发时刻。

## 公开访问地址 `baseUrl`

`baseUrl` 是此 c3 部署的对外基地址,用于拼接可分享的链接(如分享按钮生成的 URL)。典型值如 `http://192.168.10.10:9000`。

- **可选字段**:空值或缺失均视为「未配置」,消费者回退默认行为。
- **规范化**:保存时 trim 首尾空白并去除尾部斜杠(`http://host:3000///` → `http://host:3000`)。纯空白视为空值,不落库。
- **存储**:明文存于 `~/.c3/settings.json` 顶层(非敏感,不走 `c3secretv1:` 加密路径)。
- **作用域**:系统级,不与 `WorkspaceSetting` / `projectConfigs` 交互。
- **不做格式校验**:不解析 URL、不校验协议/主机、不探测可达性。

## vendor CLI 生效版本 `vendorCliVersions`

`vendorCliVersions.claude` / `vendorCliVersions.codex` 选择运行时**生效**的受管版本——不是下载锚点。空/缺失表示自动取最新兼容版:同步流始终把最新兼容 npm 版落到 `~/.c3/vendor/<vendor>/<version>/bin/<binary>`,与本字段无关,因此历史版可被选为生效而不冻结升级。非空值必须指向服务端上报的已安装版;未安装/不兼容值降级为最新兼容受管版,记录可见 `lastError`,不静默清空。面板把已安装版列表渲染为单选。显式 env override 仍最高优先;host PATH 仅在受管解析或同步失败后作降级回退。

## 系统沙箱定义 `sandboxes`

系统级沙箱定义(镜像/挂载模板),供各工作区按 name 引用(工作区侧引用见 [workspace-setting](../workspace-setting/workspace-setting-spec.md))。仅管理员经系统设置面板 CRUD;缺省/空 ⇒ 无沙箱定义,工作区配置面板隐藏其沙箱区。沙箱运行语义见 [sandbox](../../core/sandbox/sandbox-design.md)。

## 子进程代理 `proxy`

`proxy` 块控制新会话子进程是否注入 `HTTP_PROXY`/`http_proxy`/`HTTPS_PROXY`/`https_proxy` 环境变量:

- **`proxy.enabled`** — 总开关(严格布尔,仅 `true` 启用)。关闭时无论 URL 为何都不注入。
- **`proxy.httpProxy`** — HTTP 代理 URL(如 `http://proxy.local:3128`)。启用且非空时注入 `HTTP_PROXY` 与 `http_proxy`。
- **`proxy.httpsProxy`** — HTTPS 代理 URL。启用且非空时注入 `HTTPS_PROXY` 与 `https_proxy`。

要点:

- 仅支持上述四个变量——无 `NO_PROXY`/`ALL_PROXY`/SOCKS/PAC。
- 仅影响**新启动**的 `claude`/`codex` 子进程;运行中的会话不追溯更新。服务端自身出网不受影响。
- 关闭 `enabled` 时保留 URL 值,便于快速开关而不必重填。
- 代理认证可内嵌于 URL(`http://user:pass@host:port`),无专门表单;明文存储(不走 `c3secretv1:`,有意取舍)。
- 注入发生在 `launchForAgent()` 的 `envOverrides`,覆盖所有入口(主运行、工具会话、意图沟通、规格撰写、讨论、自动化执行、顾问会话)。`buildChildEnv` 合并序(keepalive < process.env < envOverrides)不变:代理变量落在 `envOverrides`,优先于用户 shell,但仍可被 shell 中显式 `HTTP_PROXY`/`HTTPS_PROXY` 覆盖。

## 鉴权 `auth`

`auth` 承载鉴权配置:`basic` 多账号 + 唯一管理员、会话 token 策略(TTL、签名钥引用)、bind 地址暴露意图。缺省/`enabled:false` ⇒ 无鉴权(localhost-only 默认)。账号凭据仅由专用鉴权消息变更,不经通用 `save_settings`。提供者中立抽象与运行语义见 [auth](../../core/auth/auth-overview.md)。

## 其他系统级开关

- **`showToolSessions`** — 工具类会话(完成判定、共识顾问)是否进侧栏会话列表,缺省 `false`(隐藏)。
- **`showSessionsPage`** — 会话聚合页是否出现在桌面顶栏与移动端底栏,缺省 `false`(隐藏)。开启后入口位于「代码」之后;关闭只影响主导航及普通启动恢复,不删除 Works 页、会话同步、角标或意图/讨论/自动化/代码等功能内的会话入口。该开关与 `showToolSessions` 独立:前者控制聚合页入口,后者控制聚合页内是否列出工具类会话。
- **`socketAutoResume`** — socket 断连后的单次自动 `resume` 开关。缺省开:普通会话遇 `socket connection was closed unexpectedly` 且工具副作用门清空时,同 `runId` 自动续跑一次。设为 false 则每次断连以 `turn_end{reason:'error'}` 收尾,由用户手动继续。
- **环境诊断** — runtime 页只读展示各 vendor 的 host CLI 探测结果(是否存在、令牌是否就绪),不落库、不可编辑。
