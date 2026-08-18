# files — Overview

## Purpose

files domain 让浏览器能检视当前已注册工作区内的文件,使用户
无需离开 c3 就能浏览项目文件。

## Scope

- 针对一个已注册工作区的只读目录列表、文本文件读取、以及文件搜索。
- 仅限工作区相对路径。
- 对所有文件系统访问强制执行安全边界。

## Out of scope

- 编辑、写入、删除、移动或创建文件。
- 跨工作区浏览。
- Git diff、blame、符号导航、语言索引或语义搜索。
- 隐藏非 `.git` 的敏感文件如 `.env`;这一可接受风险记录在
  [security](../../../non-functional/security.md) 中。

## Documents

- [files-spec.md](files-spec.md) —— domain 行为与不变式。
- [files-design.md](files-design.md) —— 实现契约与 API 形状。
- [files-models.md](files-models.md) —— 工作区相对文件结果形状。
