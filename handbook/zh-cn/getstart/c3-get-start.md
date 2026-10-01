# c3 入门指南

## c3 是什么

c3（Code Creative Center）是一个 **AI 工作台**：在同一个浏览器界面里，集中管理和驱动多个 AI 编码智能体（Claude Code、Codex、Cursor 等）。智能体每次要执行敏感操作（写文件、编辑代码、运行命令）时，浏览器会弹出审批面板，展示是哪个工具、什么输入，由你选择允许或拒绝——不必在终端里跟 prompt 混在一起。

除权限控制外，c3 把以下能力集成到软件工程流程中：

- **意图（Intent）** —— 用自然语言表达想法，拆成可验证、可追踪的条目，再驱动规格、开发、PR
- **意图队列** —— 勾选 `automate` 的意图按优先级与依赖自动开发，失败则退避挂起
- **规范驱动开发（SDD）** —— 先写规格、只读审核、人（或可选的机器）批准，再写代码
- **交付（Delivery）** —— 一批意图共同集成到交付分支，验证后再用一条交付 PR 进入主线
- **多智能体讨论（Discussion）** —— 编码前让多个 AI 视角碰撞、收敛方案
- **共识投票（Consensus）** —— 关键权限决策可由多智能体先投票，定不了才回落到你
- **自动化（Automation）** —— 按时间表或系统事件跑命令或智能体工作
- **工作树隔离（Worktree）** —— 并行任务在隔离的 git 工作树中运行（工作区默认为此模式）
- **沙箱执行（Sandbox）** —— 入选会话的 run 进进程级隔离；驱动不可用则失败，不裸跑
- **工作台（Workcenter）** —— 跨工作区运行总览与通知收件箱，可在一处回答权限
- **聊天机器人** —— 在飞书群里 @ 机器人提问，无人值守跑一轮，只把最终回答发回群
- **外部 MCP** —— 用长期钥匙让你自己的智能体或 CI 按工作区范围访问本部署

![c3 智能体界面](../../images/c3-agents.png)
![c3 会话界面](../../images/c3-sessions.png)

---

## 前置准备

### 可选工具

以下工具非必装，但若你使用对应的代码托管平台，安装后可获得更好的 Git 集成：

