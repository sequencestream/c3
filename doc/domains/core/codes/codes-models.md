# codes — Models

## Code Workspace

codes domain 所见的一个已注册工作区。浏览器通过服务端签发的工作区 id
识别它;文件系统根目录只在服务端解析。

## Relative Path

在某个 Code Workspace 下解释的一个路径。它永远不是绝对路径,永远不允许包含父级
遍历,若其解析目标离开工作区根目录则被拒绝。

## Code Directory Entry

目录列表返回的一个直接子项。

| Field | Meaning                                      |
| ----- | -------------------------------------------- |
| name  | 浏览器中显示的基础名。                       |
| path  | 用于后续读取的工作区相对路径。               |
| type  | `file` 或 `directory`;其他文件系统种类省略。 |

## Code File Read

一个文件的元数据与可选内容。

| Field     | Meaning                               |
| --------- | ------------------------------------- |
| path      | 工作区相对文件路径。                  |
| size      | 磁盘上的字节大小。                    |
| binary    | 检测到的前缀是否表明为二进制内容。    |
| truncated | 内容是否因体积过大而被扣留。          |
| content   | 文本内容,仅对符合条件的文本文件存在。 |

## Code Search Hit

一条有界搜索结果。

| Field    | Meaning                                  |
| -------- | ---------------------------------------- |
| path     | 工作区相对结果路径。                     |
| type     | `file` 或 `directory`。                  |
| line     | 内容命中的从 1 开始的行号。              |
| lineText | 内容命中的匹配行。                       |
| match    | 已知代价低时给出的匹配片段或文件名片段。 |
