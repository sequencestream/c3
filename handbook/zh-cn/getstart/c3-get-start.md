# c3 入门指南

## c3 是什么

**c3（Code Creative Center）** 是一个 AI 编程平台，它给 Claude Code 提供了一个**基于浏览器的权限控制台**。每次智能体（agent）要执行敏感操作（写文件、编辑代码、运行 shell 命令）时，会在浏览器标签页中弹出一个清晰的审批面板——你看到**具体哪个工具、什么输入即将执行**，然后选择允许或拒绝。不再需要在终端里跟 prompt 挤在一起，审批体验更清晰、更安全。

但 c3 不止是权限控制。它还把这些能力深集成到软件工程实践中：

- **意图（Intent）管理** —— 你用自然语言表达想法，c3 先帮你把它拆解为结构化的**意图**：每个意图都有明确的范围、依赖关系、可验证的完成标准
- **自动化循环** —— 从规划到实现到验证，作为可重复、可审计的流程自动运转
- **多智能体讨论（Discussion）** —— 编码前让多个 AI 视角碰撞，收敛方案
- **共识投票（Consensus）** —— 关键决策由多智能体投票把关
- **工作区隔离（Worktree）** —— 并行任务在隔离的 git 工作区内运行，互不干扰
- **沙箱执行（Sandbox）** —— 不可信代码在受限环境中运行
- **熔断器（Circuit Breaker）** —— 对智能体的令牌速率进行自动限制与恢复
- **定时任务（Schedule）** —— 长期运行或周期性工作自主推进
- **SDD 原生支持** —— 规范驱动开发作为一等工作流

> **一句话总结：** 以前你用终端跟 Claude Code 对话，c3 把这个体验搬到了浏览器里，同时让 AI 编码变得更可控、更工程化。

![c3 智能体界面](images/c3-agents.png)
![c3 会话界面](images/c3-sessions.png)

---

## 前置准备

### 安装 Claude Code

c3 使用 Claude Code 作为底层智能体引擎。你需要先安装并登录 Claude Code：

```bash
# 安装
npm install -g @anthropic-ai/claude-code

# 登录（会打开浏览器完成认证）
claude
```

> c3 启动后会自动管理 Claude Code 的二进制文件，但首次登录仍需通过 `claude` 命令完成。

### 可选工具

以下工具不是强制安装的，但如果你用对应的代码托管平台，安装后会获得更好的 Git 集成：

