# Web 页面与组件清单

c3 前端（Vue 3）所有页面、组件、composable 与工具模块的树状索引，每行一句功能说明。源码位于 `web/src/`。

```
web/src/
├── App.vue                                          # 应用入口壳(瘦):导入页面/模态组件,解构 useAppController() 的共享 ctx 绑定到模板(登录门 + 顶栏 + 各视图 + 模态 + 全局 toast);全部控制逻辑下沉到 controls/
├── main.ts                                          # 应用入口:创建 Vue 实例、安装 i18n、挂载 App
│
├── controls/                                        # App 控制器:拆分自原 App.vue 的状态 + 消息路由 + 各域动作,经共享 ctx 对象晚绑定串联
│   ├── index.ts                                     # useAppController():建 state、装 runtime(client/send/reconnect/t/auth)、依次 install 各域、管理 WebSocket 生命周期(onMounted 建连/心跳/可见性/onReopen 重选),返回 ctx 供 App.vue 解构
│   ├── state.ts                                     # createState():全部 ref/computed + 纯状态辅助(statusOf/add/setQueue/showToast/sessionTitleById/clearSideEffectPending)、计数器、localStorage 键常量;导出 AppState 类型
│   ├── types.ts                                     # ctx 类型契约:AppRuntime(client/send/reconnect/t/auth)+ AppMethods(全部域方法签名),AppCtx = AppState & AppRuntime & AppMethods
│   ├── transcript.ts                               # transcriptToChat():TranscriptItem→ChatBody 纯映射(会话历史回放)
│   ├── persistence.ts                              # 视图恢复持久化:readStoredWorkspace/persistCurrentWorkspace/persistViewMode + ready 后 maybeRestore 需求/讨论/定时任务
│   ├── message-handler.ts                          # installMessageHandler():唯一入站 WS switch(handleMessage)折叠所有 ServerToClient 事件 + applyStatuses/notifyAwaitingPermission
│   ├── session-actions.ts                          # 工作区/会话/顶栏 tab 导航:刷新/选择会话、新建会话弹窗、控制台 tab 进入与重绑、清空视图会话
│   ├── intent-actions.ts                           # 需求页动作:筛选/精炼/开发/PR/状态/自动化 + 沟通 session 列表(新建/选择/重命名/删除)
│   ├── discussion-actions.ts                       # 讨论页动作(只读路径 + 组织者引擎):打开/创建/开始/暂停/恢复/转需求/发言/移动返回
│   ├── schedule-actions.ts                         # 定时任务页动作:打开/选择/执行记录/会话回放 + 创建编辑表单(含 toolManifest 缓存 watch)
│   ├── chat-actions.ts                             # 聊天/输入动作 + 客户端待发队列(enqueue/edit/delete/flush watch)、提交/继续/停止/刷新/模式/agent 切换/权限响应
│   ├── settings-actions.ts                         # 系统/工作区设置、技能安装、运行时语言切换(回滚)、workspace↔workcenter 视图模式、技能加载审批
│   └── workcenter-actions.ts                       # 工作台事件动作:权限响应/作答 + 跳转到来源 tab(会话/需求/讨论/定时任务)
│
├── components/                                      # 跨页面通用组件
│   ├── AppHeader/AppHeader.vue                      # 应用导航壳:桌面顶部栏(工作区切换器、tab 导航、项目配置/系统设置/登出/连接状态),移动端顶部精简栏 + 底部 5 视图 tab(工作/需求/讨论/定时任务/工作台,带未处理事件计数徽标)
│   ├── BaseDropdown/BaseDropdown.vue                # 标准下拉框:替代原生 select,支持键盘导航、多选高亮、点击外部关闭
│   ├── ChatMessages/ChatMessages.vue               # 会话消息渲染区:扁平消息分组为文本/工具批次/独立块(用户交互工具)、仅用户停在底部时自动跟随新输出、渲染权限提示与共识结果,代码/工具输出局部横滚防窄屏撑破
│   ├── ConsensusBlock/ConsensusBlock.vue           # 多 agent 共识自动裁定结果块(只读):AskUserQuestion 逐题自动作答、其他工具 allow/deny 裁定
│   ├── ExitPlanModeDisplay/ExitPlanModeDisplay.vue # ExitPlanMode 计划独立渲染块:解析输入负载中的 plan markdown + 结构化元数据(标题/步骤索引),支持 tool-use/tool-result 双态
│   ├── MarkdownText/MarkdownText.vue               # 单条文本消息渲染器:assistant 走 Markdown+DOMPurify 双防线、user/system 纯文本转义、Shiki 代码高亮,宽表格包局部横滚容器
│   ├── MessageInput/MessageInput.vue               # 底部输入区:斜杠命令补全、textarea 自增长、语音输入、发送/停止控制、待发队列管理,移动端软键盘/安全区避让
│   ├── MobileStack/MobileStack.vue                 # 移动端 drill-down 布局壳:桌面透传多栏,移动端按 pane key 栈式切换、顶部返回、滑入动画
│   ├── PendingQueue/PendingQueue.vue               # 待发送队列显示区:展示运行中缓存的待发消息,支持修改和删除
│   ├── PermissionPrompt/PermissionPrompt.vue       # 单条权限提示块:AskUserQuestion 逐题作答面板或其他工具 allow/deny 提示,展示 agent 共识意见
│   ├── SessionStatusBar/SessionStatusBar.vue       # 输入框上方状态条:展示会话运行态(思考/工具执行/等待授权/出错/就绪),支持刷新、停止、继续
│   ├── SessionTitleBar/SessionTitleBar.vue         # 聊天列顶部标题行:会话标题、权限模式下拉、vendor 标签与 agent 切换器
│   ├── SkillApprovalModal/SkillApprovalModal.vue   # 外部 skill 加载审批模态:确认向 .gitignore 追加 _c3_* 的一次性确认;移动端全屏 sheet(顶部关闭、内容可滚、安全区适配)
│   ├── TaskPanel/TaskPanel.vue                      # 实时任务面板:只读展示当前 session 任务列表,in_progress 置顶/pending 居中/completed 垫底
│   └── WorkspaceSwitcher/WorkspaceSwitcher.vue     # 顶部栏最左工作区切换器:显示当前工作区,支持新增/选择/移除,内含 popover
│
├── pages/                                           # 各功能页面(容器页 + 页内子组件)
│   ├── workcenter/                                  # 工作台页
│   │   ├── WorkCenter.vue                           # 工作台容器页:桌面筛选/列表 + 详情两栏,移动端单列流式,集中查看/操作所有待处理事件
│   │   └── components/
│   │       ├── EventList.vue                        # 事件列表:状态徽标、标题、来源图标、时间与选中态,移动端行高触控优化
│   │       └── EventDetail.vue                      # 事件详情:完整信息、Allow/Deny、AskUserQuestion 作答面板与跳转到源,移动端触控按钮优化
│   ├── works/                                    # 工作页
│   │   ├── Works.vue                             # 工作容器页:桌面左侧会话列表 + 右侧聊天列;移动端列表↔聊天 drill-down(返回到列表)
│   │   └── components/
│   │       ├── WorkSessionList/WorkSessionList.vue  # 左栏会话列表:当前工作区会话、新增、删除/改名、分页、offline 警告
│   │       └── NewSessionModal/NewSessionModal.vue  # 新建会话弹窗:选择 vendor/agent(Auto 继承默认或指定),host-binary 缺失时灰显并提示检测面板;移动端全屏 sheet(顶部关闭、内容可滚、安全区适配)
│   │
│   ├── intents/                                     # 需求页
│   │   ├── Intents.vue                              # 需求容器页:桌面三栏(需求+session+聊天),移动端 MobileStack 三级 drill-down(意图列表→sessions→聊天)
│   │   ├── components/
│   │   │   ├── IntentList/IntentList.vue            # 左栏需求列表:按状态过滤、行内操作(完善/启动开发/标记状态)、折叠态 kebab(⋮)菜单暴露全部行内操作、自动化编排启停、新建需求;点击行 emit select-intent(mobile drill-down 导航)
│   │   │   └── IntentSessionList/
│   │   │       └── IntentSessionList.vue            # 中栏意图通信会话列表:行内重命名/删除、展开/收起、活跃会话常驻
│   │
│   ├── discussions/                                 # 讨论页
│   │   ├── Discussions.vue                          # 讨论容器页:桌面两栏(讨论列表 + 只读历史),移动端 MobileStack 两级 drill-down(列表→只读历史);点击讨论 drill 进历史,返回回列表;透传 agents/defaultAgentId 给列表的创建弹窗
│   │   └── components/
│   │       ├── DiscussionList/DiscussionList.vue    # 左栏讨论列表:列表、创建弹窗(类型/目标/上下文 + 参与 agent 多选,默认全选、组织者恒选禁用)、打开讨论;移动端列表填满 pane、弹窗全屏 sheet
│   │       └── AgendaProgress/AgendaProgress.vue    # 讨论议程进度:展示议程、当前进展、完成度百分比;窄屏收紧横向 padding
│   │
│   ├── schedules/                                   # 定时任务页
│   │   ├── Schedules.vue                            # 定时任务容器页:桌面三栏(左栏列表 + 中栏执行历史 + 右栏 Tab 详情)+ 创建/编辑表单弹窗;移动端经 MobileStack 退化为三级 drill-down(任务列表→执行历史→Tab 执行详情逐级滑入/返回)
│   │   └── components/
│   │       ├── ScheduleList/ScheduleList.vue        # 左栏任务列表:列表、创建、enable/disable 开关、下次执行倒计时(30s 刷新)
│   │       ├── ExecutionHistoryList/ExecutionHistoryList.vue  # 中栏执行历史列表:选中 schedule 的执行记录,点击选中某次执行
│   │       ├── ScheduleDetail/ScheduleDetail.vue    # 右栏 schedule 详情(选中任务但未选执行时):vendor 品牌名+色点、mcpMode、toolAllowlist 读/写分类列表(借 toolManifest 缓存)
│   │       ├── ExecutionDetail/ExecutionDetail.vue  # 右栏 Tab 化执行详情:「执行信息」Tab + 「Session 会话记录」Tab(llm 类型) + 「Command 日志」Tab(command 类型);Tab 栏窄屏可横向滑动
│   │       └── ScheduleForm/ScheduleForm.vue        # 创建/编辑任务表单(弹窗):cron 或事件触发、高级 cron 构造器、实时 next-run 预览;编辑态可改标题(清空回退自动命名),创建态自动命名;vendor 下拉(host 缺失灰显)+工具勾选面板(读写分区,读默认勾,全选/全清按钮);移动端全屏 sheet 且紧凑表单单列堆叠
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
│           ├── SettingsPanel.vue                    # 系统设置面板(弹窗):agent 列表(原生 HTML5 DnD 拖拽手柄重排,save 按数组序回写 order_seq 落库,AC-R20)/默认 agent(列表下方单一下拉,选项=启用 agent 按 order_seq;禁用/移除当前默认时即时 resolveDefaultAgentId 顺延下一个启用项,全禁用→system,AC-R2)、共识投票开关、host 诊断、UI 语言切换、voice 语言、emoji picker、认证(ADR-0023:basic 启用/改密/网络暴露;provider 下拉 basic 可选其余置灰;改密走 set-password emit→服务端哈希,未配管理员时启用/暴露开关置灰);移动端全屏 sheet 安全区适配且紧凑表单单列堆叠
│           ├── EmojiPicker.vue                      # emoji 选择器:零依赖,支持搜索、分类导航、自定义输入(最长 16 字符)
│           └── emoji-data.ts                        # emoji 数据集:分类 emoji 列表与搜索关键词
│
├── composables/                                     # 可复用组合式逻辑
│   ├── useAuth.ts                                    # 认证状态 reactive 单例(ADR-0023):status(unknown/authenticated/login-required)、submitLogin/logout、login_result/unauthenticated 回流、token 持久化,纯响应服务端
│   ├── useBreakpoint.ts                              # 响应式媒体查询断点:提供 useBreakpoint/useIsMobile,统一移动端判断与 matchMedia 变更监听
│   ├── useModeLabel.ts                              # agent 权限模式本地化标签解析器:覆盖 Claude/Codex/OpenCode 各 vendor 模式
│   ├── usePersistentToggle.ts                       # localStorage 绑定的布尔 ref:记住列表面板收缩/展开态,跨刷新保留
│   └── useSpeechRecognition.ts                      # Web Speech API 轻封装:浏览器语音转文字,持续聆听、自动重启、final/interim 回调
│
├── lib/                                             # 纯逻辑工具模块(无 DOM/框架依赖优先)
│   ├── agent-prefix.ts                              # 客户端推断当前 session 运行的 agent 展示名:本地复刻服务端降级链
│   ├── authToken.ts                                 # 会话 token 持久化(localStorage,guard 无 DOM 环境):get/set/clear,供 ws.ts 握手 ?token= 复用
│   ├── ask.ts                                       # AskUserQuestion 辅助:提取问题列表、共识意见、选项/自定义答案聚合
│   ├── chat-types.ts                                # 聊天消息数据模型:ChatBody/ChatMsg/PermissionMsg/RunActivity/Block 类型(含 standalone 块)、多说话人 SpeakerView
│   ├── chat-scroll.ts                               # 聊天滚动纯逻辑:底部贴近阈值判定 + 消息变化签名,供 ChatMessages 决定是否跟随新输出
│   ├── current-workspace.ts                         # 「当前工作区」解析:优先持久化选择,否则回落到最近访问工作区
│   ├── datetime-formats.ts                          # 日期/数字格式化预设:为 vue-i18n 与纯展示 lib 提供单一数据源
│   ├── discussion-view.ts                           # 讨论只读历史纯映射器:DiscussionMessage 正规化为 ChatBody,处理多说话人 icon/name/vendor
│   ├── execution-view.ts                            # 执行 transcript 纯映射器:TranscriptItem 正规化为 ChatBody/ChatMsg,供 Session Tab 的 ChatMessages 渲染
│   ├── format.ts                                    # 简单值格式化:JSON 美化打印、多行折叠为单行
│   ├── highlight.ts                                 # Shiki 按需代码高亮:白名单语言、语言别名、哨兵色转 CSS class、DOMPurify 过滤
│   ├── intent-list-view.ts                          # 需求列表纯展示逻辑:状态/运行态标签、面板展开规则、行内字段可见性、日期格式化
│   ├── pending-queue.ts                             # 待发送队列纯逻辑:追加/移除、flush 判断、Send 行为(入队或发送)、草稿合并
│   ├── permission.ts                                # 权限决策动作性判定:找出用户当前唯一能作用的权限请求
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
