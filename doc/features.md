# c3 特性清单

c3(code creative center)全部特性功能的树状索引,每行一句话说明。按业务组/能力域组织,与 [`doc/domains/`](domains/) 一一对应。特性变更时同步本文件。

- 详细行为见各域 `<domain>-spec.md`;前端页面组件见 [`web/PAGES.md`](../web/PAGES.md);wire 协议入口见 [`shared/src/protocol.ts`](../shared/src/protocol.ts)(barrel + 两个消息联合的装配点),领域契约按域分区在 [`shared/src/protocol/`](../shared/src/protocol/)。

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
│   │   ├── 多厂商                                # 同时支持 Claude、Codex 与 Cursor 三个 vendor(均落在宿主 CLI 上;claude/codex 由 c3 分发,cursor-agent 由厂商自己的安装器分发)
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
│   │   ├── 会话目录                              # 按 sessionKind(work/intent/spec/spec_review/discussion/automation/tool)增删列
│   │   │   └── 规范类合并入口                    # 会话页「规范」既是显示分类也是查询口径:spec 撰写与 spec_review 评审同列同角标(每会话只计一次,兼容字段不重复计入顶栏),行保留真实 kind 与 owner
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
│   │   ├── 控制面                                # 模式切换、agent 切换、停止、继续、刷新;崩溃态(run 停止且末轮出错)状态栏直出一键重试,复用继续链路
│   │   ├── 会话控制                              # 会话增/删/改名/选择、工作区切换(增删受管理员门控)
│   │   ├── 双视图                                # 工作区(workspace)与工作台(workcenter)两大视图切换
│   │   ├── 移动端                                # MobileStack drill-down 栈式布局、软键盘/安全区避让
│   │   ├── 富文本渲染                            # Markdown+DOMPurify 双防线、Shiki 代码高亮、Mermaid 图表渲染(失败降级原代码块)、宽表横滚
│   │   ├── 分享链接                              # 标题栏「分享」按钮拼 [类型]标题+深链写剪贴板
│   │   ├── 启动进度遮罩                          # Start Work / Spec 启动的分步进度全屏遮罩
│   │   ├── 创建 PR 进度遮罩                      # 手动创建 PR 的分步进度全屏遮罩(分析变更/提交/推送/创建 PR),阻断重复点击,成功/失败/安全超时收敛关闭
│   │   ├── 创建意图进度遮罩                      # 带内容创建意图的分步进度全屏遮罩(下载/拉取关联分支/创建意图/打开意图会话),阶段按前端节奏近似,成功/拒绝/安全超时收敛关闭
│   │   ├── 新版本提示                            # update-checker 判定有新版时顶栏蓝色胶囊外链
│   │   └── 国际化 i18n                           # en/zh/ja/ko/ru 五语 + 日期/数字/管道复数,typed t 编译期检查
│   │
│   ├── intent-management 意图管理                # 把想法变成可验证、可追踪的意图账本并驱动其生命周期
│   │   ├── 意图账本                              # 按工作区持久化意图,追踪 status/生命周期
│   │   ├── 意图精炼                              # 只读 agent 把想法拆成可验证条目
│   │   ├── 正文直接编辑                          # draft/todo 意图正文行内编辑(纯文本 markdown),服务端状态门禁+写 intent_updated 日志
│   │   ├── 规格撰写与批准                        # 开发前生成 spec 并经人批准(spec 集中存 ~/.c3/specs);批准可撤销,撤销同时否决当前审核结论;save_intents 改写既有意图标题/正文亦使其批准失效
│   │   ├── 每意图 fast 规格模式                   # 意图可设 specMode='sdd'|'fast'(默认派生自工作区 sddEnabled):fast 仅绕开手动启动/恢复的 spec 准入闸门,自动化队列资格判定不变;turn 落定按相对基线 diff 与工作区阈值(默认 <3 文件/<50 行,严格小于)反向生成待批准 spec 补齐 SDD,或超限原子切回 sdd 由原闸门接管;该开关**仅在规范与开发均未起步前可改**(无规范内容 + 无规范会话 + 无工作会话,判据 canEditIntentSpecMode),起步后概览页降级为只读文本 + 锁定原因、set_intent_spec_mode 回 intent.specModeLocked 不落库不广播,无强制解锁入口
│   │   │   └── 「是否需要规范」开关              # 人工入口在意图详情「概览」tab 元信息区,三档(继承工作区/需要规范/不需要规范)选择即保存,展示服务端派生的 effectiveSpecMode;sddEnabled 关闭时仍可设置并提示此时无行为差异
│   │   ├── 规格只读审核                          # 独立 spec_review 会话读 spec/源码/本项目意图,写任意路径一律拒绝;结论只经 submit_spec_review 结构化提交
│   │   │   ├── 结论绑定内容指纹                  # 结论有效⟺指纹等于 spec 现内容;spec 改写即自动失效并重审,陈旧提交一律拒绝且不得解释为通过
│   │   │   └── 评审过程可核验                    # 意图详情「评审」tab(SDD 开启且有 specReviewSessionId 才出现)与会话页「规范」列表都经 open_spec_review_session 按意图恢复只读回放;人工续跑在服务端按 sessionKind 一律拒绝
│   │   ├── 规格直接编辑                          # 未启动开发且无运行中 spec 会话时行内编辑 spec 源码,覆盖写集中 specs 文件+审批联动重置+写 spec_updated 日志
│   │   ├── 意图开发                              # 启动可配置 dev skill,追踪 branch/commit/PR
│   │   │   └── attach·resume·fresh 三态启动      # 按 lastWorkSessionId:运行中只挂 viewer 不发新 turn,空闲在原 id 续跑,无会话才新建;人工按钮与 MCP 工具共用同一门禁(含 RM-A12 并发闸门:current-branch 全局互斥,worktree 各意图独立目录可并行)
│   │   ├── 意图交付                              # 追踪交付态(分支、提交、PR 状态)
│   │   ├── 基准分支快照                          # 「这个意图建在哪个分支上」落库为单值快照:创建取 defaultMainBranch→origin/HEAD 探测→main/master;首关联就绪交付改为该交付分支、该分支由未就绪变就绪追平一次、失去最后一条关联回退主分支,多交付保持已设值;与关联边同事务落定,不追随交付分支后续推进;PR 目标、worktree 基线、详情元信息共读同一值
│   │   ├── 失败定向修复指引                    # worktree 创建与 PR 创建链失败按当次命令结果(退出码/stderr/失败阶段)分类为闭集原因码,错误弹框展示对应修复指引 + 原始错误诊断详情 + 「重试原动作」入口;证据不足一律 unknown、原样展示原始错误且不臆测步骤;只分类不代劳(不清 worktree/不解冲突/不改凭据/不自动重试)
│   │   ├── 手动建 PR                             # 闸门序列 worktree→有分支→目标交付可用→目标 (intent_id, delivery_id) 无活跃 PR→相对目标 base 有 diff;base 一次解析贯穿 diff 闸门/forge/PR 行/事件;人工与顾问入口共用同一解析;目标 pair 已有 merged PR 时标题栏不渲染该按钮(仅前端、仅 merged,closed 仍留重提入口)
│   │   ├── PR 更新复位                           # 模型发 pr:update/success 时把 rejected/failed/closed 的 PR 行复位为 reviewing;须以 association.deliveryId 或 pr.number 唯一定位,定位不到即拒并落 error 日志,绝不猜测
│   │   ├── 意图依赖                              # intent_deps 依赖图(blocks/informs/soft_after),依赖门控启动
│   │   │   ├── base 可达判据                     # 判据是「依赖产出在不在我的 base 上」而非「PR 合了没」:同交付看该交付的 PR 行、跨交付看依赖所属交付是否 delivered、无交付沿用旧判据;唯一一份共享纯函数,手动/队列/投影共用(ADR-0038)
│   │   │   ├── 可解释阻塞 + 强制放行             # 阻塞文案明示「依赖在交付 X,X 未合入主线」并可跳转;依赖闸门是建议,可一次性强制放行(二次确认+风险说明+intent_logs 审计),只跳依赖一道,队列不提供
│   │   │   └── 阻塞态前序指引                    # 被依赖闸门挡住的意图,「下一步」提示展示第一个阻塞它的前序意图(标题+状态),按钮跳转到其详情;复用闸门判定,不提供跳过/放行
│   │   ├── 危险动作收进溢出层                    # 意图详情标题栏只留核心动作,「取消」「删除」收进末位常驻「…」菜单(Esc/点击外部收起),两项各走 danger 二次确认;done 两项皆无则「…」整体不渲染,cancelled 只留「删除」
│   │   ├── 沟通会话                              # 意图右栏 intent session 多会话(新建/选择/改名/删除)
│   │   ├── 自动化队列                            # 勾选 automate 的意图按优先级+依赖逐条自动开发、判定完成、提交/推送(唯一自动 done 路径之一)
│   │   │   ├── 确定性调度内核                    # 10s tick 全量对账:从意图账本+run 存活探测+少量调度元数据重推导动作;纯逻辑在 kernel/queue,不 import features/transport
│   │   │   ├── 事件合并标脏                      # 生命周期事件只标记「需重查」并合并去重,不携带决策依据/不重放;丢事件只延迟一轮,不再卡死
│   │   │   ├── 单意图失败隔离                    # 失败只计该意图:指数退避(30s 起翻倍,上限 15min),连续 3 次 park;队列继续跑无依赖关系的其他意图
│   │   │   ├── park 与下游阻塞                   # park 非 done:依赖被 park 意图的下游继续被依赖闸门挡住,既不跳过也不放行
│   │   │   ├── 权限等待交回人工                  # 权限提示超队列等待窗口只 park+推 wait-user-involve 待办,运行不中止、决定不代答(C-SEC-3)
│   │   │   ├── 启动对账与恢复                    # 启停意愿持久化;服务启动先全工作区对账,从持久事实恢复,db 不可用时不凭空恢复也不清空
│   │   │   ├── 规格阶段自治                      # 未过 spec 闸门的意图细分为:撰写→只读审核→需修改则携理由返工(硬上限 3 轮,超限 park+人工待办)→通过后等待批准
│   │   │   │   ├── 触顶卡点与人工接管            # 返工触顶后列表/详情不再给重试,改示审核卡点原文 + 单一「人工接管」入口跳到该意图 spec 页签
│   │   │   │   └── opt-in 机器批准               # 每工作区显式开关,默认关闭;关闭时即使结论为通过也绝不自动置真,开启时按条件事务写入并记机器身份常量
│   │   │   ├── 并发意图数上限                    # 工作区 automationConcurrency(默认 2):worktree 下最多 N 个意图同时开发,达上限其余 eligible 以 blocked_concurrency_gate「已达并发上限 N」阻塞;current-branch 共享检出恒串行(上限恒 1,配置不生效);spec 撰写/审核不计入,人工/MCP 启动不受配额限制,调低不取消在途会话
│   │   │   ├── 决策日志                          # queue_decision_log 按 tick/intent 记动作/闸门/理由/尝试退避计数/下次唤醒,不记 prompt/凭据/权限正文
│   │   │   ├── 静默超时判定                      # 队列在跑却 30 分钟无进展且无任何已知等待态(park/退避/冷却/闸门/强制跳过/权限/spec 阶段)时派生 silent_timeout 提示;重复 tick 的同一结论不续期,时间缺失/未来/回拨一律不报;只读投影,不改内核、不自动重试
│   │   │   ├── park 漏斗观测                     # funnel_event 只记 parked/unparked 跃迁(六列全是 id/封闭枚举/时间戳,写入边界拒自由文本);状态写成才记,记不成也不回滚 park/unpark
│   │   │   ├── 队列页面与人工夺回                # 逐条展示阻塞原因/下次唤醒(退避·冷却带剩余倒计时,到点自动取新投影)/最近决策;park 行展示本地化原因(缺失有占位)与一键解除入口;pause·force-skip·unpark·覆盖结论各对应一个内核动作,均不得绕过硬闸门,被拒的控制经全局 toast 呈现(不落队列页看不到的聊天流)
│   │   │   │   └── 并发闸门队列位次              # 只对过了全部闸门仅被并发闸门挡住的候选给 1..N 位次,顺序复用调度排序;派生不落库,下轮重算,闸门释放即清空
│   │   │   └── 顾问 Agent 工具面                 # 决策点按需唤起的顾问专属 MCP 工具组(读 transcript/run 状态、stop_run、reset 会话、非 done 状态流转、建 PR/同步 PR、raise_user_todo)
│   │   │       ├── propose-then-validate 双保险  # 纯函数校验器接受/拒绝结构化提案(拒绝带稳定原因码+可重试性+约束),每个写工具在副作用前于服务端再校验一次
│   │   │       ├── 专属作用域                    # 独立注册表+独立 loopback 路由,workspace/intent 由闭包绑定;不进 AUTOMATION_C3_TOOL_NAMES,普通 automation 能力不变
│   │   │       ├── 明确不提供                    # 不注册 approve_spec(含别名),不接受把意图标记为 done——RM-R9 自动完成例外不扩大
│   │   │       └── 链深度闸门                    # 超上限在唤起 Agent 与任何工具副作用之前拒绝,并向 queue_decision_log 落一条稳定原因码;日志写失败不放宽限制
│   │   └── Git/PR 收尾                           # 手动 Start Dev 结束时经 gh 建 PR、回填 commit/PR 状态
│   │
│   ├── delivery 交付                             # 交付作为集成单元:一批意图共同集成并最终进入主线,回答「这批能不能合了、卡在哪」
│   │   ├── 写入窗口闸门                          # verifying/verified/delivered/cancelled 期间其关联意图不再产生新写入会话(验证期间合代码=验证作废),多关联取最严;手动与队列同一判据
│   │   ├── 会话交付上下文                        # 决定 base 的是会话不是意图:启动时 0 关联→无上下文/恰好 1 个→自动带入/≥2 个→必须显式选定否则拒绝;持久化于 intent_sessions.delivery_id,resume 复用不重猜
│   │   ├── worktree 基线 origin/<基准分支>       # 新 worktree 以意图持久化的基准分支为根(单交付关联即交付分支);已存在的只检测不修:基线不符阻塞启动并给「重建(需干净)」「合入该分支」两个显式出口,从不自动重建/暗中 merge,无强制放行
│   │   ├── 同步主线                              # integrating 期间人工触发把 origin/<base_branch> 合入交付分支(临时 detached worktree,不碰用户检出);冲突原样浮出不代解;页面显示「主线领先 N」提示;不做定时自动回灌
│   │   ├── 交付账本                              # 按工作区持久化交付(标题/描述/base_branch 快照/日期/分支名),status 六态 CHECK 闭集
│   │   ├── 受控状态机                            # planned→integrating→verifying→verified→delivered,任意非终态可取消;回退 verifying→integrating(人工返工)/verified→verifying(系统合并冲突);统一经 canTransitionDelivery 纯函数
│   │   ├── 守卫与缺口                            # 分支就绪→关联意图 PR 全部合入→人工确认验证→合并成功;缺口以 delivery.guard.* 结构下发,页面据此隐藏被挡目标并在标题栏下方呈现异常框+跳转;branchNotReady 跳转到本页分支初始化区
│   │   ├── 集成就熟 N/M                          # 实时由 intent_prs.delivery_id 聚合,不持久化计数;无「已完成」态,只以 N/M 呈现
│   │   ├── 交付 CRUD + 取消                      # 纯本地数据动作不触网;取消是生命周期终结方式,无永久删除
│   │   ├── 分支初始化(create/bind)               # 创建交付与初始化分支拆两步:init_delivery_branch 显式可重试;基线先 fetch 取 origin/<base_branch> HEAD;支持绑定已有远端分支(落后仅警告)
│   │   ├── 孤儿分支防御                          # push 成功但 DB 写失败后重试:远端同名分支起点匹配则幂等绑定,不匹配报 delivery.branchConflict 且绝不覆盖远端
│   │   ├── 多仓拒绝                              # 根非 repo 且有子仓的工作区建交付与初始化分支均报 delivery.multiRepoUnsupported(单列分支无法表达部分仓已交付)
│   │   ├── branch_ready 闸门                     # 分支未就绪时状态推进与面向交付的意图建 PR 被拦(可读原因);就绪后成为状态机真正可用的第一级守卫
│   │   ├── 意图关联/解除                         # intent_deliveries 关联边(与 intent_prs.delivery_id 的「PR 落点」职责分离);关联只建边不改投已有 PR;两侧页面互见,交付页与意图详情两处入口同权(服务端是唯一门禁),意图侧只覆盖 0↔1 关联;意图侧关联入口在标题栏(未关联态主色描边强调),解除入口在概览元信息「关联交付」行的交付名之后(低频维护动作不占标题栏)
│   │   ├── 当前意图独立交付                      # 意图侧一键:以意图标题/正文建交付(起止均为当天)→关联→初始化分支到就绪,前端编排三条既有消息不加协议面;仅 worktree 模式;任一步失败停在该步,已完成部分保留可从交付页续做
│   │   ├── PR 提向交付分支                       # 已关联交付的意图其 PR base 为交付分支,未关联仍提主线(交付是可选聚合层);目标须已关联,多关联不开放入口也不代选;PR 行按交付分组展示
│   │   ├── merged 禁解                           # 对本交付的 PR 已合并则一律拒绝解除(本地状态 + forge 实时状态双层);forge 读不到状态同样阻塞,绝不猜「不是 merged」
│   │   ├── 解除即关 PR                           # 确认未合并后关闭 PR(已关闭视为成功)、删该 PR 行再删边;关闭失败整个解除阻塞,边与 PR 行都不动
│   │   ├── diff 膨胀提示                         # 关联时按分叉点判据检测「意图基于主线而非交付分支」,只提示不阻塞;检测失败静默
│   │   ├── 终态分支清理                          # delivered/cancelled 后不自动删分支;手动清理需 danger 二次确认,仅删本地引用不删远端
│   │   ├── 一级页面                              # 顶栏「交付」tab 置于「需求」后;角标只计服务端计算的「需要用户处理」交付(含交付 PR 待创建/合并受阻,纯等待不计);详情仅概览/关联意图两 Tab,概览含分支初始化区与合并区
│   │   ├── 交付 PR(交付分支→主线)               # verified 后建一条交付 PR 由人在 forge 合并,c3 从不代合;闸门 worktree→verified→分支就绪→相对主线有差异(无差异见「已在主线即自动交付」)
│   │   ├── 先查 forge 事实的幂等                 # 重试必须先按 (head, base) 查 forge 开放 PR,命中即复用、查不到才建、问不出来即中止;落账按 PR 身份刷新 SHA,(delivery_id, base_sha, head_sha) 唯一索引兜底
│   │   ├── 三类失败分层                          # 冲突→回退 verifying 并落冲突文件+SHA(代码要改);CI 失败/审批不足→状态不动、落 blocked_reason 展示「合并受阻」(代码没问题);查询失败→不改状态可重试
│   │   ├── 已在主线即自动交付                    # 建 PR 时无差异按成因分流:台账证明分支承载过产出(关联意图 PR 全 merged)即判定已被 c3 外合走,直接落 delivered 并回 notice=delivery.autoDelivered 让页面说明理由;从未承载产出才拒 deliveryPrNoDiff。PR 已 closed 而代码另行进主线时同步也这样落定,但 PR 行保持 closed;尽力查 forge 已合并 PR 补身份,查不到不阻断
│   │   ├── delivered 原子写 + 连锁               # PR 变 merged 或产出已在主线即在同事务写状态+交付日志;提交后不改写关联意图状态、触发跨交付闸门重算、发 delivery:delivered、广播;事件/重算失败不回滚
│   │   ├── 感知窗口期                            # forge 已合并到 c3 感知之间展示「等待确认」,进页自动同步一次 + 手动同步入口;不做后台轮询
│   │   ├── current-branch 降级                   # 该模式交付为纯聚合视图:分支/PR/合并动作不渲染并给说明文案,纯数据操作不受限
│   │   ├── pr:merge 知情告知                     # 工作区首次创建交付时一次性提示「pr:merge 的 base 可能是交付分支」,请检查自动化订阅;pr:merge 事件的 ref 带 baseBranch(合并目标分支名)+ baseTarget(mainline / delivery-branch),订阅方据此区分产出落在交付分支还是主线(可选字段,只带 head/base 的形态同样合法)
│   │   ├── delivery:* 事件族                     # 六类通用事件可订阅:created / status_changed(metadata 带 from、to)/ branch_ready / pr_created / delivered / cancelled;走既有 normalizeEvent→eventBus 管线无专用归一化器;进终态时 status_changed 与终态事件同发不去重;发布在状态写提交之后,失败只 warn 不回滚不阻断广播与闸门重算
│   │   └── 交付只读 MCP 工具                     # 自动化面与外部面各暴露 find_deliveries / view_delivery(只读,两面均默认不勾选);刻意不开任何交付写工具——状态写必须过状态机与守卫,写工具会绕开全部闸门
│   │
│   ├── discussion 多智能体讨论                   # 多个 agent(与人)围绕主题圆桌讨论,可转为意图
│   │   ├── 讨论账本                              # 按工作区持久化讨论(主题+参与者)
│   │   ├── 多 agent 轮流                         # 组织者引擎编排参与 agent 的轮流发言
│   │   ├── 人类参与                              # 人可发言进入讨论、暂停/恢复
│   │   ├── 参与者定向                            # 创建时勾选参与 agent,空集回退全员,组织者恒并入
│   │   ├── 研究会话                              # 创建后的只读研究跑批是正式会话:捕获 vendor sessionId、transcript 落厂商存储、状态栏/停止/追问 resume 改写研究结果;只读闸对追问同样成立
│   │   ├── 讨论转意图                            # 把讨论结论转化为意图
│   │   ├── 讨论 MCP 工具                         # automation LLM 可 find/view/start/continue 讨论,含 in_progress 无存活run 的错误恢复
│   │   └── 讨论生命周期事件                      # start_discussion 可带业务 metadata 持久化;编排唯一入口/收尾各发一次 discussion:start / discussion:end(complete/error/aborted),供自动化按 metadata 订阅
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
│   │   ├── 执行 vendor                           # claude/codex/cursor 均有 dispatcher 执行路径(共享 AUTOMATION_VENDORS,表单灰显与分派门控同一份);cursor 走 cursor-agent CLI,mode 按 cursor 目录(plan/agent/full-access)解析,CLI 找不到/agent 无效在分派期即失败,不跨 vendor 回退
│   │   ├── c3 MCP 工具                           # 意图(find/view/save_directly)+ PR 状态同步(sync_intent_pr_status,只接受 intentId,触发服务端从 forge 派生终态落库)+ 交付只读(find_deliveries/view_delivery,无写工具)+ PR 事件 + 讨论(find/view/start/continue)工具,按需挂载;claude/codex/cursor 都走同一条 loopback HTTP MCP 路由(同一批工具);列在目录里只代表可勾选,内置模板一律不默认勾交付工具
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
│   │   └── 溯源跳转                              # 有 intentId 的进意图页选中该意图,sessionKind 只定子页签(spec→编写规范/intent→意图会话/其余默认);无归属的按 sessionKind+sessionId 进会话页
│   │
│   ├── sandbox 沙箱                              # 工作区启用且 SessionKind 入选的 run 进 arapuca 进程级隔离(不限来源/分支模式),网络当前全开
│   │   ├── 进程级隔离                            # arapuca 内核 MAC 限制目录 ro/rw,宿主同路径无映射、无凭证注入、无容器
│   │   ├── 固定放行                              # 执行根 rw(worktree 或源工作区)/ 源工作区 ro(仅执行根为 worktree 时,同路径并入 rw)/ specsBase rw,其余 deny-by-default 不可见
│   │   ├── 补充放行                              # extraMounts 逐项 {path, ro/rw},保留路径不可覆盖、canonicalize 拒软链逃逸
│   │   ├── 代理透传                              # 宿主设有 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY(含小写)任一非空键时 wrapper 追加 --allow-proxy-env,由 arapuca 转发;零配置、无工作区开关
│   │   ├── 会话种类过滤                          # sandboxSessionKinds 决定哪些 SessionKind 进沙箱(缺省 ['work'])
│   │   ├── 订阅态认证透传                        # 本次 agent 为 system(订阅态)时 wrapper 追加 --allow-keychain 打开宿主 keychain;沙箱不参与 agent 选择,run 保留正常解析出的 agent,无专属角色配置、不弹窗不换绑
│   │   ├── per-vendor 认证策略                   # 入口命令/数据根/凭据变量/额外挂载/身份变量/keychain/启动前目录按 vendor 注册,wrapper 生成不含 vendor 分支;未注册 vendor 生成前 hard-fail
│   │   ├── arapuca 版本关联                      # c3 关联并异步自动安装经校验的 arapuca 到 ~/.c3/sandbox/arapuca(SHA-256 + 原子激活),缺失时回退宿主 PATH、不阻塞当次 run;安装尝试无论成败冷却 24 小时(跨进程持久化)
│   │   └── 硬失败                                # arapuca 两条链皆无/平台不支持/放行路径非法即 hard-fail,绝不回落宿主裸跑
│   │
│   ├── auth 鉴权                                 # 每条连接过身份门,每次改全局配置过管理员门
│   │   ├── 登录                                  # basic 用户名/密码校验,签发 session token
│   │   ├── 会话 token                            # 签发/校验 bearer token,TTL 默认 30 天
│   │   ├── 连接门                                # 拒绝未认证的 WebSocket 握手(token 走握手 ?token=)
│   │   ├── 管理员门                              # 仅管理员可改全局配置(agents/workspaces/settings)
│   │   └── 多账号                                # 多账号目录,首个创建者为唯一管理员
│   │
│   └── external-mcp 外部 MCP 接入                 # c3 未拉起的 agent(独立 Claude/Codex 会话、CI、监控脚本)凭长期 key 访问本部署;与 /internal/*-mcp 并列而非放宽,后者语义不变
│       ├── 公开路由 /mcp/<api-key>               # key 即路径段,Streamable HTTP,挂在 SPA catch-all 之前;不做 loopback 判断,key 是唯一凭据
│       ├── 每请求重建作用域                      # 无 run 闭包:key 绑定的单一工作区 + 该 key 工具范围,每次请求重新解析
│       ├── 鉴权链                                # 凭据先于一切(缺失/格式错/未知/吊销统一 401);工作区不可用 403;旧 /mcp/v1?token= 返回 410 停用
│       ├── 会话作用域钉死                        # initialize 时绑定 key id + 工具范围,后续同 session 换 key 一律 403,不静默改作用域;改范围/吊销即断
│       ├── 工具目录(显式 allowlist)              # 读:find_intents/view_intent/find_discussions/view_discussion/publish_event(新 key 默认勾选)+ find_deliveries/view_delivery(可授权但**默认不勾选**);写:save_intents/save_intent_directly/submit_spec_review/start_session_for_intent/start_discussion/continue_discussion(默认不勾选);目录不含按意图回填 PR 状态的工具,无法授权
│       ├── 目录与默认集解耦                      # 「可被管理员勾选」与「新 key 自动获得」是两份名表:EXTERNAL_MCP_READ_TOOLS 是分级来源,EXTERNAL_MCP_DEFAULT_TOOLS 是建 key 时服务端强制写入的初值;编译期钉死默认集只能取读级工具
│       ├── 越权拒绝                              # 未勾选工具不进 tools/list,绕过发现直接调用返回稳定 forbidden 且无副作用
│       └── 事件归属                              # publish_event 的 envelope workspace 取自绑定工作区,sessionId 固定 external-mcp:<key-id>,调用方无法伪造
│
├── settings — 塑造智能体循环行为的用户配置(控制面板);作用域分系统级 / 工作区级 / 个人级三类
│   │
│   ├── agent-config 智能体配置                   # agent 档案目录与会话用哪个 agent 的规则(系统设置·agent 页)
│   │   ├── agent 档案                            # 持久化档案(vendor/url/key/model/name),可增删/排序/启停/复制;vendor 下拉含 Claude/Codex/Cursor 三档,Cursor 恒 system 模式且只有 {apiKey, model}(无 baseUrl;apiKey 可留空,回落 cursor-agent 登录态)
│   │   ├── 分组容器编辑                          # agent 列表按分组容器渲染,group 为空的归入 default 容器;拖动跨容器移动、组内箭头调优先级(可见顺序即故障转移顺序),容器可重命名/解散;一个组只装一种 vendor,空容器不落盘
│   │   ├── 运行时可用性门控                      # 各 vendor 能否起一轮由 settings 的中立信号 vendorRuntime 决定(统一的宿主 CLI 探测);不可用的 vendor 选项禁用并就地标注原因,已配置的 agent 仍可查看编辑
│   │   ├── 默认 agent                            # 未指定时使用的默认 agent(defaultAgentId)
│   │   ├── 专用 agent 路由                       # 工具/意图/规格/规格审核/自动化会话可各指定 agent,空串「跟随默认」(tool/intent/spec/specReview/automationAgentId);审核槽位唯一,无 sandbox 变体
│   │   ├── 角色配组与故障转移                    # default/tool/intent/spec/specReview 可指向虚拟组 _c3_<vendor>_<group>;会话绑定保留组引用、代表成员(order_seq 首个 enabled)决定 vendor/展示,每次运行重解析;组无可用成员(全禁用或组 vendor 运行时缺失)时创建/绑定明确报错 agent.groupUnavailable,不回落 System
│   │   ├── 启动段与组游标                        # 组内可混 custom(经 relay)与 system(CLI 自身登录)成员,一次 run 只服务候选列表的启动段且段首一定被使用;段内由 relay 按序 failover,跨段靠会话游标——run 因可降级错误失败后游标推进,resume 落到下一个候选,组为环不困在尾部
│   │   ├── 沙箱模式角色                          # 未显式绑定且默认解析为 system 时改用 sandboxDefault/tool/intent/spec/automationAgentId(custom/system 皆可选);空串按 sandboxDefault→第一个启用 agent(同 vendor 优先)顺延,解析不到则保留默认 agent
│   │   ├── 每会话绑定                            # 记住每个会话用哪个 agent
│   │   └── 降级链                                # 某 agent 不可用时按 degradationChain 顺序回退
│   │
│   ├── system-setting 系统设置                   # 管理员全局配置；运行时页为每个 vendor 出一行诊断(二进制名 + 解析来源 + 已解析绝对路径),另展示 sandbox(arapuca)驱动状态
│   │   ├── 显示与本地化                          # voiceLang 语音输入语言 / timezone 系统时区(驱动 cron 解释);界面语言属个人化设置
│   │   ├── 公开访问地址                          # baseUrl 部署对外基址,用于拼分享深链
│   │   ├── 会话页显示                            # showSessionsPage 开关,决定主导航是否在代码后显示会话页
│   │   ├── 工具会话显示                          # showToolSessions 独立开关,决定工具类会话是否进聚合页侧栏
│   │   ├── vendor CLI 多版本生效选择             # 仅托管 vendor(claude/codex):下载目标恒取最新兼容版,生效版可从已安装历史版单选;env override 仍最高优先,host PATH 仅降级回退;非托管 vendor(cursor)不进该面板
│   │   ├── 子进程代理                            # proxy 开关 + HTTP/HTTPS 地址,注入新会话子进程环境(不改服务端自身出网)
│   │   ├── 会话清理                              # sessionCleanup 开关 + 保留天数(默认关、30 天),每日删除各 vendor 会话存储中超期的会话记录;vendor 中立、覆盖沙箱与宿主 home
│   │   ├── 鉴权配置                              # auth:basic 多账号/唯一管理员、会话 token TTL、bind 地址暴露意图
│   │   ├── 外部 MCP API Key 存储                # mcpApiKeys 长期 key 记录(唯一绑定工作区+工具范围+加盐 scrypt 哈希),是 SystemSettings 的兄弟键故 save_settings 既不携带也无法注入;生命周期管理在工作区设置
│   │   ├── 监听地址                              # --host 显式绑定接口,默认 127.0.0.1(收紧原「不传 hostname 即全网卡」的隐式行为),贯穿 CLI/daemon/OS service;日志打印实际监听地址且不含 key
│   │   ├── socket 自动续跑                        # socketAutoResume 开关,断连后单次自动 resume(默认开)
│   │   └── 环境诊断                              # 只读展示各 vendor host CLI/令牌探测结果
│   │
│   ├── personalized-setting 个人化设置           # 按人偏好(PersonalizedSettings),独立入口页,不过管理员门,普通账户可改
│   │   ├── 显示语言                              # uiLang 界面语言,选中即切 vue-i18n + <html lang> 并按当前身份保存
│   │   ├── 显示样式                              # theme 配色主题,选项来自可扩展主题注册表(dark 默认 / light),选中即写根元素 data-theme 并按当前身份保存
│   │   ├── 字体大小                              # fontScale 全局 UI 字号(70–120,拖动条),经根元素 --c-font-scale 缩放相对单位字号,选中即生效并按当前身份保存
│   │   ├── 按身份存储                            # 已认证存服务端 personalizedSettings[subject];无身份存浏览器 localStorage,不跨设备同步
│   │   ├── 首次登录播种                          # 账户无记录时以本浏览器合法值锁内建档一次;账户记录一旦存在即权威,不被本地值覆盖
│   │   └── agent 输出语言                        # 顶层 agentLang 跟随最近一次上报,供无连接上下文的服务端提示词(意图/规格/标题/总结)使用
│   │
│   └── workspace-setting 工作区设置              # 按工作区独立配置(WorkspaceSetting,projectConfigs 按路径存,工作区设置面板)
│       ├── 默认权限模式                          # defaultMode 按 vendor 分组(claude/codex/cursor;字符串经各 MODE_CATALOGS 门禁,非法回退 defaultToken;codex 可持 CodexPolicy)
│       ├── dev 启动技能                          # devSkill 启动开发时前缀的斜杠命令
│       ├── Git 分支策略                          # gitBranchMode(current-branch / worktree)+ defaultMainBranch 基线/合并目标分支
│       ├── 工作区沙箱                            # sandbox:enabled + extraMounts(逐项 ro/rw)+ sandboxSessionKinds;两种分支模式均可编辑,启用后入选 run 进 arapuca
│       ├── 共识投票                              # consensus 多智能体权限共识配置(一致/多数、投票者集)
│       ├── 讨论上限                              # maxRoundsPerStage 每阶段轮次(≥8)/ maxSpeechChars 每轮发言字数(≥300)
│       ├── 规格驱动开发开关                      # sddEnabled 总开关,关时 SDD 质量门与批准检查点失效
│       ├── 机器批准开关                          # specMachineApprovalEnabled 显式 opt-in,默认关闭;开启后审核通过的 spec 由队列以机器身份批准,仍可人工撤销
│       ├── fast 规格阈值                          # fastSpecMaxFiles/fastSpecMaxLines 小改动上限(默认 3 文件/50 行,严格小于)UI 可调;fast 意图落定 diff 达到任一值即超限,原子切回 sdd
│       ├── 自动化闸门总开关                      # automationEnabled 自动派发总闸,缺省开;关时 cron/事件派发前短路,各自动化 active/paused 不受影响
│       ├── 队列并发意图数                        # automationConcurrency 缺省 2:worktree 下最多 N 个意图同时开发,current-branch 恒串行不生效;达上限 blocked_concurrency_gate「已达并发上限 N」,spec 撰写/审核不计入、人工/MCP 启动不受配额限制
│       ├── 外部技能仓库                          # skillRepos 技能源仓库,clone 到 ~/.c3/repo 并软链进各 vendor 发现目录;含显式 install_skill
│       ├── 代码托管平台                          # forge(auto/github/gitlab)建 PR/MR 时的 forge 识别
│       ├── 本机观测(只读)                       # park 后 24h 恢复率 + recovered/eligible/pending 样本数;不属于设置草稿,不参与保存/脏状态;查询失败显示「暂不可用」并可重试
│       │   ├── 数据边界                          # 只在本机、滚动保留 90 天、无自由文本、不外传;页面无开启遥测/导出/上传/改保留期/清空控件
│       │   └── 决策口径                          # 60% 正向信号、70% 强信号;上线 2–4 周复查,无提升则作废基于本批指引的全部 P1/P2 后续投入
│       └── 外部 MCP 接入(非配置)                 # 本工作区 key 的生成/列示/工具范围编辑/吊销;一次性揭示区给明文 key + /mcp/<key> 地址 + 一行式 claude mcp add 命令;非配置,不参与保存/脏状态
│           ├── 默认只读                          # 新 key 一律只读工具,写工具须创建后显式勾选(保存前危险确认)
│           ├── 不可用态                          # 绑定工作区目录消失/注销的 key 只留吊销,不披露宿主路径
│           └── 缺失引导                          # baseUrl 未配置时明说未配置并跳系统设置(不猜浏览器 Host)
│
└── distribution 分发形态                        # 同一次发布产出两个渠道,共享同一个 ~/.c3(设置/凭据/工作区/DB/会话)
    ├── CLI 单二进制                              # 每平台一个原生可执行文件(c3-v{ver}-{target}.tar.gz|zip),终端启动 + 浏览器访问;c3 upgrade 自更新
    ├── 桌面 App(Tauri 2)                        # 安装包双击即用(dmg/msi/exe/deb/AppImage),壳把同一份二进制当 sidecar 拉起,原生 WebView 渲染其自带 SPA
    ├── sidecar 回环绑定                          # 壳固定给 sidecar 传 --host 127.0.0.1 + 本次选中的可用端口,不读也不放宽 exposure.bindAddress
    ├── 托盘常驻与开机自启                        # 关窗只隐藏、后端继续跑;托盘「打开 c3 / 开机自启 / 退出」,自启默认关且与 c3 install 系统服务互不相干
    ├── 受管子进程边界                            # 壳只管自己创建的 sidecar,按 pid+可执行文件+启动时间三元组校验后清理孤儿,绝不按端口或进程名杀外部 c3
    ├── 应用内自动更新                            # 启动后台检查+托盘/更新窗口手动检查,复用 CLI 共享升级内核(版本事实/传输/双重 sha256);下载入壳配置暂存区,用户确认后停 sidecar、由独立助手替换完整桌面包并重启,失败回滚旧版本
    └── 渠道化 manifest                           # 同一份 manifest 记录 platform/arch/channel/kind/preferred/file/sha256,file 为唯一键;manifest 随 Release 上传;CLI 渠道是发布闸门,桌面失败只丢自己
```

## 维护

- 有新特性或特性变更时,同步更新本文件(与代码、`doc/domains/` 保持一致)。
- 每行一句话概述即可,详细行为下沉到对应 `<domain>-spec.md`。