- **GitHub CLI** — `brew install gh`，或访问 [cli.github.com](https://cli.github.com/)
- **GitLab CLI** — `brew install glab`，或访问 [gitlab.com/gitlab-org/cli](https://gitlab.com/gitlab-org/cli)

---

## 安装

任选以下一种方式即可。

**Homebrew（推荐 macOS / Linux）：**

```bash
brew install sequencestream/tap/c3
```

**安装脚本（macOS / Linux）：**

```bash
curl -fsSL https://raw.githubusercontent.com/sequencestream/c3/main/install.sh | sh
```

安装到 `~/.local/bin`。可通过 `C3_INSTALL_DIR` 自定义目录，`C3_VERSION` 锁定版本。

**安装脚本（Windows PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/sequencestream/c3/main/install.ps1 | iex
```

安装到 `%LOCALAPPDATA%\c3\bin`。

**手动下载：**

从 [releases 页面](https://github.com/sequencestream/c3/releases/) 下载对应平台的压缩包，解压后直接运行：

```bash
tar -xzvf c3-v0.8.0-macos-arm64.tar.gz
./c3 --port 9000
```

> **macOS 首次启动安全提示：** 手动下载的应用可能触发"无法验证开发者"警告。前往**系统设置 → 隐私与安全性**，找到 c3 点击"仍然允许"。Homebrew 安装不会遇到此问题。

---

## 升级

```bash
c3 upgrade              # 自动下载最新版并替换（不重启进程）
c3 upgrade --check      # 仅对比版本号
c3 upgrade --force      # 重新安装当前版本
```

升级后需执行 `c3 restart` 或退出重新运行以加载新版本。

其他升级方式：`brew upgrade c3`（Homebrew），或重新运行安装脚本。

---

## 启动

```bash
c3 --port 9000
```

打开浏览器访问 **http://localhost:9000**。

| 场景                 | 命令                            |
| -------------------- | ------------------------------- |
| 后台运行             | `c3 --port 9000 --daemon`       |
| 系统服务（开机自启） | `c3 install --port 9000`        |
| 查看帮助             | `c3 --help` / `c3 start --help` |

> `c3 --port 9000` 是 `c3 start --port 9000` 的简写。

---

## 配置智能体（Agent）

c3 通过**智能体（Agent）**来驱动编码工作。首次启动时，c3 会自动创建一个默认的 `claude` 智能体（使用你本地 Claude Code 的配置和登录状态）。

### 查看和配置

1. 打开浏览器访问 **http://localhost:9000**
2. 点击界面右上角的**设置（Settings）**按钮
3. 在 **Agent** 配置中，你会看到一个已有的 `claude` 智能体

### 添加自定义智能体

在 Settings 页面你可以添加更多智能体，比如指定不同的模型或 API 地址：

| 字段     | 说明                                                   |
| -------- | ------------------------------------------------------ |
| 名称     | 显示名称，如"Claude Sonnet"                            |
| 供应商   | `claude`（使用 Claude Code）或 `codex`                 |
| 配置模式 | `system`（使用本地 CLI 配置）或 `custom`（自定义 API） |
| Base URL | 自定义 API 地址（仅 custom 模式）                      |
| API Key  | API 密钥（仅 custom 模式）                             |
| 模型     | 模型名称（仅 custom 模式）                             |

> **提示：** 如果只是使用本地 Claude Code 的默认配置，无需添加智能体——系统自动创建的默认智能体可以直接使用。

---

## 第一次跑通：端到端最小流程

### 第 1 步：启动 c3

```bash
c3 --port 9000
```

看到终端输出 `c3 running at http://localhost:9000` 说明启动成功。

### 第 2 步：打开浏览器

访问 **http://localhost:9000** 进入 c3 界面。

### 第 3 步：创建工作区

点击**新建工作区（New Workspace）**，取个名字（如 `hello-c3`），**目录（directory）**指向你想让 c3 操作的项目文件夹。创建后自动进入该工作区。

### 第 4 步：创建会话

进入工作区后，点击**新建会话（New Session）**，选中它进入对话界面。

### 第 5 步：输入需求

在底部输入框中用自然语言描述你的想法。比如：

> 帮我分析当前项目目录，生成一个 README.md 文件，描述项目用途和结构。

### 第 6 步：观察智能体运行

c3 启动智能体后，你将实时看到：

- **助手消息**逐字流式输出
- **工具调用** — 读文件、写文件、运行命令等每一步都在界面展示
- **权限请求** — 敏感操作（`Write`、`Edit`、`Bash` 等）会弹出审批面板，让你选择**允许（Allow）**或**拒绝（Deny）**

### 第 7 步：查看结果

智能体完成任务后，在界面上查看最终结果，或在项目目录中找到生成的代码文件。

### 🔄 完整流程速览

```
安装 → 启动 c3 → 打开浏览器 → 创建工作区 → 创建会话
    → 输入需求 → 观察运行 → 审批工具调用 → 完成
```

> **小提示：** 第一次跑通时选一个小需求（如生成 README），一两分钟就能走完全程。后续可探索💡**[意图管理](requirement-to-intent.md)**（将复杂需求拆解为可追踪的任务清单）、**多智能体讨论**、**定时任务**等高级功能。

---

## 常见问题

**Q：启动时提示 `command not found`？**

A：Homebrew 安装会自动添加 PATH；脚本安装在 `~/.local/bin`，手动加入：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

写入 `~/.zshrc` 可永久生效。

**Q：macOS 安全提示"无法验证开发者"？**

A：前往**系统设置 → 隐私与安全性**，找到 c3 点击"仍然允许"。

**Q：升级后需要重启吗？**

A：需要。`c3 upgrade` 只替换二进制文件。升级后执行 `c3 restart` 或退出重新运行。

**Q：如何停止 c3？**

- 前台运行：`Ctrl+C`
- 后台运行 / 系统服务：`c3 stop`

**Q：c3 和 Claude Code 是什么关系？**

A：c3 包装了 Claude Code 的 SDK，把终端权限提示搬到了浏览器中，并在此基础上增加了意图管理、讨论、定时任务等工程化能力。Claude Code 的登录状态与 c3 独立。

---

> **同步说明：** 本文档的安装、升级、启动命令以英文 README 为事实来源。当 README 更新时，本文档应对应更新以保持一致。
