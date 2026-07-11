# Web 页面与组件清单

c3 前端（Vue 3）所有页面、组件、composable 与工具模块的树状索引，每行一句功能说明。源码位于 `web/src/`。

```
web/src/
├── App.vue                                          # 应用入口壳(瘦):导入页面/模态组件,解构 useAppController() 的共享 ctx 绑定到模板(登录门 + 顶栏 + 各视图 + 模态 + 全局 toast + intent 动作错误弹框);全部控制逻辑下沉到 controls/
├── main.ts                                          # 应用入口:创建 Vue 实例、安装 i18n、挂载 App
│
├── controls/                                        # App 控制器:拆分自原 App.vue 的状态 + 消息路由 + 各域动作,经共享 ctx 对象晚绑定串联
│   ├── index.ts                                     # useAppController():建 state、装 runtime(client/send/reconnect/t/auth)、依次 install 各域、管理 WebSocket 生命周期(onMounted 建连/心跳/可见性/onReopen 重选),返回 ctx 供 App.vue 解构
│   ├── state.ts                                     # createState():全部 ref/computed + 纯状态辅助(statusOf/add/setQueue/showToast/sessionTitleById/clearSideEffectPending/sumSessionCounts)、计数器、localStorage 键常量;HEADER_TABS 的「会话」tab badgeCount=六类 sessionCounts 之和;导出 AppState 类型
│   ├── types.ts                                     # ctx 类型契约:AppRuntime(client/send/reconnect/t/auth)+ AppMethods(全部域方法签名),AppCtx = AppState & AppRuntime & AppMethods
│   ├── transcript.ts                               # transcriptToChat():TranscriptItem→ChatBody 纯映射(会话历史回放)
│   ├── persistence.ts                              # 视图恢复持久化:readStoredWorkspace/persistCurrentWorkspace/persistViewMode + ready 后 maybeRestore 需求/讨论/自动化
│   ├── message-handler.ts                          # installMessageHandler():唯一入站 WS switch(handleMessage)折叠所有 ServerToClient 事件 + applyStatuses/notifyAwaitingPermission;session_selected 的 owner 元数据派生会话标题栏跳回目标
│   ├── session-actions.ts                          # 工作区/会话/顶栏 tab 导航:按 session_kind 缓存的游标分页刷新(窗口/首页)/加载更多;selectSession 任意行统一 enterConsole+select_session 在右侧展示详情(无跳走分支),已是活动会话时不重复发送;selectSessionKind 清空视图+设置 pending bind,新类型列表回包后自动选首条(空列表保持空态);openSourceTarget 单一路径按 resolveSessionJumpTarget 目标打开意图详情/intent session 子 tab/spec session 子 tab(无 owner 的独立 chat 经 requestedIntentSessionId 在意图页右栏打开该会话)/讨论/自动化页,供 jumpSessionSource(行 ↗,传 row)与 jumpActiveSessionSource(标题栏溯源按钮,读 activeSessionSource+活动会话)复用;六类会话计数、新建工作会话弹窗、乐观删除改名、会话 tab 进入与重绑、清空视图会话
│   ├── intent-actions.ts                           # 需求页动作:筛选/精炼/写spec/批准spec/开发/PR/状态/自动化 + 沟通 session 列表(新建/选择/重命名/删除)
│   ├── discussion-actions.ts                       # 讨论页动作(只读路径 + 组织者引擎):打开/创建/开始/暂停/恢复/转需求/发言/移动返回
│   ├── automation-actions.ts                         # 自动化页动作:打开/选择/执行记录/会话回放 + 创建编辑表单(含 toolManifest 缓存 watch);选中且运行中的 llm 执行按周期自动刷新 detail+transcript(可见性闸/页内才刷),结束补拉一次后停止
│   ├── chat-actions.ts                             # 聊天/输入动作 + 客户端待发队列(enqueue/edit/delete/flush watch)、提交/继续/停止/刷新/模式/agent 切换/权限响应
│   ├── settings-actions.ts                         # 系统/工作区设置、技能安装、运行时语言切换(回滚)、workspace↔workcenter 视图模式、技能加载审批
│   ├── license-actions.ts                          # 产品许可(ADR-0026):打开 LS 登录页取 license_key(start_license_activation)、用 key 绑定本安装(bind_license),状态由 license_state/license_activation_started/license_bind_result 回流
│   ├── workcenter-actions.ts                       # 工作台事件动作:权限响应/作答 + reloadWorkcenter/loadMoreWorkcenter(20 条服务端分页,支持全部状态) + markDoneWorkcenter(本地改为 done) + 用标准 session 跳回规则跳转到来源页(会话/需求/讨论/自动化)
│   └── share-actions.ts                            # installShareActions():三处标题栏「分享」按钮的统一动作(shareLink({kind,workspaceId,id,title,typeLabel}))——读 serverSettings.baseUrl、经 lib/share-link.buildShareText 拼「[类型] 标题\n<baseUrl>/#/<kind>/<workspaceId>/<id>」、写剪贴板、成功 toast;baseUrl 未配置改弹「去系统设置填写」提示且不写剪贴板
│
├── components/                                      # 跨页面通用组件
│   ├── AppHeader/AppHeader.vue                      # 应用导航壳:桌面顶部栏(整行最左为 viewMode 工作区/工作台两图标切换器(显示器+三横条 / 显示器+会话气泡,生效蓝 --c-primary、失效灰,工作台未处理事件徽标挂工作台图标),其后工作区切换器、tab 导航(「会话」tab 右上角角标=当前工作区六类进行中会话数之和,为 0 不渲染,带 i18n aria-label)、项目配置/系统设置/登出/连接状态 + 新版本提示(服务端 update-checker 判定有更新时才渲染的独立蓝色胶囊外链,文案走 i18n nav.update.available 含版本号,点击新标签页跳 github.com/sequencestream/c3#upgrade;无更新/未知/检查失败均不渲染;移动端并入「⋯」操作菜单) + 许可状态下拉(ADR-0026,PL-R7,受控 details:已激活→✓ 图标按 state 着色,下拉显示有效期(termEnd 未知时回退状态文案)+ 有效期旁手动刷新按钮(触发即时 heartbeat 同步 termEnd,在途禁用旋转+最小冷却防连点,失败 inline 提示);未激活/过期/停用→红色带下划线文字,下拉内「激活许可」按钮触发激活流程)),移动端顶部精简栏左侧同款两图标切换器(许可项并入「⋯」操作菜单)+ 底部 5 视图 tab(会话/需求/讨论/自动化/代码;工作台入口已上移到顶部切换器,不在底部 tab)
│   ├── BaseDropdown/BaseDropdown.vue                # 标准下拉框:替代原生 select,支持键盘导航、多选高亮、点击外部关闭
│   ├── ChatColumn/ChatColumn.vue                   # 复用聊天列:五区块(标题栏/消息/输入框/状态栏/task 面板)按 showTitleBar/showMessages/showInput/showStatusBar/showTaskPanel props 可显隐,供会话页/意图会话 tab/意图详情两会话 tab 三处复用;不持有会话状态(绑定哪个会话由控制层单一活动会话决定);show-mode 控模式下拉、always-title 控无会话时是否仍渲染标题栏;sourceLabel 透传给标题栏溯源按钮(仅会话页传,意图侧复用不传)、open-source 上抛;showShare 透传给标题栏分享按钮(仅会话页 Works 传 true)、share 上抛;title-action 具名槽转发到 SessionTitleBar 的 action 槽(Codes 内嵌会话用它渲染「+ 新建」/「↻ 重置」按钮);prefill 经 defineExpose 透传
│   ├── ChatMessages/ChatMessages.vue               # 会话消息渲染区:扁平消息分组为文本/工具批次/独立块(用户交互工具)、仅用户停在底部时自动跟随新输出、渲染权限提示与共识结果,代码/工具输出局部横滚防窄屏撑破
│   ├── ConfirmDialog/ConfirmDialog.vue             # 通用二次确认模态框(项目内删除/危险操作统一走此组件,不用 window.confirm):受控 open,标题/正文/按钮文案注入,danger 确认色,点遮罩/Esc/取消均 emit cancel,移动端全屏 sheet
│   ├── ErrorDialog/ErrorDialog.vue                 # 持久错误告知弹框:受控 open,单一关闭按钮,点遮罩/Esc/关闭均 emit close,移动端全屏 sheet
│   ├── InputDialog/InputDialog.vue                 # 通用单行文本输入弹框(ConfirmDialog 风格 + 单行 input,替换 window.prompt):受控 open、标题/占位/按钮文案注入、打开聚焦并清空、输入为空时确认禁用、Enter 提交、遮罩/Esc/取消均 emit cancel、确认 emit confirm(trim 文本)、移动端全屏 sheet
│   ├── ConsensusBlock/ConsensusBlock.vue           # 多 agent 共识自动裁定结果块(只读):AskUserQuestion 逐题自动作答、其他工具 allow/deny 裁定
│   ├── DevStartupOverlay/DevStartupOverlay.vue     # 工作启动进度遮罩(App 根级,与全局 toast 同层):手动 Start Work 点击即全屏阻断,以最小停留防止快速启动闪烁,按有序步骤(拉取远程主分支/准备 worktree/启动工作会话/进入会话)展示后端 dev_launch_progress 阶段进度;纯展示(model 由控制层持有,判定在 lib/dev-launch-view.ts),就绪/失败/安全超时由控制层关闭
│   ├── SpecStartupOverlay/SpecStartupOverlay.vue    # Spec 会话启动遮罩(App 根级):撰写/重置 Spec 点击即阻断,按有序步骤(检查依赖/拉取代码/启动会话)展示粗粒度进度及逐步骤 ✓/spinner/灰点标记;就绪、动作失败或安全超时后收敛关闭
│   ├── ExitPlanModeDisplay/ExitPlanModeDisplay.vue # ExitPlanMode 计划独立渲染块:解析输入负载中的 plan markdown + 结构化元数据(标题/步骤索引),支持 tool-use/tool-result 双态
│   ├── MarkdownText/MarkdownText.vue               # 单条文本消息渲染器:assistant 走 Markdown+DOMPurify 双防线、user/system 纯文本转义、Shiki 代码高亮,宽表格包局部横滚容器
│   ├── MessageInput/MessageInput.vue               # 底部输入区:斜杠命令补全、textarea 自增长、语音输入、图片附件(点击/粘贴/拖拽选图+缩略图预览+逐张删除+超阈压缩,随 submit/enqueue 以 PromptImage 上线)、动作按钮内嵌输入框(附件+语音居内部左下、发送为内部右下向下箭头图标按钮)、待发队列管理,移动端软键盘/安全区避让
│   ├── MobileStack/MobileStack.vue                 # 移动端 drill-down 布局壳:桌面透传多栏,移动端按 pane key 栈式切换、顶部返回、滑入动画
│   ├── PendingQueue/PendingQueue.vue               # 待发送队列显示区:展示运行中缓存的待发消息,支持修改和删除
│   ├── PermissionPrompt/PermissionPrompt.vue       # 单条权限提示块:AskUserQuestion 逐题作答面板或其他工具 allow/deny 提示,展示 agent 共识意见
│   ├── ResetSessionDialog/ResetSessionDialog.vue   # 「重置会话」输入弹框(ConfirmDialog 风格 + 文本输入):用于 intent/spec session 重置,受控 open、标题/正文/占位/按钮文案注入、输入为空时确认禁用、遮罩/Esc/取消均 emit cancel、确认 emit confirm(文本)、移动端全屏 sheet
│   ├── SessionStatusBar/SessionStatusBar.vue       # 输入框上方状态条:展示会话运行态(思考/工具执行/等待授权/出错/就绪),支持刷新、停止、继续
│   ├── SessionTitleBar/SessionTitleBar.vue         # 聊天列顶部标题行:会话标题、权限模式下拉、vendor 标签与 agent 切换器;sourceLabel(intent/discussion/automation/trace)非空时在标题后渲染单一溯源按钮(文案/aria 走 i18n:意图/讨论/自动化/溯源),点击上抛 open-source(无参,目标由控制层 activeSessionSource 决定);null 不渲染;showShare=true 时在溯源按钮后、right-controls 前渲染纯图标「分享」按钮(🔗,data-testid=share-button,aria/tooltip 走 i18n),点击 emit share(默认 false,仅会话页经 ChatColumn 传 true;讨论页改在 action 槽自渲染分享按钮)
│   ├── SkillApprovalModal/SkillApprovalModal.vue   # 外部 skill 加载审批模态:确认向 .gitignore 追加 _c3_* 的一次性确认;移动端全屏 sheet(顶部关闭、内容可滚、安全区适配)
│   ├── TaskPanel/TaskPanel.vue                      # 实时任务面板:只读展示当前 session 任务列表,in_progress 置顶/pending 居中/completed 垫底
│   └── WorkspaceSwitcher/WorkspaceSwitcher.vue     # 顶部栏最左工作区切换器:触发区仅显示当前工作区名称;下拉每行名称下方以小号次级字显示完整绝对路径(仅展示、用于区分同名工作区,身份仍是服务端不透明 workspaceId),面板宽度加倍;支持新增(InputDialog 输入路径)/选择/移除(ConfirmDialog danger 二次确认),内含 popover;增删入口受 isAdmin 门控;「新增」是唯一让绝对路径进入系统作身份的入口
│
├── pages/                                           # 各功能页面(容器页 + 页内子组件)
│   ├── workcenter/                                  # 工作台页
│   │   ├── WorkCenter.vue                           # 工作台容器页:左栏“用户通知消息”标题 + 状态下拉(all/todo/done/canceled/auto,默认 all)/列表 + 详情两栏,切换筛选重置 20 条分页并按最后一行时间游标加载更多,查看纯通知 todo 自动完成;移动端经 MobileStack 退化为 列表→详情 两级 drill-down(点事件行整屏切详情、顶部工具栏返回回列表,返回保留选中高亮/筛选值;mobileActiveKey 显式态,select 置 detail、back/筛选变更置 list,active-token 用事件 id)
│   │   └── components/
│   │       ├── EventList.vue                        # 事件列表:右侧状态徽标(含 auto)和 todo 标记完成、标题(经 event-title 本地化 Git/PR 收尾失败 todo)、会话类型图标、时间、选中态与加载更多
│   │       └── EventDetail.vue                      # 事件详情:标题(经 event-title 本地化)+属性列表(工作区名/会话类型/会话 id/意图名,后两者为空隐藏)、Allow/Deny、AskUserQuestion 全题一览作答面板(自定义回复/共识提示/只读态)、共识决策留痕(auto 记录的投票/裁决,只读)、按 sessionKind+sessionId 溯源跳转
│   ├── works/                                    # 会话页(历史目录名 works)
│   │   ├── Works.vue                             # 会话容器页:桌面左侧聚合会话列表(工作/意图/spec/讨论/automation/工具六 tab + 运行中浮标;工作/意图/spec/讨论/automation 接真实 session_metadata 数据,工具受 showToolSessions 门控) + 右侧聊天列(ChatColumn,show-mode=true 带模式下拉);任意行点击只在右侧展示该会话详情(不跳走),溯源经标题栏 sourceLabel 按钮(open-source)上抛;automation 会话 showInput=false(只读),但状态栏/消息区照走 wire 事件——服务端 dispatcher 把 llm 执行的 SDK 流 fan-out 后,选中运行中的 automation 即见 live 细粒度状态+transcript 实时增长,无需前端轮询;移动端列表↔聊天 drill-down(返回到列表)
│   │   └── components/
│   │       ├── WorkSessionList/WorkSessionList.vue  # 左栏会话列表:当前工作区按 session_kind 分 tab 的聚合会话(work/intent/spec/discussion/automation/tool 可选,tool 受系统开关门控)、行点击=查看此会话(统一上抛 select-session 在右侧展示详情,不再跳走)、非 work 行不提供改名/删除、有 owner 的行仍保留 ↗ 来源跳回按钮(jump-session-source,次要入口)、无 owner 的工具行仅展示、新增工作会话、删除/改名、服务端游标分页(加载更多/已加载完,SR-R14)、运行中计数浮标、未接入类型占位、offline 警告
│   │       └── NewSessionModal/NewSessionModal.vue  # 新建会话弹窗:选择 vendor/agent(Auto 继承默认或指定),host-binary 缺失时灰显并提示检测面板;移动端全屏 sheet(顶部关闭、内容可滚、安全区适配)
│   │
│   ├── intents/                                     # 需求页
│   │   ├── Intents.vue                              # 需求容器页:桌面两栏(左意图列表 + 右栏双态);右栏默认展示选中意图的 IntentDetail(首次默认选首条,聊天列 props/活动会话经其透传给两会话 tab),点左栏标题栏「+」(handleNewIntentSession)切到独立意图会话 ChatColumn(viewingNewIntentSession=true,绑定服务端 session_selected 的活动会话),点任一意图行复位回 IntentDetail;requestedIntentId(标题栏溯源/work 跳转来的一次性外部选中请求)命中已加载意图时改选并 emit requested-intent-consumed 让父清空,目标未出现则保留默认选中;requestedIntentSessionId(独立意图 chat 会话溯源来的一次性请求)置 viewingNewIntentSession=true 翻到独立 ChatColumn(绑定活动会话)并 emit requested-intent-session-consumed 让父清空;prefill 经 defineExpose 按双态路由到 ChatColumn 或 IntentDetail;移动端 MobileStack 二级 drill-down(列表→详情/会话)
│   │   ├── components/
│   │   │   ├── IntentMergedList/IntentMergedList.vue # 意图列表左栏容器:接管 IntentList 头区;可折叠(960px/480px);透传 selectedIntentId 高亮与 select-intent 选中事件;头区右域为自动化按钮+状态过滤(移动端收进 ⋮ 菜单,桌面直显)+「+」新建意图会话按钮(emit new-intent-session,由 Intents.vue 在右栏展示新会话);无分段控件、无意图会话列表(已挪到会话页「意图」tab)
│   │   │   ├── IntentList/IntentList.vue            # 需求列表:接受 hideHeader prop 嵌入合并栏;按状态过滤、终止态分页、自动化编排启停(移动端头区收进 ⋮ 菜单,桌面直显);行点击=选中(emit select-intent,selectedId 高亮并滚动已渲染选中行入视野);行右侧状态区有两个轻量 icon 控件——模式 icon(⏳自动/✋手动,即点即切 emit set-automate(id,!automate))与仅 todo 行可见的 refine 编辑入口(✎,emit refine(id)),均 @click.stop 不误触选中;复用 IntentDetail 既有 set-automate/refine 事件流,不新增后端写入路径
│   │   │   ├── IntentDetail/IntentDetail.vue        # 右栏意图详情面板:常驻单行头部(左 intent title+module+priority+status,右侧四态主按钮+refine/我要修改/open-work/mark-done/cancel/create-pr/pr-link(有 prUrl 时为跳转 PR 的锚点,否则回退复制 prId)/share(🔗 纯图标,data-testid=share-button,emit share(intentId) 由 App 拼意图深链复制)/automate 切换,不显示日期前缀/runStatus chip;mark-done 仅 lastWorkSessionId 存在时显示;create-pr 仅 lastWorkSessionId 存在、prId 为空且 branchName 存在并不同于 workspace 默认主分支时显示;头部「我要修改」在无 lastWorkSessionId 时显示→ResetSessionDialog→emit reset-intent-session)+ 其下五 tab —— intent(正文 markdown+逐行 Git/PR 元信息;正文动作区仅 draft/todo 显示「编辑」入口,点后正文换纯文本 textarea 预填 content+框下方左侧蓝色「保存」/「取消」,保存 emit save-intent-content(id,draft) 透传为 update_intent_content、取消丢弃草稿恢复渲染态,服务端回填(updatedAt 变化)后退出编辑态,切换选中意图丢弃未保存草稿;依赖逐行显示完成态/类型，标题选择详情，单条类型编辑仍整组回写)/intent session(intentSessionId 沟通会话,复用 ChatColumn)/spec(顶部右侧「批准」「编辑」「我要修改」操作区+渲染 specPath 指向 spec.md,经 read-spec 拉取 intentSpecContent;「批准」才 emit approve-spec,并消费 10 秒防误审门;「编辑」仅三门禁全满足时显示——specPath 存在+status=todo 且无 lastWorkSessionId+specSessionRunning 为假(spec 会话未运行,由 Intents 据 sessionStatus 计算),点后正文换纯文本 textarea 预填 intentSpecContent+框下方左侧蓝色「保存」/「取消」,编辑态隐藏批准/我要修改,保存 emit save-spec-content(id,draft) 透传为 update_spec_content、取消丢弃草稿恢复渲染态,服务端广播回填(updatedAt 变化含审批重置)后退出编辑态并重发 read-spec 渲染覆盖后内容、被拒(intentActionErrorSeq 自增)则释放保存守卫但保留编辑框;「我要修改」复用原 spec session 重置可见/禁用逻辑→ResetSessionDialog→emit reset-spec-session)/spec session(specSessionId 写 spec 会话,复用 ChatColumn)/changelog(变更日志:生命周期操作审计倒序列表——操作类型标签+摘要+操作人+时间,切入时经 list-intent-logs 懒加载,空态/加载态文案);其中 spec/spec session 两 tab 仅在 sddEnabled 为真、或当前意图已有历史 spec 数据(specPath 或 specSessionId 非空)时可见,否则只渲染 intent/intent session/changelog 三项,可见性变化令当前激活 tab 隐藏时回退 intent,外部请求切到不可见 specSession 时忽略但仍消费 requested-subtab-consumed;主操作按钮按 SDD 态四态(sddEnabled×specPath×specApproved):关→start-dev(开始工作),开无spec→write-spec,有spec未批准→只切换打开 spec tab,已批准→start-dev(开始工作,含 start-dev in-flight 守卫);两会话 tab 沿用单一活动会话模型——会话 tab 激活且对应 sessionId 已存在但 activeSession 未对齐时 emit open-intent-session/open-spec-session(包括切 tab 后的异步 sessionId 回填),activeSession 与期望 id 对齐(chatReady)才渲染聊天列防串台;会话 tab 内不再显示重置按钮;选中意图切换复位到 intent tab;无选中(列表空)时空态
│   │
│   ├── discussions/                                 # 讨论页
│   │   ├── Discussions.vue                          # 讨论容器页:桌面两栏(左纯列表 + 右栏「常驻标题栏 + Tab 面板」);标题栏(讨论标题 + Start/Pause/Resume/Convert 动作 + 运行状态)跨 tab 不变,其下 Tab 栏切互斥内容区——目标/上下文/研究/结论(markdown 字段,空则不渲染)/过程(research 研究流或 discussion 议程+讨论流+dispatch+composer,逻辑整体归位此 tab)/详情(类型/状态/创建/完成时间);过程+详情恒存在,默认 tab 按 conclusion→process→research→goal 取首个可见,切换讨论复位默认、字段实时变化经 correctActiveTab 回落;tab 态为页面内部状态不写回协议;移动端 MobileStack 两级 drill-down(列表→右栏 tab 化详情,返回回列表);透传 agents/defaultAgentId 给列表的创建弹窗;标题栏 action 槽在状态标签旁渲染纯图标「分享」按钮(🔗,data-testid=share-button),点击 emit share 由 App 拼讨论深链复制
│   │   └── components/
│   │       ├── DiscussionList/DiscussionList.vue    # 左栏纯讨论列表:列表、可折叠宽度、行状态指示、创建弹窗(类型/目标/上下文 + 参与 agent 多选 + radio 选组织者,默认全选)、提交校验(必须选组织者+至少一个其他 agent);行点击/Enter/Space 只 emit open(id) 作纯选中(详情已移右栏,无行内抽屉);移动端列表填满 pane、弹窗全屏 sheet
│   │       └── AgendaProgress/AgendaProgress.vue    # 讨论议程进度:展示议程、当前进展、完成度百分比;窄屏收紧横向 padding
│   │
│   ├── automations/                                   # 自动化页
│   │   ├── Automations.vue                            # 自动化容器页:桌面两栏(左栏纯选择列表 + 右栏 AutomationDetailPanel)+ 创建/编辑表单弹窗;移动端经 MobileStack 退化为两级 drill-down(任务列表→详情逐级滑入/返回)
│   │   └── components/
│   │       ├── AutomationList/AutomationList.vue        # 左栏任务选择列表:行点击 = 选中(emit select,activeId 高亮)、创建(+)、模板菜单(选择后直接创建)、下次执行倒计时(30s 刷新)、状态 badge;run/edit/delete/toggle 操作已迁出至右栏标题栏
│   │       ├── AutomationDetailPanel/AutomationDetailPanel.vue  # 右栏容器:常驻标题栏(选中 automation 名称 + run-now/delete(ConfirmDialog 二次确认)/enable-disable 开关,不提供编辑入口)+「详情/历史」Tab;详情 Tab 渲染 AutomationDetail,历史 Tab 经 ExecutionHistoryDialog 选执行后渲染 ExecutionDetail;切换选中 automation 复位到详情 Tab
│   │       ├── AutomationDetail/AutomationDetail.vue    # 详情 Tab 内容:vendor 品牌名+色点、绑定 agent、类型、命令/提示词、超时、模式、触发方式及事件筛选(run-lifecycle 含 sessionKind 多选/metadata 条件展示)、metadata 标注、只读 cron 排期、可自动换行的工具列表;event 类型附「模拟触发」面板(选事件类型+填测试字段→emit simulate,展示命中与逐项 breakdown)
│   │       ├── AutomationDetail/AutomationCronEditor.vue  # 「修改时间」cron 编辑弹框(由 AutomationForm 编辑态 ✎ 打开):频率(每分/每时/每日/每周)+时间;每周时展示周一到周日多选切换(至少选 1 个否则禁用保存+提示),day-of-week 1-5 压缩/逗号拼接;实时表达式预览;仅 emit save(标准 5 字段 cron)
│   │       ├── ExecutionHistoryDialog/ExecutionHistoryDialog.vue  # 历史选择弹框:在选中 automation 完整日志上做纯前端分页(默认最近 5 笔/页,上一页/下一页),点选一笔上抛 select-execution 并关闭;移动端全屏 sheet;状态 badge/时间/耗时/退出码行渲染
│   │       ├── ExecutionDetail/ExecutionDetail.vue  # 历史 Tab 内执行详情:「执行信息」Tab + 「Session 会话记录」Tab(llm 类型) + 「Command 日志」Tab(command 类型);Tab 栏窄屏可横向滑动;运行中执行的 transcript 随控制层轮询覆盖更新(不闪 loading)
│   │       ├── AutomationForm/AutomationForm.vue        # 创建/编辑任务表单(弹窗):cron 或事件触发(run:started/run:settled/pr:operation/intent:lifecycle)、高级 cron 构造器、实时 next-run 预览;run:settled 显示 reason 过滤,run-lifecycle 显示 sessionKind 多选(无默认勾选,未选禁止保存)+metadata 条件构建器(增删行+AND/OR),pr:operation 显示 MCP 集成说明+操作/结果过滤面板;通用 metadata 标注编辑器(增删 key/value);编辑态可改标题(清空回退自动命名),创建态自动命名;vendor 下拉(host 缺失灰显)+工具勾选面板(读写分区,读默认勾,全选/全清按钮);创建态用系统 automationAgentId 预填 vendor+agent(跟随链 automationAgentId→defaultAgentId→首个启用),编辑态保留记录自身 vendor/agentId;移动端全屏 sheet 且紧凑表单单列堆叠
│   │       └── AutomationForm/resolveAutomationDefaultAgent.ts  # 纯函数:输入 agents+automationAgentId+defaultAgentId,按跟随链解析出创建表单默认预选的 AgentConfig(无启用 agent 返回 undefined 交调用方系统兜底);仅表单一次性取值,不接入运行时 resolveAgent
│   │
│   ├── codes/                                       # 代码浏览页
│   │   ├── Codes.vue                                # 代码浏览容器页:桌面三栏(左 CodeTree + 中 CodeTabs + 右 内嵌 ChatColumn 按需显示);右栏默认关闭,由 CodeTree 标题栏「修改会话」开关按钮控制显隐,状态经 usePersistentToggle('c3.codesChatVisible') 跨刷新持久化,关闭仅隐藏容器(会话绑定 codesBoundSessionId 等不清空,再开直接复用);中右之间一根可拖拽垂直分隔条 .codes-col-splitter(role=separator,鼠标拖拽/←→±16/Home最小/End默认,宽度像素按 workspace 持久化到 localStorage);右栏复用 ChatColumn(show-share=false、always-title、show-mode=chatActive 即绑定会话真正激活时才在标题栏显示权限模式下拉(claude 单模式 / codex 双策略),经 set-mode/set-codex-policy 上抛、title-action 槽渲染「+ 新建」/「↻ 重置」互斥按钮,由 codesBoundSessionId 是否为空切换)展示当前 workspace 的普通 work session,与 Works 共用控制层单一活动会话(codesBoundSessionId 为 Codes 独立指针;activeSession 变化时即时绑定内存指针——含新建回执的 pending id,否则 chatActive 不成立、输入框禁用致新建会话死锁——但只对真实 id 按 c3.codes.<ws>.sessionId 持久化);移动端经 MobileStack 退化为 树→文件 两级 drill-down(不渲染 ChatColumn);仅持有/透传 workspace 相对路径,越界判断全在服务端 guard
│   │   └── components/
│   │       ├── CodeTree/CodeTree.vue                # 左栏:顶部 Files 标题 + 左侧 ⇤/⇥ 展开切换(展开后宽度 560px,localStorage 持久化)+ 右侧刷新按钮(↻ SVG,emit refresh-tree→重拉根目录+所有已展开目录)+「修改会话」开关按钮(showChat prop 驱动空心/实心消息气泡 SVG 图标,点击 emit toggle-chat 由 Codes.vue 翻转右栏显隐)+ 搜索框(filename/content 切换 + 文件模式 glob 过滤框 *.ts,默认 * 全部,Enter/防抖触发 search_codes)+ 懒加载文件树/搜索结果(点结果打开文件,content 命中带行号定位)
│   │       ├── CodeTree/CodeTreeNode.vue            # 文件树单节点(递归):目录点击展开/折叠(懒加载 list_dir),文件点击打开 tab,激活态高亮;文件/目录右键菜单可复制名称或 workspace 相对路径并通过全局 toast 反馈
│   │       ├── CodeTabs/CodeTabs.vue                # 右栏多 tab 容器:tab 条(可手动关闭,关闭后聚焦相邻)+ 渲染激活 tab 内容,空态;持有各 tab 的 Markdown 视图模式(原文/预览)内存 Map,按 path 记忆并透传给 CodeFileView,关闭/移除时清理该 path
│   │       └── CodeFileView/CodeFileView.vue        # 单文件内容渲染:复用 Shiki 高亮管线(后缀推断语言,白名单外/二进制/超限降级)+ 行号 gutter 逐行对齐 + 搜索命中滚动并高亮目标行;.md 文件在 meta 栏右侧显示「原文/预览」两态开关(受控 viewMode prop),预览态复用 MarkdownText 只读渲染 file.content
│   │
│   ├── login/                                       # 登录页
│   │   └── Login.vue                                # 全屏登录门(ADR-0023):账号+密码表单,提交走 WS login 消息,pending/错误码经 useAuth 回流
│   │
│   ├── workspacesetting/                         # 工作区配置页
│   │   └── WorkspaceSetting.vue                  # 工作区级配置编辑(弹窗):per-vendor 默认模式、讨论轮数上限、演讲字符限制、git 分支模式(current-branch/worktree)+默认主分支(打开时服务端探测预填);sandbox 区块紧随分支策略且仅 worktree 模式显示(切回 current-branch 隐藏并在 save 出参丢弃 sandbox),启用后含 custom agent 多选面板(只列 enabled+configMode==='custom',写入 agentIds,无可选时空态)、external skill repos 等 workspace 级配置;移动端全屏 sheet 安全区适配且紧凑表单单列堆叠
│   │
│   └── systemsettings/                              # 系统设置页
│       ├── SystemSettings.vue                       # 系统设置容器(弹窗):封装 SettingsPanel
│       └── components/SettingsPanel/
│           ├── SettingsPanel.vue                    # 系统设置面板(弹窗):配置按 Agent/Runtime/Security/General 四 Tab 分组,桌面可见 Tab 导航、移动端横向滚动;每 Tab 独立草稿(单一 draft 按 TAB_FIELDS 白名单切片,与「已提交基线」committed 深比较得脏状态,非全局 dirty)、独立保存按钮与未保存标识,保存后面板保持打开;字段归属:Agent=agents+defaultAgentId+tool/intent/spec/automationAgentId,Runtime=host 诊断(只读)+vendorCliVersions+sandboxes+proxy,Security=auth(provider/暴露/TTL),General=uiLang+voiceLang+timezone+baseUrl+showToolSessions。保存某 Tab 时仅用其白名单字段(经该 Tab 转换:Agent 回写 order_seq、Runtime 同步 proxy 表单+丢弃空名沙箱、Security 派生 auth.enabled)覆盖 committed 深拷贝构造完整 SystemSettings 发 save_settings,不携带其他 Tab 草稿;协议/服务端/磁盘不变。面板打开期间设置回推按字段归属合并(reconcile):首次打开整体播种,之后仅刚保存 Tab 与干净 Tab 重播种,脏 Tab 保留草稿、只同步即时持久化字段(uiLang、账号列表/管理员);切换脏 Tab 时 ConfirmDialog 二次确认,确认后仅切换不保存不丢弃草稿,返回可继续编辑。配置块本身不变:agent 列表(原生 HTML5 DnD 拖拽手柄重排,AC-R20)/默认 agent(列表下方单一下拉,选项=启用 agent 按 order_seq;禁用/移除当前默认时即时 resolveDefaultAgentId 顺延,全禁用→system,AC-R2)/工具·意图·spec·automation agent(「跟随默认」空项+启用 agent;非空时同默认顺延,AC-R21/R23/R24/R25)、host 诊断、vendor CLI 多版本面板(只读展示生效版/下载目标/最近检查/错误,已安装版单选写 vendorCliVersions;空=自动最新;未安装/failed 不可选)、UI 语言切换(即时应用+持久化,不使 General 变脏)、voice 语言、emoji picker、认证(ADR-0023:provider 两态下拉 无需认证/basic;选 none⇒kind:'none'+enabled:false 隐藏表单,选 basic⇒账号列表编辑器,增删改/设管理员各走 set-password/remove-account/set-admin-account emit→专用消息即时持久化,配好管理员后 enabled 派生 true;未配管理员时暴露开关置灰);非管理员(useAuth.isAdmin←ready.isAdmin)只读:顶部只读提示横幅+四个保存与账号管理控件禁用(服务端 AUTH-R10 仍强制);移动端全屏 sheet 安全区适配且紧凑表单单列堆叠
│           ├── EmojiPicker.vue                      # emoji 选择器:零依赖,支持搜索、分类导航、自定义输入(最长 16 字符)
│           └── emoji-data.ts                        # emoji 数据集:分类 emoji 列表与搜索关键词
│
├── composables/                                     # 可复用组合式逻辑
│   ├── useAuth.ts                                    # 认证状态 reactive 单例(ADR-0023):status(unknown/authenticated/login-required)、submitLogin/logout、login_result/unauthenticated 回流、token 持久化,纯响应服务端;isAdmin(←ready.isAdmin,默认 true)驱动 SettingsPanel 只读门(AUTH-R10)
│   ├── useBreakpoint.ts                              # 响应式媒体查询断点:提供 useBreakpoint/useIsMobile,统一移动端判断与 matchMedia 变更监听
│   ├── usePersistentToggle.ts                       # localStorage 绑定的布尔 ref:记住列表面板收缩/展开态,跨刷新保留
│   └── useSpeechRecognition.ts                      # Web Speech API 轻封装:浏览器语音转文字,持续聆听、自动重启、final/interim 回调
│
├── lib/                                             # 纯逻辑工具模块(无 DOM/框架依赖优先)
│   ├── agent-prefix.ts                              # 客户端推断当前 session 运行的 agent 展示名:本地复刻服务端降级链
│   ├── authToken.ts                                 # 会话 token 持久化(localStorage,guard 无 DOM 环境):get/set/clear,供 ws.ts 握手 ?token= 复用
│   ├── ask.ts                                       # AskUserQuestion 辅助:提取问题列表、共识意见、选项/自定义答案聚合
│   ├── chat-types.ts                                # 聊天消息数据模型:ChatBody/ChatMsg/PermissionMsg/RunActivity/Block 类型(含 standalone 块)、多说话人 SpeakerView
│   ├── codes-view.ts                                # Codes 页纯逻辑/类型:CodeTab/搜索结果视图、关闭 tab 后聚焦相邻(closeTab)、后缀→Shiki 语言推断(langFromPath)、basename、字节人类可读化、CodeViewMode(原文/预览)+ isMarkdownPath(.md 判定)
│   ├── chat-scroll.ts                               # 聊天滚动纯逻辑:底部贴近阈值判定 + 消息变化签名,供 ChatMessages 决定是否跟随新输出
│   ├── current-workspace.ts                         # 「当前工作区」解析:优先持久化选择,否则回落到最近访问工作区
│   ├── datetime-formats.ts                          # 日期/数字格式化预设:为 vue-i18n 与纯展示 lib 提供单一数据源
│   ├── dev-launch-view.ts                           # 工作启动遮罩纯状态机(历史文件名沿用 dev-launch):最小停留/安全超时常量 + stage→有序步骤映射(stepStatusesForPhase)+ reduceDevLaunch(stage/ready/dwell-complete/timeout 终态收敛),无 DOM/计时器,供 DevStartupOverlay 与控制层
│   ├── work-session-jump.ts                         # Start Work 成功后自动跳转纯决策:shouldJumpAfterDevLaunch(仅 ready 跳)+ resolveJumpTargetSessionId(intent.lastWorkSessionId 反查)+ resolvePendingWorkSessionSelect(一次性待选会话落入列表即命中)+ ~1s 延迟常量;控制层据此切 console tab 并选中新 work session
│   ├── discussion-view.ts                           # 讨论只读历史纯映射器:DiscussionMessage 正规化为 ChatBody,处理多说话人 icon/name/vendor
│   ├── execution-view.ts                            # 执行 transcript 纯映射器:TranscriptItem 正规化为 ChatBody/ChatMsg,供 Session Tab 的 ChatMessages 渲染
│   ├── automation-refresh.ts                           # 运行中执行实时刷新的纯决策:isExecutionRunning 推断 + decideAutomationRefresh(running/tab/可见/上次running → shouldPoll/finalFetch) + 轮询间隔常量
│   ├── format.ts                                    # 简单值格式化:JSON 美化打印、多行折叠为单行
│   ├── highlight.ts                                 # Shiki 按需代码高亮:白名单语言、语言别名、哨兵色转 CSS class、DOMPurify 过滤
│   ├── intent-list-view.ts                          # 需求列表纯展示逻辑:状态/运行态标签、面板展开规则、行内字段可见性、日期格式化
│   ├── event-title.ts                               # 工作台事件显示标题:Git/PR 收尾失败 todo(toolName=GIT_CLEANUP_EVENT_TOOL)经 toolInput 的 UiError 本地化,其余回退 title/toolName
│   ├── pending-queue.ts                             # 待发送队列纯逻辑:追加/移除、flush 判断、Send 行为(入队或发送)、草稿合并
│   ├── permission.ts                                # 权限决策动作性判定:找出用户当前唯一能作用的权限请求
│   ├── prompt-image.ts                              # 输入框附图客户端处理:File→PromptImage(校验图片类型/超阈 canvas 等比压缩/base64 预览);纯函数(base64Bytes/splitDataUrl/shouldCompress/scaledSize/toWire/fromWire)可 Node 单测,readImageFiles 走 DOM
│   ├── session-page.ts                              # 会话列表游标分页(SR-R14)纯归并:按 page.kind(first 替换/older 追加去重/window 刷新已展示范围/live upsert)折叠分页响应进每工作区窗口 + SESSION_PAGE_SIZE
│   ├── session-jump.ts                              # 会话跳回规则纯函数:(sessionKind, ownerKind, ownerId)→意图/讨论/自动化逻辑页目标;spec+intent owner 跳到意图 spec session tab,tool+owner 跳到来源业务,owner 为空返回 null,供会话页与 WorkCenter 共用
│   ├── session-title-sync.ts                        # 会话列表刷新到右侧活动标题的同步规则:仅同 workspace 且同 session 时采用列表标题
│   ├── share-link.ts                                # 分享文本生成纯函数 buildShareText({kind,workspaceId,id,title,typeLabel,baseUrl}):baseUrl trim+去尾斜杠后空则返回 null(走未配置分支),否则拼「[typeLabel] title\n<baseUrl>/#/<kind>/<workspaceId>/<id>」,URL 与 deep-link.ts 的 parseDeepLink 单向对齐(只生成不解析)
│   ├── status-indicator.ts                          # 运行/讨论状态指示器单一数据源:状态→icon+tone+i18n key 映射,支持 agent 前缀
│   ├── tab-view.ts                                  # 标签页/工作区切换效果纯推断:ConsoleTab 进入目标、工作区切换副作用
│   ├── task-list.ts                                 # work session 任务列表客户端入口:re-export 共享任务模型 + taskPanelView 纯展示视图
│   ├── textarea.ts                                  # 自增长 textarea 的 DOM-free 几何计算:由 scrollHeight 与上限算高度与滚动条显隐
│   ├── vendor.ts                                    # Vendor 品牌标签与配色常量:VENDOR_LABEL、VENDOR_COLOR
│   └── ws.ts                                        # WebSocket 客户端:自动重连、heartbeat+pong 检测、消息监听、状态回调;每次(重)连接按 getToken 注入握手 ?token=(ADR-0023)
│
└── i18n/                                            # 国际化
    ├── index.ts                                     # vue-i18n 初始化:en/zh/ja/ko/ru 多语言、日期/数字格式预设、LocaleKey 拼错检测、locale 元数据剥除
    ├── errors.ts                                    # 服务端 UiError 本地化翻译:code→key 映射,与 en.json 保持同步
    └── format.ts                                    # i18n 格式化辅助:基于当前 locale 的日期/数字格式化 d()/n() 封装
```