- GitHub CLI — `brew install gh`，或访问 [cli.github.com](https://cli.github.com/)
- GitLab CLI — `brew install glab`，或访问 [gitlab.com/gitlab-org/cli](https://gitlab.com/gitlab-org/cli)

---

## 安装

任选一种方式。

### CLI 单二进制

Homebrew（推荐 macOS / Linux）：

```bash
brew install sequencestream/tap/c3
```

安装脚本（macOS / Linux）：

```bash
curl -fsSL https://raw.githubusercontent.com/sequencestream/c3/main/install.sh | sh
```

安装到 `~/.local/bin`。可通过 `C3_INSTALL_DIR` 自定义目录，`C3_VERSION` 锁定版本。

安装脚本（Windows PowerShell）：

```powershell
irm https://raw.githubusercontent.com/sequencestream/c3/main/install.ps1 | iex
```

安装到 `%LOCALAPPDATA%\c3\bin`。

手动下载：

从 [releases 页面](https://github.com/sequencestream/c3/releases/) 下载对应平台的压缩包（macOS / Linux 为 `.tar.gz`，Windows 为 `.zip`），校验 sha256 后解压运行。文件名形如 `c3-cli-<version>-macos-arm64.tar.gz`。

```bash
tar -xzvf c3-cli-<version>-macos-arm64.tar.gz
./c3 --port 3000
```

macOS 首次启动：手动下载的应用可能触发"无法验证开发者"警告。前往系统设置 → 隐私与安全性，找到 c3 点击"仍然允许"。Homebrew 安装不会遇到此问题。

### 桌面应用

同一份 GitHub Release 还提供桌面安装包。安装后双击启动，托盘常驻，无需自己开终端或浏览器。桌面壳与 CLI 二进制共享同一实例目录；桌面开机自启与 `c3 install` 的系统服务互不相干。

---

## 升级

控制台顶栏会展示自更新进度；管理员确认后才替换二进制并按当前运行形态重启。包管理器安装的二进制由该管理器升级，控制台自更新会让位。桌面渠道走整包更新，不单独替换 sidecar。

终端方式：

```bash
c3 upgrade              # 下载最新版并替换二进制（不重启进程）
c3 upgrade --check      # 仅对比版本号
c3 upgrade --force      # 重新安装当前版本
```

升级后需执行 `c3 restart` 或退出重新运行以加载新版本。

其他方式：`brew upgrade sequencestream/tap/c3`（Homebrew），或重新运行安装脚本。

---

## 启动

```bash
c3 --port 3000
```

打开浏览器访问 http://localhost:3000。

c3 默认只监听 `127.0.0.1`。要接受局域网或远程连接，显式指定网卡：

```bash
c3 --port 3000 --host 0.0.0.0
```

| 场景                 | 命令                            |
| -------------------- | ------------------------------- |
| 后台运行             | `c3 --port 3000 --daemon`       |
| 系统服务（开机自启） | `c3 install --port 3000`        |
| 查看帮助             | `c3 --help` / `c3 start --help` |

`c3 --port 3000` 是 `c3 start --port 3000` 的简写。可用 `--db` 指定实例数据库路径（默认 `~/.c3/c3.db`），从而隔离整套配置。

---

## 配置智能体（Agent）

c3 通过智能体驱动编码工作。厂商决定启动哪家客户端（Claude / Codex / Cursor）；连接来自具名上游（Model Provider）或该厂商的 CLI 登录。模型是独立覆盖，与连接来源正交。Cursor 始终走 CLI 登录，不绑提供方。

注册表永不为空：尚无真实档案时，系统会合成一条 Claude + CLI 登录的兜底。冷启动时，若本机已探测到可用厂商，也可一键为每个可用厂商各建一条 CLI 登录型档案。

### 查看和配置

1. 打开浏览器访问 http://localhost:3000
2. 点击界面右上角的设置（Settings）
3. 在智能体配置中查看档案、具名上游、默认智能体与按角色的专用路由（沟通、规格、审核、工作、评审、修复、自动化等）

![c3 模型提供方](../../images/c3-model-provider.png)

### 添加智能体

在设置页可添加更多智能体，例如指定不同模型、共用一条上游，或把同厂商档案编成可回退的组：

| 字段   | 说明                                                   |
| ------ | ------------------------------------------------------ |
| 名称   | 显示名称，如"Claude Sonnet"                            |
| 供应商 | `claude`、`codex` 或 `cursor`                          |
| 连接   | 引用一条具名上游，或使用该厂商 CLI 登录                |
| 模型   | 可选覆盖；空则不覆盖                                   |
| 分组   | 同厂商可编组，按列表顺序回退；空组在新开一轮时明确失败 |

宿主 CLI 不可用的厂商不能用来新开一轮。已有会话冻结厂商后，只允许同厂商换绑。

若只使用本机 Claude Code 的默认 CLI 登录，兜底档案即可直接使用。

---

## 第一次跑通：端到端最小流程

### 第 1 步：启动 c3

```bash
c3 --port 3000
```

终端输出 `c3 running at http://localhost:3000` 即启动成功。

### 第 2 步：打开浏览器

访问 http://localhost:3000 进入 c3 界面。控制台分两大视图：**工作区**（该项目的会话与账本）与 **工作台**（通知、总览与聊天机器人）。切视图不打断正在跑的会话。

### 第 3 步：创建工作区

点击新建工作区（New Workspace），取个名字（如 `hello-c3`）。目录由本机目录对话框选择（点选失败才露出一次性手填）。创建后自动进入该工作区。

### 第 4 步：创建会话

点击新建会话（New Session），可选智能体或沿用默认，选中它进入对话界面。

### 第 5 步：输入需求

在底部输入框中用自然语言描述想法，例如：

> 帮我分析当前项目目录，生成一个 README.md 文件，描述项目用途和结构。

运行中仍可编辑下一条消息，结束后自动发出。

### 第 6 步：观察智能体运行

c3 启动智能体后，你将实时看到：

- 助手消息逐字流式输出
- 工具调用 —— 读文件、写文件、运行命令等每一步都在界面展示
- 权限请求 —— 敏感操作会弹出审批面板，供你选择允许（Allow）或拒绝（Deny）；工作台也可作答

### 第 7 步：查看结果

任务完成后，在界面查看最终结果，或在项目目录中找到生成的代码文件。

### 完整流程速览

```
安装 → 启动 c3 → 打开浏览器 → 创建工作区 → 创建会话
    → 输入需求 → 观察运行 → 审批工具调用 → 完成
```

第一次跑通建议选一个小需求（如生成 README），一两分钟即可走完全程。之后可探索 [意图管理](requirement-to-intent.md)、[SDD](sdd.md)、[交付](delivery.md)、多智能体讨论、自动化等工程化能力。

---

## 常见问题

**Q：启动时提示 `command not found`？**

A：Homebrew 安装会自动添加 PATH；脚本安装在 `~/.local/bin`，手动加入：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

写入 `~/.zshrc` 可永久生效。

**Q：macOS 安全提示"无法验证开发者"？**

A：前往系统设置 → 隐私与安全性，找到 c3 点击"仍然允许"。

**Q：升级后需要重启吗？**

A：需要。`c3 upgrade` 只替换二进制文件。控制台自更新则在管理员确认后按运行形态重启。升级后也可执行 `c3 restart` 或退出重新运行。

**Q：如何停止 c3？**

- 前台运行：`Ctrl+C`
- 后台运行 / 系统服务：`c3 stop`
- 桌面应用：从托盘退出

**Q：c3 和 Claude Code / Codex / Cursor 是什么关系？**

A：c3 通过统一适配层驱动这三家宿主 CLI，把终端权限提示搬到浏览器中，并增加意图、规格、交付、讨论、队列与自动化等工程化能力。各厂商的登录状态与 c3 账号独立。宿主 CLI 解析不到则该厂商不可用，c3 不会假装能跑。

---

> 同步说明：本文档的安装、升级、启动命令以仓库英文 README 为事实来源。当 README 更新时，本文档应对应更新以保持一致。
