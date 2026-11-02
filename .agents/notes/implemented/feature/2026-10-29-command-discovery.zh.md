# Pi 命令发现

Status: implemented
Translation: current

[English](2026-10-29-command-discovery.md)

## 决定

[Issue #16](https://github.com/LodyAI/acp-extension-pi/issues/16)：适配器能执行
命令，但没有发布目录。共用的会话准备流程现在查询原生 `get_commands`，加入
适配器实现的 `stats`、`compact`，按实际执行顺序让这两项优先，并排除私有
steering 命令。原生命令描述可省略，名称必须是非空字符串。发现失败会明确
终止激活，不伪装成空目录。

同一份数组写入会话响应，并通过标准 ACP `available_commands_update` 等待
发送完成。两条出口均有实际消费者：Lody 能力探测只读取响应，ACP 客户端读取
通知。Load 保留响应字段。不保存第二份目录，不延时补发，不在每次 prompt 前
查询，不加版本分支或扩展来源黑名单。Pi disposition 和取消的现有职责不变；
任意 TUI、后台脱离执行的插件兼容不属于本次修改。

## 验证

macOS 上 `pnpm check` 通过（118 项测试，跳过一项 Windows 专属测试），
`pnpm build` 和普通工具、仅 codemode 两种模式的 `pnpm smoke` 均通过。
未在本地验证桌面 UI 或 Windows。

现有 wire 测试覆盖命令发现、重名优先级、私有命令排除、激活时刷新和明确失败。
官方 CLI smoke 检查激活时响应与通知目录一致，再执行目录中一个无需启动模型
即可完成的扩展命令。原有 stats/compact smoke 保留。历史断言排除命令元数据，
原有消息和工具顺序保护不变。没有删除行为测试。

托管运行时重新打包发布独立于本次源码修改。
