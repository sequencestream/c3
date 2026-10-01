# files — 领域规格

## Overview

files 让人在已登记工作区内只读检视仓库：看树、读文本、有界搜索、看工作树状态，并内嵌工作会话就代码提问。

**范围:** 单一已登记工作区的只读目录与文件、有界搜索、工作树状态、内嵌工作会话。
**边界:** 不编辑仓库；不列分支与提交、不展示版本间 diff、不 blame、不符号导航；单次请求不跨工作区；不扫描密钥。内嵌会话的运行与权限见 [agent-session](../agent-session/agent-session-spec.md) 与 [permission-gateway](../permission-gateway/permission-gateway-spec.md)。

实体见 [files-models.md](files-models.md)。能力索引见 [features.md](../../../features.md) 的 files 节。

## Business rules

### 只读与信任根

- **FILE-R1**: 本域所有请求只读。不得创建、编辑、删除、重命名或以其他方式变更工作区文件。
- **FILE-R2**: 信任根由服务端拥有。请求以已登记工作区的不透明身份标识根；伪造或未登记的身份拒绝，且不得当作文件系统路径。
- **FILE-R3**: 请求路径相对该根。解析后落在根外的路径一律拒绝；符号链接按解析后的目标判定。
- **FILE-R4**: `.git` 不出现在目录、读取与搜索结果中。
- **FILE-R7**: 返回路径相对工作区根，且须通过同一根守卫。
- **FILE-R8**: 已登记工作区内非 `.git` 的敏感文件（如 `.env`）对本地所有者可读。本域不扫描密钥、不按文件策略过滤。跨域路径约束见 [SEC-11](../../../non-functional/security.md)。拒绝与失败不回显绝对路径。

### 仓库浏览

列出直接子项、读取文本文件。二进制或超过体积上限的文件只返元数据，不返内容（**FILE-R5**）。可按文件名或内容搜索，结果数量与耗时均有界（**FILE-R6**）。

### 文件树状态

只读快照标出改动、暂存与未跟踪。文件页可见时刷新；离开则停。非 git 或读失败则空快照，不打断树。状态不展开为提交或两版本间的 diff。

### 代码域会话

文件页可内嵌一个普通工作会话就代码提问，可新建或重置。本域不拥有该会话的运行。浏览仍只读；改仓库只经该会话与权限网关。

## Domain events

消费 `list_dir`、`read_file`、`get_file_git_status`、`search_files`。发出 `dir_listed`、`file_read`、`file_git_status`、`files_searched`，或 `error`。形状见[共享协议](../../../shared/api-conventions/websocket-protocol.md)。内嵌会话走既有会话消息，不另开线路。

## Interactions

- **session-registry** — 已登记名称到根路径；本域不解释名称之外的信任根。
- **agent-session** — 内嵌工作会话的运行。
- **web-console** — 发送相对路径的浏览请求并渲染。
- **permission-gateway** — 内嵌会话里的敏感工具，与本域只读浏览正交。
