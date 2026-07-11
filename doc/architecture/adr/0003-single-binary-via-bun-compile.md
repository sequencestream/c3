# 0003 — 通过 `bun build --compile` 生成单一二进制

- **Status:** accepted
- **Date:** 2026-05-29

> **Evolution (2026-06-05, [ADR-0010](0010-release-and-distribution-trust.md)):** 单二进制
> 的决策维持不变。下文的**构建机制**——生成内嵌 web-asset 模块，再在清理步骤中把它重置为空
> 存根——已被**取代**：它在共享文件上引发了并行构建竞争。内嵌资源现在作为一次性生成的快照
> 存放在源码树之外，编译路径通过一个 `Bun.build` 的 `onResolve` 插件重定向到该快照，源码树
> 内的内嵌文件永久保持一个已提交的空存根。注意：该存根是**已提交、非 gitignore**的(下文
> “gitignore”的措辞早于本次演进，对该存根从未准确)。原始决策理由保持不变。

## Context

c3 应当能在开发者机器上轻松运行，无需完整的 Node 工具链或依赖安装。前端是构建好的 web
包；服务端是 TypeScript。我们希望有一个用户可以放到主机上直接运行的产物。

## Options considered

- **发布 Node CJS 包 + 构建好的 web-asset 目录。** 优点：标准、构建简单。缺点：需分发多
  个文件；需要 Node 与一个静态目录服务。
- **`pkg`/`nexe` 风格的 Node 打包器。** 优点：单文件。缺点：工具链老化、原生模块摩擦、
  产物体积大。
- **`bun build --compile`。** 优点：单一自包含可执行文件；可通过 Bun 的文本导入机制内联
  web 资源。缺点：需要主机上有 `bun`；SDK 内置的按平台查找 CLI 的机制在单文件二进制内部
  会失效。

## Decision

用 `bun build --compile` 构建单一二进制。将构建好的 web 资源内联进一个生成的内嵌模块
(已 gitignore，每次构建后重置为空存根)。由于 SDK 无法在二进制内部找到其内置的 CLI，
从 `CLAUDE_PATH` 覆盖项或 PATH 中解析系统 `claude` 可执行文件，并通过 SDK 的显式可执
行文件路径选项(`pathToClaudeCodeExecutable`)传给 SDK。

## Consequences

- **Easier:** 分发——一个文件加一个主机已安装的 `claude`。
- **Harder:** 主机需要 `bun`(默认 `~/.bun/bin/bun`，可通过 `BUN_BIN` 环境变量覆盖)与
  一个已登录的 `claude`。跨目标构建通过 `BUN_TARGET` / `BUN_OUTFILE` 环境变量设置。
- Node CJS 包路径依然可用，在内嵌资源环境变量为空时回退为从文件系统提供构建好的 web
  资源。

## Compliance

- 内嵌模块保持 gitignore。
- `claude` 可执行文件的查找归服务端的宿主二进制解析所有。

## References

- `README.md` § Single binary
- `doc/domains/core/agent-session/agent-session-design.md`
