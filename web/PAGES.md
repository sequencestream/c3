# Web 页面与组件清单

c3 前端（Vue 3）所有页面、组件、composable 与工具模块的树状索引，每行一句功能说明。源码位于 `web/src/`。

```
web/src/
├── App.vue                                          # 应用入口壳(瘦):导入页面/模态组件,解构 useAppController() 的共享 ctx 绑定到模板(登录门 + 顶栏 + 各视图 + 模态 + 全局 toast + intent 动作错误弹框);全部控制逻辑下沉到 controls/
├── main.ts                                          # 应用入口:创建 Vue 实例、安装 i18n、挂载 App
│
├── controls/                                        # App 控制器:拆分自原 App.vue 的状态 + 消息路由 + 各域动作,经共享 ctx 对象晚绑定串联
│   ├── index.ts                                     # useAppController():建 state、装 runtime(client/send/reconnect/t/auth)、依次 install 各域、管理 WebSocket 生命周期(onMounted 建连/心跳/可见性/onReopen 重选),返回 ctx 供 App.vue 解构
│   ├── state.ts                                     # createState():全部 ref/computed + 纯状态辅助(statusOf/add/setQueue/showToast/sessionTitleById/clearSideEffectPending)、计数器、localStorage 键常量;导出 AppState 类型
│   ├── types.ts                                     # ctx 类型契约:AppRuntime(client/send/reconnect/t/auth)+ AppMethods(全部域方法签名),AppCtx = AppState & AppRuntime & AppMethods
│   ├── transcript.ts                               # transcriptToChat():TranscriptItem→ChatBody 纯映射(会话历史回放)
│   ├── persistence.ts                              # 视图恢复持久化:readStoredWorkspace/persistCurrentWorkspace/persistViewMode + ready 后 maybeRestore 需求/讨论/定时任务
│   ├── message-handler.ts                          # installMessageHandler():唯一入站 WS switch(handleMessage)折叠所有 ServerToClient 事件 + applyStatuses/notifyAwaitingPermission
│   ├── session-actions.ts                          # 工作区/会话/顶栏 tab 导航:按 session_kind 缓存的游标分页刷新(窗口/首页)/加载更多/选择会话、spec 行按 owner 跳回意图 spec session tab(含旧 specSessionId 兜底)、tool 行按 owner 跳回来源业务、六类会话计数、新建工作会话弹窗、乐观删除改名、会话 tab 进入与重绑、清空视图会话
│   ├── intent-actions.ts                           # 需求页动作:筛选/精炼/写spec/批准spec/开发/PR/状态/自动化 + 沟通 session 列表(新建/选择/重命名/删除)
│   ├── discussion-actions.ts                       # 讨论页动作(只读路径 + 组织者引擎):打开/创建/开始/暂停/恢复/转需求/发言/移动返回
│   ├── schedule-actions.ts                         # 定时任务页动作:打开/选择/执行记录/会话回放 + 创建编辑表单(含 toolManifest 缓存 watch);选中且运行中的 llm 执行按周期自动刷新 detail+transcript(可见性闸/页内才刷),结束补拉一次后停止
│   ├── chat-actions.ts                             # 聊天/输入动作 + 客户端待发队列(enqueue/edit/delete/flush watch)、提交/继续/停止/刷新/模式/agent 切换/权限响应
│   ├── settings-actions.ts                         # 系统/工作区设置、技能安装、运行时语言切换(回滚)、workspace↔workcenter 视图模式、技能加载审批
│   ├── license-actions.ts                          # 产品许可(ADR-0026):打开 LS 登录页取 license_key(start_license_activation)、用 key 绑定本安装(bind_license),状态由 license_state/license_activation_started/license_bind_result 回流
│   └── workcenter-actions.ts                       # 工作台事件动作:权限响应/作答 + reloadWorkcenter/loadMoreWorkcenter(20 条服务端分页,支持全部状态) + markDoneWorkcenter(本地改为 done) + 用标准 session 跳回规则跳转到来源页(会话/需求/讨论/定时任务)
│
├── components/                                      # 跨页面通用组件
│   ├── AppHeader/AppHeader.vue                      # 应用导航壳:桌面顶部栏(整行最左为 viewMode 工作区/工作台两图标切换器(显示器+三横条 / 显示器+会话气泡,生效蓝 --c-primary、失效灰,工作台未处理事件徽标挂工作台图标),其后工作区切换器、tab 导航、项目配置/系统设置/登出/连接状态 + 许可状态下拉(ADR-0026,PL-R7,受控 details:已激活→✓ 图标按 state 着色,下拉显示有效期(termEnd 未知时回退状态文案)+ 有效期旁手动刷新按钮(触发即时 heartbeat 同步 termEnd,在途禁用旋转+最小冷却防连点,失败 inline 提示);未激活/过期/停用→红色带下划线文字,下拉内「激活许可」按钮触发激活流程)),移动端顶部精简栏左侧同款两图标切换器(许可项并入「⋯」操作菜单)+ 底部 5 视图 tab(会话/需求/讨论/定时任务/代码;工作台入口已上移到顶部切换器,不在底部 tab)
│   ├── BaseDropdown/BaseDropdown.vue                # 标准下拉框:替代原生 select,支持键盘导航、多选高亮、点击外部关闭
│   ├── ChatColumn/ChatColumn.vue                   # 复用聊天列:五区块(标题栏/消息/输入框/状态栏/task 面板)按 showTitleBar/showMessages/showInput/showStatusBar/showTaskPanel props 可显隐,供会话页/意图会话 tab/意图详情两会话 tab 三处复用;不持有会话状态(绑定哪个会话由控制层单一活动会话决定);show-mode 控模式下拉、always-title 控无会话时是否仍渲染标题栏;linkedIntentId 透传给标题栏「Intent」跳转按钮(仅会话页传,意图侧复用不传)、open-intent 上抛;prefill 经 defineExpose 透传
│   ├── ChatMessages/ChatMessages.vue               # 会话消息渲染区:扁平消息分组为文本/工具批次/独立块(用户交互工具)、仅用户停在底部时自动跟随新输出、渲染权限提示与共识结果,代码/工具输出局部横滚防窄屏撑破
│   ├── ConfirmDialog/ConfirmDialog.vue             # 通用二次确认模态框(项目内删除/危险操作统一走此组件,不用 window.confirm):受控 open,标题/正文/按钮文案注入,danger 确认色,点遮罩/Esc/取消均 emit cancel,移动端全屏 sheet
│   ├── ErrorDialog/ErrorDialog.vue                 # 持久错误告知弹框:受控 open,单一关闭按钮,点遮罩/Esc/关闭均 emit close,移动端全屏 sheet
│   ├── InputDialog/InputDialog.vue                 # 通用单行文本输入弹框(ConfirmDialog 风格 + 单行 input,替换 window.prompt):受控 open、标题/占位/按钮文案注入、打开聚焦并清空、输入为空时确认禁用、Enter 提交、遮罩/Esc/取消均 emit cancel、确认 emit confirm(trim 文本)、移动端全屏 sheet
│   ├── ConsensusBlock/ConsensusBlock.vue           # 多 agent 共识自动裁定结果块(只读):AskUserQuestion 逐题自动作答、其他工具 allow/deny 裁定
│   ├── DevStartupOverlay/DevStartupOverlay.vue     # 开发启动进度遮罩(App 根级,与全局 toast 同层):手动 Start Dev 点击即全屏阻断,以最小停留防止快速启动闪烁,按有序步骤(拉取远程主分支/准备 worktree/启动会话/进入会话)展示后端 dev_launch_progress 阶段进度;纯展示(model 由控制层持有,判定在 lib/dev-launch-view.ts),就绪/失败/安全超时由控制层关闭
│   ├── SpecStartupOverlay/SpecStartupOverlay.vue    # Spec 会话启动遮罩(App 根级):撰写/重置 Spec 点击即阻断,按有序步骤(检查依赖/拉取代码/启动会话)展示粗粒度进度及逐步骤 ✓/spinner/灰点标记;就绪、动作失败或安全超时后收敛关闭
│   ├── ExitPlanModeDisplay/ExitPlanModeDisplay.vue # ExitPlanMode 计划独立渲染块:解析输入负载中的 plan markdown + 结构化元数据(标题/步骤索引),支持 tool-use/tool-result 双态
│   ├── MarkdownText/MarkdownText.vue               # 单条文本消息渲染器:assistant 走 Markdown+DOMPurify 双防线、user/system 纯文本转义、Shiki 代码高亮,宽表格包局部横滚容器
│   ├── MessageInput/MessageInput.vue               # 底部输入区:斜杠命令补全、textarea 自增长、语音输入、图片附件(点击/粘贴/拖拽选图+缩略图预览+逐张删除+超阈压缩,随 submit/enqueue 以 PromptImage 上线)、动作按钮内嵌输入框(附件+语音居内部左下、发送为内部右下向下箭头图标按钮)、待发队列管理,移动端软键盘/安全区避让
│   ├── MobileStack/MobileStack.vue                 # 移动端 drill-down 布局壳:桌面透传多栏,移动端按 pane key 栈式切换、顶部返回、滑入动画
│   ├── PendingQueue/PendingQueue.vue               # 待发送队列显示区:展示运行中缓存的待发消息,支持修改和删除
│   ├── PermissionPrompt/PermissionPrompt.vue       # 单条权限提示块:AskUserQuestion 逐题作答面板或其他工具 allow/deny 提示,展示 agent 共识意见
│   ├── ResetSessionDialog/ResetSessionDialog.vue   # 「重置会话」输入弹框(ConfirmDialog 风格 + 文本输入):用于 intent/spec session 重置,受控 open、标题/正文/占位/按钮文案注入、输入为空时确认禁用、遮罩/Esc/取消均 emit cancel、确认 emit confirm(文本)、移动端全屏 sheet
│   ├── SessionStatusBar/SessionStatusBar.vue       # 输入框上方状态条:展示会话运行态(思考/工具执行/等待授权/出错/就绪),支持刷新、停止、继续
│   ├── SessionTitleBar/SessionTitleBar.vue         # 聊天列顶部标题行:会话标题、权限模式下拉、vendor 标签与 agent 切换器;有 linkedIntentId(由意图创建的 work session)时在标题后渲染「Intent」按钮,点击 emit open-intent(intentId) 跳转关联意图
│   ├── SkillApprovalModal/SkillApprovalModal.vue   # 外部 skill 加载审批模态:确认向 .gitignore 追加 _c3_* 的一次性确认;移动端全屏 sheet(顶部关闭、内容可滚、安全区适配)
│   ├── TaskPanel/TaskPanel.vue                      # 实时任务面板:只读展示当前 session 任务列表,in_progress 置顶/pending 居中/completed 垫底
│   └── WorkspaceSwitcher/WorkspaceSwitcher.vue     # 顶部栏最左工作区切换器:显示当前工作区(仅名称;身份是服务端不透明 workspaceId,前端不持有/不展示绝对路径),支持新增(InputDialog 输入路径)/选择/移除(ConfirmDialog danger 二次确认),内含 popover;增删入口受 isAdmin 门控;「新增」是唯一让绝对路径进入系统的入口
│
├── pages/                                           # 各功能页面(容器页 + 页内子组件)
│   ├── workcenter/                                  # 工作台页
│   │   ├── WorkCenter.vue                           # 工作台容器页:左栏“用户通知消息”标题 + 状态下拉(all/todo/done/canceled/auto,默认 all)/列表 + 详情两栏,切换筛选重置 20 条分页并按最后一行时间游标加载更多,查看纯通知 todo 自动完成,移动端单列流式
│   │   └── components/
│   │       ├── EventList.vue                        # 事件列表:右侧状态徽标(含 auto)和 todo 标记完成、标题(经 event-title 本地化 Git/PR 收尾失败 todo)、会话类型图标、时间、选中态与加载更多
│   │       └── EventDetail.vue                      # 事件详情:标题(经 event-title 本地化)+属性列表(工作区名/会话类型/会话 id/意图名,后两者为空隐藏)、Allow/Deny、AskUserQuestion 全题一览作答面板(自定义回复/共识提示/只读态)、共识决策留痕(auto 记录的投票/裁决,只读)、按 sessionKind+sessionId 溯源跳转
│   ├── works/                                    # 会话页(历史目录名 works)
│   │   ├── Works.vue                             # 会话容器页:桌面左侧聚合会话列表(工作/意图/spec/讨论/schedule/工具六 tab + 运行中浮标;工作/意图/spec/工具接真实 session_metadata 数据,工具 tab 受 showToolSessions 门控,讨论/schedule 占位置灰) + 右侧聊天列(ChatColumn,show-mode=true 带模式下拉);linkedIntentId/owner 元数据经标准跳回规则跳转对应逻辑页;移动端列表↔聊天 drill-down(返回到列表)
│   │   └── components/
│   │       ├── WorkSessionList/WorkSessionList.vue  # 左栏会话列表:当前工作区按 session_kind 分 tab 的聚合会话(work/intent/spec/tool 可选,tool 受系统开关门控)、有 owner 的行显示来源跳回按钮、无 owner 的工具行仅展示、新增工作会话、删除/改名、服务端游标分页(加载更多/已加载完,SR-R14)、运行中计数浮标、未接入类型占位、offline 警告
│   │       └── NewSessionModal/NewSessionModal.vue  # 新建会话弹窗:选择 vendor/agent(Auto 继承默认或指定),host-binary 缺失时灰显并提示检测面板;移动端全屏 sheet(顶部关闭、内容可滚、安全区适配)
│   │
│   ├── intents/                                     # 需求页
│   │   ├── Intents.vue                              # 需求容器页:桌面两栏(左合并列表 + 右上下文详情列);右栏按合并列 activeTab 切换 —— intents tab→IntentDetail(selectedIntentId 意图详情,首次默认选首条,聊天列 props/活动会话经其透传给两会话 tab),sessions tab→ChatColumn 聊天列;requestedIntentId(work session 标题栏跳转来的一次性外部选中请求)命中已加载意图时改选并 emit requested-intent-consumed 让父清空,目标未出现则保留默认选中;prefill 按 activeTab 路由到 IntentDetail 或 sessions 聊天列;移动端 MobileStack 二级 drill-down(列表→右栏:intents tab drill 详情/sessions tab drill 聊天)
│   │   ├── components/
│   │   │   ├── IntentMergedList/IntentMergedList.vue # 合并左栏:带分段控件(Intents/Sessions)切换,接管两子组件的头区;可折叠(960px/480px);透传 selectedIntentId 高亮与 select-intent 选中事件;两 tab 标题栏右域各有一个「新建会话」入口(复用同一 new-intent-session 动作与 intent.sessionList.new.tooltip 文案)——Intents tab 的入口位于自动化按钮+状态过滤之后最右侧,点击即切到 Sessions tab(右栏随 activeTab 打开聊天列)并触发新建,Sessions tab 沿用原「+」入口;移动端把自动化按钮+状态过滤收进 ⋮ 菜单,+ 入口保持常显
│   │   │   ├── IntentList/IntentList.vue            # 需求列表:接受 hideHeader prop 嵌入合并栏;按状态过滤、终止态分页、自动化编排启停(移动端头区收进 ⋮ 菜单,桌面直显);行点击=选中(emit select-intent,selectedId 高亮并滚动已渲染选中行入视野);行右侧状态区有两个轻量 icon 控件——模式 icon(⏳自动/✋手动,即点即切 emit set-automate(id,!automate))与仅 todo 行可见的 refine 编辑入口(✎,emit refine(id)),均 @click.stop 不误触选中;复用 IntentDetail 既有 set-automate/refine 事件流,不新增后端写入路径
│   │   │   ├── IntentDetail/IntentDetail.vue        # 右栏意图详情面板:常驻单行头部(左 intent title+module+priority+status,右侧四态主按钮+refine/我要修改/open-dev/mark-done/cancel/create-pr/pr-link(有 prUrl 时为跳转 PR 的锚点,否则回退复制 prId)/automate 切换,不显示日期前缀/runStatus chip;mark-done 仅 lastDevSessionId 存在时显示;create-pr 仅 lastDevSessionId 存在、prId 为空且 branchName 存在并不同于 workspace 默认主分支时显示;头部「我要修改」在无 lastDevSessionId 时显示→ResetSessionDialog→emit reset-intent-session)+ 其下四 tab —— intent(正文 markdown+逐行 Git/PR 元信息;依赖逐行显示完成态/类型，标题选择详情，单条类型编辑仍整组回写)/intent session(intentSessionId 沟通会话,复用 ChatColumn)/spec(顶部右侧「批准」「我要修改」操作区+渲染 specPath 指向 spec.md,经 read-spec 拉取 intentSpecContent;「批准」才 emit approve-spec,并消费 10 秒防误审门;「我要修改」复用原 spec session 重置可见/禁用逻辑→ResetSessionDialog→emit reset-spec-session)/spec session(specSessionId 写 spec 会话,复用 ChatColumn);主操作按钮按 SDD 态四态(sddEnabled×specPath×specApproved):关→start-dev,开无spec→write-spec,有spec未批准→只切换打开 spec tab,已批准→start-dev(含 start-dev in-flight 守卫);两会话 tab 沿用单一活动会话模型——会话 tab 激活且对应 sessionId 已存在但 activeSession 未对齐时 emit open-intent-session/open-spec-session(包括切 tab 后的异步 sessionId 回填),activeSession 与期望 id 对齐(chatReady)才渲染聊天列防串台;会话 tab 内不再显示重置按钮;选中意图切换复位到 intent tab;无选中(列表空)时空态
│   │   │   └── IntentSessionList/
│   │   │       └── IntentSessionList.vue            # 意图通信会话列表:接受 hideHeader prop 嵌入合并栏;行内重命名/删除、活跃/已完成分组、分页加载更多
│   │
│   ├── discussions/                                 # 讨论页
│   │   ├── Discussions.vue                          # 讨论容器页:桌面两栏(讨论列表 + 只读历史),移动端 MobileStack 两级 drill-down(列表→只读历史);点击讨论 drill 进历史,返回回列表;透传 agents/defaultAgentId 给列表的创建弹窗
│   │   └── components/
│   │       ├── DiscussionList/DiscussionList.vue    # 左栏讨论列表:列表、创建弹窗(类型/目标/上下文 + 参与 agent 多选 + radio 选组织者,默认全选)、提交校验(必须选组织者+至少一个其他 agent)、打开讨论;移动端列表填满 pane、弹窗全屏 sheet
│   │       └── AgendaProgress/AgendaProgress.vue    # 讨论议程进度:展示议程、当前进展、完成度百分比;窄屏收紧横向 padding
│   │
│   ├── schedules/                                   # 定时任务页
│   │   ├── Schedules.vue                            # 定时任务容器页:桌面两栏(左栏纯选择列表 + 右栏 ScheduleDetailPanel)+ 创建/编辑表单弹窗;移动端经 MobileStack 退化为两级 drill-down(任务列表→详情逐级滑入/返回)
│   │   └── components/
│   │       ├── ScheduleList/ScheduleList.vue        # 左栏任务选择列表:行点击 = 选中(emit select,activeId 高亮)、创建(+)、模板菜单(选择后直接创建)、下次执行倒计时(30s 刷新)、状态 badge;run/edit/delete/toggle 操作已迁出至右栏标题栏
│   │       ├── ScheduleDetailPanel/ScheduleDetailPanel.vue  # 右栏容器:常驻标题栏(选中 schedule 名称 + run-now/delete(ConfirmDialog 二次确认)/enable-disable 开关,不提供编辑入口)+「详情/历史」Tab;详情 Tab 渲染 ScheduleDetail,历史 Tab 经 ExecutionHistoryDialog 选执行后渲染 ExecutionDetail;切换选中 schedule 复位到详情 Tab
│   │       ├── ScheduleDetail/ScheduleDetail.vue    # 详情 Tab 内容:vendor 品牌名+色点、绑定 agent、类型、命令/提示词、超时、模式、触发方式及事件筛选、只读 cron 排期(表达式+可读频率)、可自动换行的工具列表
│   │       ├── ScheduleDetail/ScheduleCronEditor.vue  # 「修改时间」cron 编辑弹框(由 ScheduleForm 编辑态 ✎ 打开):频率(每分/每时/每日/每周)+时间;每周时展示周一到周日多选切换(至少选 1 个否则禁用保存+提示),day-of-week 1-5 压缩/逗号拼接;实时表达式预览;仅 emit save(标准 5 字段 cron)
│   │       ├── ExecutionHistoryDialog/ExecutionHistoryDialog.vue  # 历史选择弹框:在选中 schedule 完整日志上做纯前端分页(默认最近 5 笔/页,上一页/下一页),点选一笔上抛 select-execution 并关闭;移动端全屏 sheet;状态 badge/时间/耗时/退出码行渲染
│   │       ├── ExecutionDetail/ExecutionDetail.vue  # 历史 Tab 内执行详情:「执行信息」Tab + 「Session 会话记录」Tab(llm 类型) + 「Command 日志」Tab(command 类型);Tab 栏窄屏可横向滑动;运行中执行的 transcript 随控制层轮询覆盖更新(不闪 loading)
│   │       └── ScheduleForm/ScheduleForm.vue        # 创建/编辑任务表单(弹窗):cron 或事件触发(run:started/run:settled/pr:operation)、高级 cron 构造器、实时 next-run 预览;run:settled 显示 reason 过滤,pr:operation 显示 MCP 集成说明+操作/结果过滤面板(写入 eventPrFilter);编辑态可改标题(清空回退自动命名),创建态自动命名;vendor 下拉(host 缺失灰显)+工具勾选面板(读写分区,读默认勾,全选/全清按钮);移动端全屏 sheet 且紧凑表单单列堆叠
│   │
│   ├── codes/                                       # 代码浏览页
│   │   ├── Codes.vue                                # 代码浏览容器页:桌面双栏(左 CodeTree + 右 CodeTabs);移动端经 MobileStack 退化为 树→文件 两级 drill-down;仅持有/透传 workspace 相对路径,越界判断全在服务端 guard
│   │   └── components/
│   │       ├── CodeTree/CodeTree.vue                # 左栏:顶部 Files 标题 + 左侧 ⇤/⇥ 切换(展开后宽度 560px,localStorage 持久化)+ 搜索框(filename/content 切换 + 文件模式 glob 过滤框 *.ts,默认 * 全部,Enter/防抖触发 search_codes)+ 懒加载文件树/搜索结果(点结果打开文件,content 命中带行号定位)
│   │       ├── CodeTree/CodeTreeNode.vue            # 文件树单节点(递归):目录点击展开/折叠(懒加载 list_dir),文件点击打开 tab,激活态高亮;文件/目录右键菜单可复制名称或 workspace 相对路径并通过全局 toast 反馈
│   │       ├── CodeTabs/CodeTabs.vue                # 右栏多 tab 容器:tab 条(可手动关闭,关闭后聚焦相邻)+ 渲染激活 tab 内容,空态
│   │       └── CodeFileView/CodeFileView.vue        # 单文件内容渲染:复用 Shiki 高亮管线(后缀推断语言,白名单外/二进制/超限降级)+ 行号 gutter 逐行对齐 + 搜索命中滚动并高亮目标行
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
│           ├── SettingsPanel.vue                    # 系统设置面板(弹窗):agent 列表(原生 HTML5 DnD 拖拽手柄重排,save 按数组序回写 order_seq 落库,AC-R20)/默认 agent(列表下方单一下拉,选项=启用 agent 按 order_seq;禁用/移除当前默认时即时 resolveDefaultAgentId 顺延下一个启用项,全禁用→system,AC-R2)/工具 agent(默认下拉下方第二个下拉,执行后台工具型会话即完成判定/总结,选项=「跟随默认」空项+启用 agent 按 order_seq;非空时禁用/移除同默认顺延,空=跟随默认 defaultAgentId,AC-R21)/意图 agent(工具下拉下方第三个下拉,执行意图沟通会话即需求拆解对话,选项=「跟随默认」空项+启用 agent 按 order_seq;非空时禁用/移除同默认顺延,空=跟随默认 defaultAgentId,AC-R23)、共识投票开关、host 诊断、UI 语言切换、voice 语言、emoji picker、认证(ADR-0023:provider 三态下拉 无需认证/basic/oauth 即认证总开关,无独立启用复选框;选 none⇒kind:'none'+enabled:false 免登录隐藏表单,选 basic⇒账号列表编辑器(每行管理员单选 radio+改密入口+删除,底部新增账号行;增删改/设管理员各走 set-password/remove-account/set-admin-account emit→专用消息即时持久化;配好管理员后 enabled 派生 true),选 oauth⇒含 adminEmail 输入(须∈allowedEmails),契约落盘但 enabled 恒 false;未配管理员时暴露开关置灰);非管理员(useAuth.isAdmin←ready.isAdmin)只读:顶部只读提示横幅+保存与账号管理控件禁用(服务端 AUTH-R10 仍强制);移动端全屏 sheet 安全区适配且紧凑表单单列堆叠
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
│   ├── codes-view.ts                                # Codes 页纯逻辑/类型:CodeTab/搜索结果视图、关闭 tab 后聚焦相邻(closeTab)、后缀→Shiki 语言推断(langFromPath)、basename、字节人类可读化
│   ├── chat-scroll.ts                               # 聊天滚动纯逻辑:底部贴近阈值判定 + 消息变化签名,供 ChatMessages 决定是否跟随新输出
│   ├── current-workspace.ts                         # 「当前工作区」解析:优先持久化选择,否则回落到最近访问工作区
│   ├── datetime-formats.ts                          # 日期/数字格式化预设:为 vue-i18n 与纯展示 lib 提供单一数据源
│   ├── dev-launch-view.ts                           # 开发启动遮罩纯状态机:最小停留/安全超时常量 + stage→有序步骤映射(stepStatusesForPhase)+ reduceDevLaunch(stage/ready/dwell-complete/timeout 终态收敛),无 DOM/计时器,供 DevStartupOverlay 与控制层
│   ├── work-session-jump.ts                         # Start Dev 成功后自动跳转纯决策:shouldJumpAfterDevLaunch(仅 ready 跳)+ resolveJumpTargetSessionId(intent.lastDevSessionId 反查)+ resolvePendingWorkSessionSelect(一次性待选会话落入列表即命中)+ ~1s 延迟常量;控制层据此切 console tab 并选中新 work session
│   ├── discussion-view.ts                           # 讨论只读历史纯映射器:DiscussionMessage 正规化为 ChatBody,处理多说话人 icon/name/vendor
│   ├── execution-view.ts                            # 执行 transcript 纯映射器:TranscriptItem 正规化为 ChatBody/ChatMsg,供 Session Tab 的 ChatMessages 渲染
│   ├── schedule-refresh.ts                           # 运行中执行实时刷新的纯决策:isExecutionRunning 推断 + decideScheduleRefresh(running/tab/可见/上次running → shouldPoll/finalFetch) + 轮询间隔常量
│   ├── format.ts                                    # 简单值格式化:JSON 美化打印、多行折叠为单行
│   ├── highlight.ts                                 # Shiki 按需代码高亮:白名单语言、语言别名、哨兵色转 CSS class、DOMPurify 过滤
│   ├── intent-list-view.ts                          # 需求列表纯展示逻辑:状态/运行态标签、面板展开规则、行内字段可见性、日期格式化
│   ├── event-title.ts                               # 工作台事件显示标题:Git/PR 收尾失败 todo(toolName=GIT_CLEANUP_EVENT_TOOL)经 toolInput 的 UiError 本地化,其余回退 title/toolName
│   ├── pending-queue.ts                             # 待发送队列纯逻辑:追加/移除、flush 判断、Send 行为(入队或发送)、草稿合并
│   ├── permission.ts                                # 权限决策动作性判定:找出用户当前唯一能作用的权限请求
│   ├── prompt-image.ts                              # 输入框附图客户端处理:File→PromptImage(校验图片类型/超阈 canvas 等比压缩/base64 预览);纯函数(base64Bytes/splitDataUrl/shouldCompress/scaledSize/toWire/fromWire)可 Node 单测,readImageFiles 走 DOM
│   ├── session-page.ts                              # 会话列表游标分页(SR-R14)纯归并:按 page.kind(first 替换/older 追加去重/window 刷新已展示范围/live upsert)折叠分页响应进每工作区窗口 + SESSION_PAGE_SIZE
│   ├── session-jump.ts                              # 会话跳回规则纯函数:(sessionKind, ownerKind, ownerId)→意图/讨论/定时任务逻辑页目标;spec+intent owner 跳到意图 spec session tab,tool+owner 跳到来源业务,owner 为空返回 null,供会话页与 WorkCenter 共用
│   ├── session-title-sync.ts                        # 会话列表刷新到右侧活动标题的同步规则:仅同 workspace 且同 session 时采用列表标题
│   ├── status-indicator.ts                          # 运行/讨论状态指示器单一数据源:状态→icon+tone+i18n key 映射,支持 agent 前缀
│   ├── tab-view.ts                                  # 标签页/工作区切换效果纯推断:ConsoleTab 进入目标、工作区切换副作用
│   ├── task-list.ts                                 # dev session 任务列表客户端入口:re-export 共享任务模型 + taskPanelView 纯展示视图
│   ├── textarea.ts                                  # 自增长 textarea 的 DOM-free 几何计算:由 scrollHeight 与上限算高度与滚动条显隐
│   ├── vendor.ts                                    # Vendor 品牌标签与配色常量:VENDOR_LABEL、VENDOR_COLOR
│   └── ws.ts                                        # WebSocket 客户端:自动重连、heartbeat+pong 检测、消息监听、状态回调;每次(重)连接按 getToken 注入握手 ?token=(ADR-0023)
│
└── i18n/                                            # 国际化
    ├── index.ts                                     # vue-i18n 初始化:en/zh/ja/ko/ru 多语言、日期/数字格式预设、LocaleKey 拼错检测、locale 元数据剥除
    ├── errors.ts                                    # 服务端 UiError 本地化翻译:code→key 映射,与 en.json 保持同步
    └── format.ts                                    # i18n 格式化辅助:基于当前 locale 的日期/数字格式化 d()/n() 封装
```
