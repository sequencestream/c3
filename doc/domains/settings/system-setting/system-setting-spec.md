# system-setting 系统设置

`system-setting` 域承载 `SystemSettings`(见 [`shared/src/protocol/settings.ts`](../../../../shared/src/protocol/settings.ts))中管理员级的**全局**配置——既非按会话、按工作区,也非按人。所有改动过管理员门(见 [auth](../../core/auth/auth-overview.md))。系统设置面板分 agent / runtime / security / general 四页;其中 agent 页属 [agent-config](../agent-config/agent-config-overview.md) 域,不在本域范围。因人而异的偏好(如界面语言)属 [personalized-setting](../personalized-setting/personalized-setting-spec.md) 域,不在本域,也不过管理员门。

配置持久化路径、单一写入路径、`projectConfigs` 分层等**组级共享上下文**见 [settings 组概览](../settings-overview.md)。

## 显示与本地化

- **`voiceLang`** — 浏览器语音输入的 BCP-47 语言标签(如 `zh-CN`),缺省 `zh-CN`。与界面语言解耦(后者是个人化偏好)。
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

## 外部 MCP API Key 存储 `mcpApiKeys`

长期 API key 是 [外部 MCP 路由 `/mcp/<api-key>`](../../core/external-mcp/external-mcp-spec.md) 的**唯一凭据**:c3 没有拉起的 agent(独立 Claude Code / Codex 会话、CI 任务、监控脚本)凭它访问本部署。**生命周期(生成/列示/改工具范围/吊销)在工作区设置「外部 MCP 接入」页**,不在系统设置——每把 key 绑定单一工作区,按工作区管理;只有存储与哈希仍属本域。

**存储位置是安全边界。** key 记录存于 `~/.c3/settings.json` 的顶层键 `mcpApiKeys`,是 `SystemSettings` 的**兄弟键而非字段**(与 `personalizedSettings` 同一所有权切分)。因此整对象 `save_settings` 既不携带它、也无法注入/覆盖/读出哈希——进出只有下述专用操作。

每条记录含:不可变 id、显示名称、创建时间、最后使用时间(可空)、**唯一绑定的规范化 workspace 路径**、工具范围、每 key 独立随机盐、`scrypt` 哈希及其参数与版本。**磁盘上没有明文。**

- **明文格式** `c3k_<id>_<secret>`。id 一半刻意**非秘密**:校验时据它直接定位唯一候选记录,只付一次派生开销,而不是拿每条记录都算一遍哈希。secret 一半是 256 bit CSPRNG 熵,恒定时间比较。
- **生成**:响应是唯一出现明文的地方,只此一次。列表与后续任何快照只回 id、名称、时间、绑定 workspace、工具范围与非秘密短前缀 `c3k_<id>`。前端把它保存在页面内存里供复制,刷新/关闭即不可恢复。
- **校验**:每次请求重读当前记录,进程**不缓存「此 key 有效」的结论**,故吊销下一次请求即生效。key 格式错、id 未知、哈希版本不支持、哈希不匹配一律以同一个 401 拒绝——调用方无法据此探测某个 id 是否存在。哈希版本不受支持时按无效拒绝并记录不含秘密的诊断,绝不 fail-open。
- **单工作区约束**:创建只绑定调用方指定的一个**已注册** workspace,不提供跨工作区集合或通配;工具范围创建时由服务端强制为全部只读工具,写工具须在创建后由管理员显式勾选。**空工具范围表示该 key 什么也调不到,绝不是通配。**
- **吊销**:删除记录即吊销,不提供恢复、查看明文或原地轮换。轮换 = 新建 key → 更新接入方 → 删除旧 key。吊销或改范围同时关闭该 key 已建立的活动 transport,故两个方向都立即生效。
- **最后使用时间**是展示字段,按分钟粒度粗略落盘:每个请求都去抢跨进程写锁重写时间戳不值当。
- **遗留迁移**:升级前已授权**恰好一个** workspace 的 key 原样迁移并沿用明文;授权多个或无可解析 workspace 的遗留 key 无法无歧义映射到单一 `/mcp/<api-key>`,加载时**一律吊销**并提示管理员逐工作区重建。

`--host` 决定这些 key 能从哪里被用到:默认回环,只有显式放开监听后外部主机才可达。见下节。

## 监听地址 `--host`

`c3 start` / `c3 install` 接受 `--host <address>`,贯穿 CLI、daemon 侧车快照与 OS service 单元,最终落到 `serve({ hostname })`。

- **缺省 `127.0.0.1`**,即只有本机可达。这是对旧行为的**收紧**:此前不传 hostname 等于隐式监听全部网卡,局域网上的机器无需任何人做出选择就能访问 c3。
- 需要局域网/远程访问时显式 `--host 0.0.0.0`、`::` 或某个具体接口地址。
- 启动日志打印**实际**监听地址与端口,便于回答「另一台机器为什么连不上」;日志不打印 token,也不打印任何可能带 token 的完整 MCP URL。
- 未显式配置 host 的既有后台服务在升级后会收紧为回环。需要远程访问的用户必须重新 `c3 install --host …` 或以 `c3 start --host …` 启动。

## 其他系统级开关

- **`showToolSessions`** — 工具类会话(完成判定、共识顾问)是否进侧栏会话列表,缺省 `false`(隐藏)。
- **`showSessionsPage`** — 会话聚合页是否出现在桌面顶栏与移动端底栏,缺省 `false`(隐藏)。开启后入口位于「代码」之后;关闭只影响主导航及普通启动恢复,不删除 Works 页、会话同步、角标或意图/讨论/自动化/代码等功能内的会话入口。该开关与 `showToolSessions` 独立:前者控制聚合页入口,后者控制聚合页内是否列出工具类会话。
- **`socketAutoResume`** — socket 断连后的单次自动 `resume` 开关。缺省开:普通会话遇 `socket connection was closed unexpectedly` 且工具副作用门清空时,同 `runId` 自动续跑一次。设为 false 则每次断连以 `turn_end{reason:'error'}` 收尾,由用户手动继续。
- **环境诊断** — runtime 页只读展示各 vendor 的 host CLI 探测结果(是否存在、令牌是否就绪),不落库、不可编辑。
