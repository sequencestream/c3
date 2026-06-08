# Web 页面与组件清单

c3 前端（Vue 3）所有页面、组件、composable 与工具模块的树状索引，每行一句功能说明。源码位于 `web/src/`。

```
web/src/
├── App.vue                                          # 全局应用容器:WebSocket 连接、会话状态、顶部导航、各视图(会话/需求/讨论/定时任务/工作台)切换与数据调度,挂载权限模态/技能批准/项目配置/系统设置
├── main.ts                                          # 应用入口:创建 Vue 实例、安装 i18n、挂载 App
│
├── components/                                      # 跨页面通用组件
│   ├── AppHeader/AppHeader.vue                      # 顶部栏:工作区切换器、tab 导航(会话/需求/讨论/定时任务/工作台,带未处理事件计数徽标)、项目配置/系统设置入口、连接状态指示
│   ├── BaseDropdown/BaseDropdown.vue                # 标准下拉框:替代原生 select,支持键盘导航、多选高亮、点击外部关闭
│   ├── ChatMessages/ChatMessages.vue               # 会话消息渲染区:扁平消息分组为文本/工具批次/独立块(用户交互工具)、自动折叠工具调用、渲染权限提示与共识结果
│   ├── ConsensusBlock/ConsensusBlock.vue           # 多 agent 共识自动裁定结果块(只读):AskUserQuestion 逐题自动作答、其他工具 allow/deny 裁定
│   ├── ExitPlanModeDisplay/ExitPlanModeDisplay.vue # ExitPlanMode 计划独立渲染块:解析输入负载中的 plan markdown + 结构化元数据(标题/步骤索引),支持 tool-use/tool-result 双态
│   ├── MarkdownText/MarkdownText.vue               # 单条文本消息渲染器:assistant 走 Markdown+DOMPurify 双防线、user/system 纯文本转义、Shiki 代码高亮
│   ├── MessageInput/MessageInput.vue               # 底部输入区:斜杠命令补全、textarea 自增长、语音输入、发送/停止控制、待发队列管理
│   ├── PendingQueue/PendingQueue.vue               # 待发送队列显示区:展示运行中缓存的待发消息,支持修改和删除
│   ├── PermissionPrompt/PermissionPrompt.vue       # 单条权限提示块:AskUserQuestion 逐题作答面板或其他工具 allow/deny 提示,展示 agent 共识意见
│   ├── SessionStatusBar/SessionStatusBar.vue       # 输入框上方状态条:展示会话运行态(思考/工具执行/等待授权/出错/就绪),支持刷新、停止、继续
│   ├── SessionTitleBar/SessionTitleBar.vue         # 聊天列顶部标题行:会话标题、权限模式下拉、vendor 标签与 agent 切换器
│   ├── SkillApprovalModal/SkillApprovalModal.vue   # 外部 skill 加载审批模态:确认向 .gitignore 追加 _c3_* 的一次性确认
│   ├── TaskPanel/TaskPanel.vue                      # 实时任务面板:只读展示当前 session 任务列表,in_progress 置顶/pending 居中/completed 垫底
│   └── WorkspaceSwitcher/WorkspaceSwitcher.vue     # 顶部栏最左工作区切换器:显示当前工作区,支持新增/选择/移除,内含 popover
│
├── pages/                                           # 各功能页面(容器页 + 页内子组件)
│   ├── workcenter/                                  # 工作台页
│   │   ├── WorkCenter.vue                           # 工作台容器页:状态筛选器 + EventList 子组件,集中查看/操作所有待处理事件
│   │   └── components/
│   │       └── EventList.vue                        # 事件列表:按项目分组、状态徽标、标题、来源图标、时间、行内 Allow/Deny、AskUserQuestion 作答面板、跳转到源
│   ├── sessions/                                    # 会话页
│   │   ├── Sessions.vue                             # 会话容器页:左侧会话列表 + 右侧聊天列(标题栏/消息/任务面板/状态栏/待发队列/输入框)
│   │   └── components/
│   │       ├── SessionList/SessionList.vue          # 左栏会话列表:当前工作区会话、新增、删除/改名、分页、offline 警告
│   │       └── NewSessionModal/NewSessionModal.vue  # 新建会话弹窗:选择 vendor/agent(Auto 继承默认或指定),host-binary 缺失时灰显并提示检测面板
│   │
│   ├── intents/                                     # 需求页
│   │   ├── Intents.vue                              # 需求容器页:左侧需求列表 + 右侧聊天列(复用会话聊天组件)
│   │   └── components/
│   │       └── IntentList/IntentList.vue            # 左栏需求列表:按状态过滤、行内操作(完善/启动开发/标记状态)、自动化编排启停、新建需求
│   │
│   ├── discussions/                                 # 讨论页
│   │   ├── Discussions.vue                          # 讨论容器页:左侧讨论列表 + 右侧只读历史(标题栏+议程进度+消息+composer)
│   │   └── components/
│   │       ├── DiscussionList/DiscussionList.vue    # 左栏讨论列表:列表、创建表单(类型/目标/上下文)、打开讨论
│   │       └── AgendaProgress/AgendaProgress.vue    # 讨论议程进度:展示议程、当前进展、完成度百分比
│   │
│   ├── schedules/                                   # 定时任务页
│   │   ├── Schedules.vue                            # 定时任务三栏容器页:左栏列表 + 中栏执行历史 + 右栏 Tab 详情 + 创建/编辑表单弹窗
│   │   └── components/
│   │       ├── ScheduleList/ScheduleList.vue        # 左栏任务列表:列表、创建、enable/disable 开关、下次执行倒计时(30s 刷新)
│   │       ├── ExecutionHistoryList/ExecutionHistoryList.vue  # 中栏执行历史列表:选中 schedule 的执行记录,点击选中某次执行
│   │       ├── ExecutionDetail/ExecutionDetail.vue  # 右栏 Tab 化执行详情:「执行信息」Tab + 「Session 会话记录」Tab(llm 类型) + 「Command 日志」Tab(command 类型)
│   │       └── ScheduleForm/ScheduleForm.vue        # 创建/编辑任务表单(弹窗):cron 或事件触发、高级 cron 构造器、实时 next-run 预览;编辑态可改标题(清空回退自动命名),创建态自动命名;vendor 下拉(host 缺失灰显)+工具勾选面板(读写分区,读默认勾,全选/全清按钮)
│   │
│   ├── projectconfig/                               # 项目配置页
│   │   └── ProjectConfig.vue                        # 项目级配置编辑(弹窗):per-vendor 默认模式、讨论轮数上限、演讲字符限制等 workspace 级配置
│   │
│   └── systemsettings/                              # 系统设置页
│       ├── SystemSettings.vue                       # 系统设置容器(弹窗):封装 SettingsPanel
│       └── components/SettingsPanel/
│           ├── SettingsPanel.vue                    # 系统设置面板(弹窗):agent 列表/默认 agent、共识投票开关、host 诊断、UI 语言切换、voice 语言、emoji picker
│           ├── EmojiPicker.vue                      # emoji 选择器:零依赖,支持搜索、分类导航、自定义输入(最长 16 字符)
│           └── emoji-data.ts                        # emoji 数据集:分类 emoji 列表与搜索关键词
│
├── composables/                                     # 可复用组合式逻辑
│   ├── useModeLabel.ts                              # agent 权限模式本地化标签解析器:覆盖 Claude/Codex/OpenCode 各 vendor 模式
│   ├── usePersistentToggle.ts                       # localStorage 绑定的布尔 ref:记住列表面板收缩/展开态,跨刷新保留
│   └── useSpeechRecognition.ts                      # Web Speech API 轻封装:浏览器语音转文字,持续聆听、自动重启、final/interim 回调
│
├── lib/                                             # 纯逻辑工具模块(无 DOM/框架依赖优先)
│   ├── agent-prefix.ts                              # 客户端推断当前 session 运行的 agent 展示名:本地复刻服务端降级链
│   ├── ask.ts                                       # AskUserQuestion 辅助:提取问题列表、共识意见、选项/自定义答案聚合
│   ├── chat-types.ts                                # 聊天消息数据模型:ChatBody/ChatMsg/PermissionMsg/RunActivity/Block 类型(含 standalone 块)、多说话人 SpeakerView
│   ├── current-workspace.ts                         # 「当前工作区」解析:优先持久化选择,否则回落到最近访问工作区
│   ├── datetime-formats.ts                          # 日期/数字格式化预设:为 vue-i18n 与纯展示 lib 提供单一数据源
│   ├── discussion-view.ts                           # 讨论只读历史纯映射器:DiscussionMessage 正规化为 ChatBody,处理多说话人 icon/name/vendor
│   ├── execution-view.ts                            # 执行 transcript 纯映射器:TranscriptItem 正规化为 ChatBody/ChatMsg,供 Session Tab 的 ChatMessages 渲染
│   ├── format.ts                                    # 简单值格式化:JSON 美化打印、多行折叠为单行
│   ├── highlight.ts                                 # Shiki 按需代码高亮:白名单语言、语言别名、哨兵色转 CSS class、DOMPurify 过滤
│   ├── intent-list-view.ts                          # 需求列表纯展示逻辑:状态/运行态标签、面板展开规则、行内字段可见性、日期格式化
│   ├── pending-queue.ts                             # 待发送队列纯逻辑:追加/移除、flush 判断、Send 行为(入队或发送)、草稿合并
│   ├── permission.ts                                # 权限决策动作性判定:找出用户当前唯一能作用的权限请求
│   ├── status-indicator.ts                          # 运行/讨论状态指示器单一数据源:状态→icon+tone+i18n key 映射,支持 agent 前缀
│   ├── tab-view.ts                                  # 标签页/工作区切换效果纯推断:ConsoleTab 进入目标、工作区切换副作用
│   ├── task-list.ts                                 # dev session 任务列表客户端入口:re-export 共享任务模型 + taskPanelView 纯展示视图
│   ├── textarea.ts                                  # 自增长 textarea 的 DOM-free 几何计算:由 scrollHeight 与上限算高度与滚动条显隐
│   ├── vendor.ts                                    # Vendor 品牌标签与配色常量:VENDOR_LABEL、VENDOR_COLOR
│   └── ws.ts                                        # WebSocket 客户端:自动重连、heartbeat+pong 检测、消息监听、状态回调
│
└── i18n/                                            # 国际化
    ├── index.ts                                     # vue-i18n 初始化:en/zh/ja/ko/ru 多语言、日期/数字格式预设、LocaleKey 拼错检测、locale 元数据剥除
    ├── errors.ts                                    # 服务端 UiError 本地化翻译:code→key 映射,与 en.json 保持同步
    └── format.ts                                    # i18n 格式化辅助:基于当前 locale 的日期/数字格式化 d()/n() 封装
```
