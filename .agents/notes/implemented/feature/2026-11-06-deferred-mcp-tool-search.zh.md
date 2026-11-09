# 通过 Pi MCP 扩展按需加载 MCP

Status: implemented
Translation: current

[English](2026-11-06-deferred-mcp-tool-search.md)

## 决定

适配器原来自带 MCP 桥：会话开始前连接所有选中的服务器，并把全部工具直接声明
给模型。任何一个服务器失败都会让整个激活失败，报错为 "Required Lody Pi
extension did not initialize"（[issue #30](https://github.com/LodyAI/acp-extension-pi/issues/30)）。

现在打包的扩展直接运行 Pi 1.4 的 `createMcpExtension` 和
`createToolSearchExtension`，并对每个 ACP 选中的服务器调用
`pi.registerMcpServer(name, { ..., exposure: "deferred" })`。模型先看到
`tool_search` 和 Pi 的 `mcp_servers` 提示段，搜索后才声明匹配的
`mcp__<server>__<tool>` 工具。这和 Lody 中 Codex 的做法一致，Codex 的 MCP 工具
也通过 tool search 延迟加载。连接、后台启动、命名、结果转换、截断、超时、
`/mcp` 以及让已加载工具在 resume 和 fork 后保留的会话记录，都由 Pi 负责。

保留的边界：

- `loadConfig` 不返回任何服务器，全局和项目 `mcp.json` 都不读取，会话只使用
  Lody 选中的服务器。`--no-extensions` 不变。
- ACP 传入的 env 和 header 值已是最终值。Pi 会展开 `$NAME`/`${NAME}`，并执行
  以 `!` 开头的值，所以适配器把 `$` 转义为 `$$`，开头的 `!` 转义为 `$!`。
- Lody 的显示名映射到 Pi 允许的 `[A-Za-z0-9_-]`。映射后冲突的名字（`-` 与 `_`
  视为相同）都加上由服务器名和目标计算的 6 位哈希，这样 resume 时即使选择顺序
  变了，会话记录里的 `mcp__<server>__*` 工具仍指向同一服务器，与 Codex 一致。
  只有完全相同的重复项才退回数字后缀。注册失败作为 Pi 配置错误只报告一次。
- 客户端以 `override` 模式传入的系统提示词（ACP `systemPrompt`）会替换 Pi 的提示词，
  `mcp_servers` 段也会随之丢失。workspace 钩子会把它重新接在客户端文本之后；
  Claude Code 和 Codex 同样把延迟加载工具的信息放在可替换的指令之外。
- `openUrl` 不做任何事（RPC 模式没有浏览器），服务器日志写在本次激活的私有
  临时目录。
- stdio 服务器继承 Pi 进程的环境变量，与原生 Pi 相同。原来 SDK 的白名单并不
  提供保护：Pi 的 bash 工具和用户的本地服务器本来就以同样的权限运行。

替换中的运行时在新 ACP id 确定之前发出的通知会先缓存，等激活准备完成后再发布。

已删除：手写的 SDK 桥、它的工具重新激活逻辑和对应单元测试。
`@modelcontextprotocol/sdk` 只保留给 smoke 的 fixture 服务器使用。

不在本次范围：会话中途修改 MCP（在下一次 new/resume/load/fork 时生效）、
交互式 OAuth 登录、默认使用 codemode、子 agent 使用 MCP。

## 验证

macOS 上 `pnpm check` 通过（136 项测试，跳过一项 Windows 专属测试），
`pnpm build` 和普通工具、仅 codemode 两种模式的 `pnpm smoke` 均通过。

单元测试用 Pi 自己的解析器和校验器检查转义后的值和注册配置，检查名称映射，
并检查无效服务器只产生一条通知且不泄露 header 值。wire 测试检查替换中的运行时
发出的启动通知会送达新的激活；去掉缓存后该测试失败。

MCP smoke 阶段使用官方 CLI，同时放置全局和项目 `mcp.json`，并在 fixture 旁边
加一个无法启动的服务器。断言包括：首次请求只声明 `tool_search`；`mcp_servers`
段列出 fixture；搜索后下一次调用声明 `mcp__fixture__echo`；`mcp.json` 中的服务器
从不出现；失败的服务器只产生一条通知；`/mcp` 报告
`fixture: connected, 4 tools (deferred)`；resume 后已加载的工具仍被声明。原有的
MCP 图片和错误断言改用新名称；resource link 现在以文本交给模型；包含 `!`、
`$HOME`、`${PATH}`、`$$`、`$!` 的 env 值原样到达服务器；客户端 `override` 提示词下，
系统提示词以客户端文本开头，并且仍包含 `mcp_servers` 段。把 exposure 改为
`direct`，或去掉重新追加的这一段，都会让 smoke 失败。

本记录未在 Lody 桌面端通过 Custom ACP Provider 验证。
