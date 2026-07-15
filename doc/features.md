# c3 特性清单

c3(code creative center)全部特性功能的树状索引,每行一句话说明。按业务组/能力域组织,与 [`doc/domains/`](domains/) 一一对应。特性变更时同步本文件。

- 详细行为见各域 `<domain>-spec.md`;前端页面组件见 [`web/PAGES.md`](../web/PAGES.md);wire 协议见 [`shared/src/protocol.ts`](../shared/src/protocol.ts)。

```
c3
│
├── core — 智能体循环:用户说 → 智能体做 → 用户看并操控
│   │
│   ├── agent-session 智能体会话                  # 驱动厂商 SDK 的 query() 循环,单次 run 的引擎室
│   │   ├── 运行生命周期                          # 接收 prompt → 流式输出 → 收敛(done/error/aborted)
│   │   ├── SDK↔协议翻译                          # 把 SDK 消息映射为 wire 层 ServerToClient 事件
│   │   ├── 权限模式                              # default / plan / acceptEdits / bypassPermissions 四态切换
│   │   ├── 运行态机                              # idle / running / awaiting-permission,每会话单飞(single-flight)
│   │   ├── 取消中止                              # 用户命令或断连时干净中止在途 run
│   │   ├── 历史续传                              # 每轮持久化,浏览器刷新可完整回放 transcript
│   │   ├── 多厂商                                # 同时支持 Claude 与 Codex 两个 vendor SDK
│   │   └── Codex GH_TOKEN 桥接                    # codex 会话启动时把宿主 gh 钥匙串令牌注入 GH_TOKEN,沙箱内 gh 可认证(已有 token 不覆盖/探测失败静默降级)
│   │
│   ├── permission-gateway 权限网关               # 智能体与人之间的控制点,有副作用的工具须过此门
│   │   ├── 权限拦截                              # 捕获每次 SDK canUseTool 回调,工具运行前暂停
│   │   ├── 人工路由                              # 转发请求到浏览器,阻塞等待 allow/deny 裁决
│   │   ├── 策略自动裁决                          # 按已存 allow-rules 与模式在询问人之前自动决定
│   │   ├── 运行中止语义                          # run 被中止时拒绝在途权限请求
│   │   └── 审计留痕                              # 记录谁在何时决定了什么,供回放与历史
│   │
│   ├── session-registry 会话与工作区目录         # 工作的档案柜与调度器
│   │   ├── 工作区注册                            # 已知工作区(绝对路径→不透明 workspaceId)、默认工作区
│   │   ├── 会话目录                              # 按 sessionKind(work/intent/spec/discussion/automation/tool)增删列
│   │   ├── 最近访问排序                          # 维护会话列表的 MRU 顺序
│   │   ├── 历史持久化                            # 每轮 transcript 持久化,重连即回放
│   │   ├── 模式记忆                              # 记住每个会话上次的权限模式
│   │   └── 游标分页                              # 会话列表按 session_kind 服务端游标分页(窗口/首页/加载更多)
│   │
│   ├── web-console Web 控制台                    # 人观察与操控智能体的浏览器窗口
│   │   ├── 活动流                                # 渲染 assistant 文本、工具调用/结果、权限提示、共识结果
│   │   ├── 提示输入                              # 提交/排队 prompt;斜杠命令补全、语音输入、图片附件(点/粘/拖+压缩)
│   │   ├── 待发队列                              # 运行中缓存待发消息,可改可删,run 结束自动 flush
│   │   ├── 权限 UI                               # allow/deny 对话框、AskUserQuestion 逐题作答、共识意见展示
│   │   ├── 控制面                                # 模式切换、agent 切换、停止、继续、刷新
│   │   ├── 会话控制                              # 会话增/删/改名/选择、工作区切换(增删受管理员门控)
│   │   ├── 双视图                                # 工作区(workspace)与工作台(workcenter)两大视图切换
│   │   ├── 移动端                                # MobileStack drill-down 栈式布局、软键盘/安全区避让
│   │   ├── 富文本渲染                            # Markdown+DOMPurify 双防线、Shiki 代码高亮、宽表横滚
│   │   ├── 分享链接                              # 标题栏「分享」按钮拼 [类型]标题+深链写剪贴板
│   │   ├── 启动进度遮罩                          # Start Work / Spec 启动的分步进度全屏遮罩
│   │   ├── 新版本提示                            # update-checker 判定有新版时顶栏蓝色胶囊外链
│   │   └── 国际化 i18n                           # en/zh/ja/ko/ru 五语 + 日期/数字/管道复数,typed t 编译期检查
│   │
│   ├── intent-management 意图管理                # 把想法变成可验证、可追踪的意图账本并驱动其生命周期
│   │   ├── 意图账本                              # 按工作区持久化意图,追踪 status/生命周期
│   │   ├── 意图精炼                              # 只读 agent 把想法拆成可验证条目
│   │   ├── 正文直接编辑                          # draft/todo 意图正文行内编辑(纯文本 markdown),服务端状态门禁+写 intent_updated 日志
│   │   ├── 规格撰写与批准                        # 开发前生成 spec 并经人批准(spec 集中存 ~/.c3/specs)
│   │   ├── 规格直接编辑                          # 未启动开发且无运行中 spec 会话时行内编辑 spec 源码,覆盖写集中 specs 文件+审批联动重置+写 spec_updated 日志
│   │   ├── 意图开发                              # 启动可配置 dev skill,追踪 branch/commit/PR
│   │   ├── 意图交付                              # 追踪交付态(分支、提交、PR 状态)
│   │   ├── PR 更新复位                           # 模型发 pr:operation update/success 时把 rejected/failed/closed 意图 prStatus 复位为 reviewing
│   │   ├── 意图依赖                              # intent_deps 依赖图(blocks/informs/soft_after),依赖门控启动
│   │   ├── 沟通会话                              # 意图右栏 intent session 多会话(新建/选择/改名/删除)
│   │   └── Git/PR 收尾                           # 手动 Start Dev 结束时经 gh 建 PR、回填 commit/PR 状态
│   │
│   ├── discussion 多智能体讨论                   # 多个 agent(与人)围绕主题圆桌讨论,可转为意图
│   │   ├── 讨论账本                              # 按工作区持久化讨论(主题+参与者)
│   │   ├── 多 agent 轮流                         # 组织者引擎编排参与 agent 的轮流发言
│   │   ├── 人类参与                              # 人可发言进入讨论、暂停/恢复
│   │   ├── 参与者定向                            # 创建时勾选参与 agent,空集回退全员,组织者恒并入
│   │   ├── 讨论转意图                            # 把讨论结论转化为意图
│   │   └── 讨论 MCP 工具                         # automation LLM 可 find/view/start/continue 讨论,含 in_progress 无存活run 的错误恢复
│   │
│   ├── automations 自动化                        # 按计划或响应事件跑智能体工作,无需每次人工输入
│   │   ├── 自动化注册                            # 按工作区持久化(触发器 + 智能体任务 + 工具策略)
│   │   ├── 定时触发                              # cron 计划到点触发
│   │   ├── 事件触发                              # 响应系统事件触发(eventSessionKindFilter + metadata 过滤)
│   │   ├── 链式触发                              # automation 可触发 automation(纯函数匹配,有意无环检测)
│   │   ├── 执行记录                              # 每次 run 持久化(start/end/status/session)供审计
│   │   ├── automation 会话                       # 每次执行跑在独立 automation-kind 会话
│   │   ├── 会话页 live 状态                       # llm 执行注册真 SessionRuntime,SDK 流译成 wire 事件 fan-out 给 viewer:会话页选中运行中 automation 见细粒度状态栏(思考中/正在执行<工具>/就绪)+ transcript 实时增长,结束收敛 idle,事后选中回放完整 buffer;command 类仅 running/idle 二态
│   │   ├── 默认智能体                            # 新建 automation 默认用可配置的「automation 默认智能体」
│   │   ├── c3 MCP 工具                           # 意图(find/view/save_directly/pr)+ PR 事件 + 讨论(find/view/start/continue)工具,按需挂载;Claude 与 codex 都走 loopback HTTP MCP 路由(同一批工具)
│   │   └── network-access 网络开关               # toolAllowlist 伪条目(非工具),勾选时向 codex workspace-write 沙箱透传 networkAccess;冻结前剔除不进权限网格,claude 忽略,默认断网
│   │
│   ├── codes 代码浏览                            # 浏览器里只读浏览 Git 仓库 + 代码域内嵌会话
│   │   ├── 仓库浏览                              # 列分支、提交、某 ref 下的文件树
│   │   ├── 文件树 Git 状态                       # 文件三态(改动/未跟踪/暂存,可组合)+ 目录汇总圆点
│   │   │                                        # 独立只读快照(git status --porcelain);手动刷新同拉,
│   │   │                                        # 可见且聚焦时每 15s 轮询,隐藏/失焦/离开暂停
│   │   ├── diff 查看                             # 展示某提交或两 ref 间的 diff
│   │   ├── 代码域会话                            # 内嵌 session 就代码提问(含「+ 新建」「↻ 重置」)
│   │   └── 只读保证                              # 此视图绝不改动仓库(含 Git 状态查询)
│   │
│   ├── workcenter 工作台                         # 全局运行总览与用户通知的聚合处理中心(页内导航 Dashboard/用户通知)
│   │   ├── Workspace Dashboard                   # 一次聚合快照展示全部 workspace 的运行规模与总闸
│   │   │   ├── 规模统计                          # 每行:运行中 session/session 总数(全 kind)/intent/讨论/自动化总数
│   │   │   ├── 自动化总闸状态                     # 每行展示 workspace 自动化总闸(归一,缺省为开);非管理员为只读 on/off 徽标
│   │   │   ├── 逐行总闸开关                       # 管理员每行滑动开关直接开/关该 workspace 自动化(该行在途禁用,仅失败时 toast)
│   │   │   └── 合并刷新                          # 首次/重连/领域广播变化触发去重合并的一次快照刷新
│   │   ├── 用户通知(事件聚合)                    # 左栏通知列表 + 右栏详情两栏
│   │   ├── 权限响应/作答                         # 在工作台直接 Allow/Deny、AskUserQuestion 作答
│   │   ├── 状态筛选分页                          # all/todo/done/canceled/auto 筛选 + 20 条游标分页
│   │   ├── 共识留痕                              # auto 记录的投票/裁决只读回看
│   │   └── 溯源跳转                              # 按 sessionKind+sessionId 跳回来源页(会话/需求/讨论/自动化)
│   │
│   ├── sandbox 沙箱                              # 仅 worktree intent-dev run 进 arapuca 进程级隔离,网络当前全开
│   │   ├── 进程级隔离                            # arapuca 内核 MAC 限制目录 ro/rw,宿主同路径无映射、无凭证注入、无容器
│   │   ├── 固定放行                              # 项目原目录 ro / worktree rw / specsBase rw,其余 deny-by-default 不可见
│   │   ├── 补充放行                              # extraMounts 逐项 {path, ro/rw},保留路径不可覆盖、canonicalize 拒软链逃逸
│   │   ├── 会话种类过滤                          # sandboxSessionKinds 决定哪些 SessionKind 进沙箱(缺省 ['work'])
│   │   └── 硬失败                                # arapuca 缺失/平台不支持/放行路径非法即 hard-fail,绝不回落宿主裸跑
│   │
│   └── auth 鉴权                                 # 每条连接过身份门,每次改全局配置过管理员门
│       ├── 登录                                  # basic 用户名/密码校验,签发 session token
│       ├── 会话 token                            # 签发/校验 bearer token,TTL 默认 30 天
│       ├── 连接门                                # 拒绝未认证的 WebSocket 握手(token 走握手 ?token=)
│       ├── 管理员门                              # 仅管理员可改全局配置(agents/workspaces/settings)
│       └── 多账号                                # 多账号目录,首个创建者为唯一管理员
│
├── settings — 塑造智能体循环行为的用户配置(控制面板)
│   │
│   ├── agent-config 智能体配置                   # agent 档案目录与会话用哪个 agent 的规则(系统设置·agent 页)
│   │   ├── agent 档案                            # 持久化档案(vendor/url/key/model/name),可增删/排序/启停/复制
│   │   ├── 默认 agent                            # 未指定时使用的默认 agent(defaultAgentId)
│   │   ├── 专用 agent 路由                       # 工具/意图/规格/自动化会话可各指定 agent,空串「跟随默认」(tool/intent/spec/automationAgentId)
│   │   ├── 每会话绑定                            # 记住每个会话用哪个 agent
│   │   └── 降级链                                # 某 agent 不可用时按 degradationChain 顺序回退
│   │
│   ├── system-setting 系统设置                   # 管理员全局配置；运行时页展示 vendor CLI 与 sandbox(arapuca)驱动状态/绝对路径
│   │   ├── 显示与本地化                          # uiLang 界面语言 / voiceLang 语音输入语言 / timezone 系统时区(驱动 cron 解释)
│   │   ├── 公开访问地址                          # baseUrl 部署对外基址,用于拼分享深链
│   │   ├── 工具会话显示                          # showToolSessions 开关,决定工具类会话是否进侧栏
│   │   ├── vendor CLI 多版本生效选择             # 下载目标恒取最新兼容版,生效版可从已安装历史版单选;env override 仍最高优先,host PATH 仅降级回退
│   │   ├── 子进程代理                            # proxy 开关 + HTTP/HTTPS 地址,注入新会话子进程环境(不改服务端自身出网)
│   │   ├── 鉴权配置                              # auth:basic 多账号/唯一管理员、会话 token TTL、bind 地址暴露意图
│   │   ├── socket 自动续跑                        # socketAutoResume 开关,断连后单次自动 resume(默认开)
│   │   └── 环境诊断                              # 只读展示各 vendor host CLI/令牌探测结果
│   │
│   └── workspace-setting 工作区设置              # 按工作区独立配置(WorkspaceSetting,projectConfigs 按路径存,工作区设置面板)
│       ├── 默认权限模式                          # defaultMode 按 vendor 分组(claude=ModeToken / codex=CodexPolicy)
│       ├── dev 启动技能                          # devSkill 启动开发时前缀的斜杠命令
│       ├── Git 分支策略                          # gitBranchMode(current-branch / worktree)+ defaultMainBranch 基线/合并目标分支
│       ├── 工作区沙箱                            # sandbox:enabled + extraMounts(逐项 ro/rw)+ sandboxSessionKinds;仅 worktree 显示,启用后 dev run 进 arapuca
│       ├── 共识投票                              # consensus 多智能体权限共识配置(一致/多数、投票者集)
│       ├── 讨论上限                              # maxRoundsPerStage 每阶段轮次(≥8)/ maxSpeechChars 每轮发言字数(≥300)
│       ├── 规格驱动开发开关                      # sddEnabled 总开关,关时 SDD 质量门与批准检查点失效
│       ├── 外部技能仓库                          # skillRepos 技能源仓库,clone 到 ~/.c3/repo 并软链进各 vendor 发现目录;含显式 install_skill
│       └── 代码托管平台                          # forge(auto/github/gitlab)建 PR/MR 时的 forge 识别
```

## 维护

- 有新特性或特性变更时,同步更新本文件(与代码、`doc/domains/` 保持一致)。
- 每行一句话概述即可,详细行为下沉到对应 `<domain>-spec.md`。
