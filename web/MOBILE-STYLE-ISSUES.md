# 移动端样式问题清单（2026-06-12）

在 390×844（iPhone 视口）下逐页排查 c3 Web，发现以下样式问题。
排查方式：playwright-cli 移动视口截图 + 计算样式量测；根因定位到具体 CSS。

> 断点约定：`useBreakpoint` 中 `mobile = max-width: 767px`。但 CSS 里散落 `640px / 700px / 767px / 1024px` 多套断点，是多个 bug 的共同诱因。

参考实现：`DiscussionList.vue` 已有 `@media (max-width: 767px){ width:100%; min-width:0 }`，所以 Discussions 页在移动端表现正确——其余列表照此对齐即可。

---

## 高优先级（功能性，影响可用）

### M1. 列表面板在移动端未撑满全宽，右侧留大片空白

- **现象**：Works / Schedules 页，列表只占 ~260–280px，右侧 ~110–130px 空白（含竖分隔线）。
- **量测**：MobileStack pane = 390px（全宽），但内部列表固定宽。
- **根因**：列表组件保留桌面固定宽度，缺 `max-width:767px` 的全宽覆盖。
  - `web/src/style.css` `.sidebar { width:260px; flex-shrink:0 }`（WorkSessionList，Works 页）
  - `ScheduleList.vue` `.sched-list`：`@media(max-width:1024px){ min-width:280px }`
  - `IntentSessionList.vue` `.int-sess-list`：`@media(max-width:1024px){ min-width:200px }`
- **修复**：各列表加 `@media (max-width:767px){ width:100%; min-width:0; border-right:0 }`。
- **状态**：✅ 已修复

### M2. Intents 列表内容横向溢出（"All" 过滤器、空状态文案被右边缘裁切）

- **现象**：Intents 页工具栏 `Intents | ▶ Automation | All` 的 "All" 下拉被裁，空状态文案 `No intents yet...` 超出右边缘。
- **根因**：`web/src/style.css` `.req-list` 在 `@media(max-width:1024px)` 下 `min-width:450px` —— 在 390px 视口里比视口还宽，整列溢出。
- **修复**：`.req-list` 加 `@media(max-width:767px){ width:100%; min-width:0; border-right:0 }`。
- **状态**：✅ 已修复

### M3. "⋯" 操作菜单选完不关闭，浮层盖在打开的 sheet 之上

- **现象**：点 ⋯ → System settings / Workspace setting，菜单不消失，悬浮在全屏 sheet 顶部；点空白处也不关。
- **根因**：`AppHeader.vue` 移动操作菜单用原生 `<details>`，点菜单项只 emit 事件、不置 `open=false`；原生 details 无"外部点击关闭"。叠加 `.mobile-actions-menu{ z-index:120 }` > `.settings-page{ z-index:100 }`，于是盖在设置页上。
- **修复**：受控 `<details :open>`，选任一项即关；点击页面其它位置也关。
- **状态**：✅ 已修复

### M4. ScheduleForm 全屏 sheet 被底部导航遮挡（Save/最后字段看不到）

- **现象**：新建排程 sheet 底部「PERMISSION MODE / Allowed tools」末项与页脚被固定底栏盖住。
- **根因**：`ScheduleForm.vue` `.sf-overlay{ z-index:50 }` < `.mobile-bottom-tabs{ z-index:90 }`。其它 sheet 用 200/300（NewSessionModal/WorkspaceSetting/SkillApprovalModal）。
- **修复**：`.sf-overlay` z-index 提到 200，与其它 sheet 一致。
- **状态**：✅ 已修复

---

## 中/低优先级（一致性 & 打磨）

### M5. 断点不一致（640 / 700 / 767 混用）

- `.body` 底栏避让 `max-width:700px`、AppHeader 移动壳 `700px`、sheet 全屏化 `640px`、列表收窄 `1024px`、mobile 判定 `767px`。
- 700/640 与 767 之间会出现"半移动态"（底栏已出现但 sheet 还是居中弹窗）。
- **修复方向**：移动相关阈值统一为 `767px`（含 `.body` 避让、sf-overlay/settings 全屏化）。
- **状态**：✅ 已统一 sheet 全屏化与底栏避让到 767px（保留 1024px 的平板收窄）

### M6. 移动端标题重复 + 无用的折叠按钮

- MobileStack 顶部已显示 pane 标题（Sessions/Intents/Discussions...），列表组件又渲染自己的 head 标题；同时 head 里的"展开/收缩"按钮在单栏 drill-down 下无意义。
- **状态**：⬜ 暂记录，未改（属信息架构打磨，风险较高，单列）

### M7. SettingsPanel agent 行在窄屏堆叠为"孤零零居中的勾选框/单选钮/图标"

- 640px 下 `.agent-row` 改 column 全宽，`.col-on/.col-default{ justify-content:center }` 让单个控件居中且无标签，辨识度差。
- **状态**：⬜ 暂记录，未改（需补行内标签，单列）

### M8. 添加工作区用原生 `prompt()` 输入绝对路径

- 顶栏 `+` 触发浏览器原生 prompt，移动端体验差。
- **状态**：⬜ 超出本次样式范围，仅记录

---

### 连带修复（非样式，但阻塞 lint）

- `Works.vue`：`SessionList`→`WorkSessionList` 改名时把自闭合 `/>` 误写成 `</WorkSessionList>`（开标签缺 `>`），触发 `vue/no-parsing-error`。已恢复为自闭合 `/>`。

---

## 验收

- typecheck / lint / 受影响测试（AppHeader、MobileStack 共 12 例）全通过。
- 390×844 视口复验：Works/Schedules 列表全宽、Intents 无横向溢出、⋯ 菜单选完即关、ScheduleForm 页脚不被底栏遮挡。

## 排查附记

- 底部 5 视图 tab（含 "Workcenter"）经 `scrollWidth/clientWidth` 量测**未截断**，初看的"被切"为视觉误判，不修。
- 排查期间为绕过登录门临时改 `~/.c3/settings.json` `auth.enabled=false`（备份 `settings.json.bak-mobile`），收尾恢复。
  </content>
  </invoke>
