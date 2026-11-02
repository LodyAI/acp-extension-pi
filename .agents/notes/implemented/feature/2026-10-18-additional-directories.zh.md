# ACP 额外目录

Status: implemented
Translation: current

[English](2026-10-18-additional-directories.md)

## 合约

基于 84d3c3a / Pi 1.3.0，new/load/resume/fork 接受绝对 cwd 和
additionalDirectories。每次激活替换完整请求目录列表，省略与 [] 均清空。
保留用户原生配置。load/resume 在修改运行时或配置之前验证 native header 的
cwd；接受指向同一目录的符号链接。fork 可以选择独立的目标 cwd。
用户已明确排除从未持久化的空会话恢复和分叉，不为该场景增加实现。

## 所有权

每个活跃原生会话拥有独立官方 RPC 进程和私有 workspace/MCP 配置文件。
原生文件路径直接作为路由键，不进行身份转换。生命周期操作互斥；未指定边界的
分叉占用源配置锁，拒绝正在执行任务的源会话。指定边界时只读取已完成的原生
前缀，不修改或锁住源 runtime。

Packaged extension 在原生 attach 时读取目录快照，通过 before_agent_start
在现有系统提示词后追加目录上下文。Pi 将该系统提示词投影到模型请求而不写入
原生历史。没有用户提示词重放、额外上下文存储或自建 executor，已有系统提示词
和用户资源继续生效。子代理通过显式加载的纯上下文扩展钩子接收相同目录快照，不覆盖用户原生提示词，
原有扩展、MCP、工具隔离和执行所有权保持不变。

未指定边界时调用官方 SessionManager.forkFrom（CLI --fork 的原语）。Core
forkAtTurn 通过独立 SessionManager 的 createBranchedSession 复制选定的原生分支，
再独立启动 RPC。turnId 使用 agent_settled 后的原生 leaf，包含工具结果和压缩条目；
Pi 1.3 的普通助手消息不会触发 entry_appended。内置扩展直接读取 getLeafId，
避免每轮通过 get_entries 传输整段历史并触及 RPC 记录大小上限。不导航或替换源 runtime；
Pi 复制原生条目及其身份，child 获得
新原生 ID/header/path。session_start 钩子通过 Pi 工具 API 补入本次选择的 MCP
工具声明，避免历史工具集合漏掉新 MCP 名称；原生 codemode 可见性与非 MCP 工具
选择继续生效。MCP 与启动 model/thinking 配置仅作用于目标 runtime。
正常 close 清理所有进程组；任一 Pi 意外退出仍使整个连接失败。关闭流程等待已接受
ACP 请求的响应实际写入后才允许进程退出，输出背压下也保留完整启动失败诊断。

## 限制

目录是模型工作区上下文，不是沙箱；原生绝对路径工具和 Bash 保留原权限。
cwd 仍是相对路径基准。额外目录不会触发项目配置或扩展发现。请求目录不持久化、
不由 session/list 回显为持久属性，客户端重新 attach 时必须传完整列表。
恢复和分叉要求已有持久化历史。适配器不锁定不同 ACP 连接同时写同一原生文件
的情况。不修改 Lody pins、不发布。

## 验证

所属单测覆盖绝对路径校验、替换/省略、拒绝 attach 后保留原激活、原生 header/cwd、
分叉身份/历史/源文件不变以及独立 runtime 路由和清理。
官方 CLI smoke 通过本地确定性模型，分别验证普通工具及 codemode-only：模型目录
上下文、Read/Write/Bash 效果、子代理继承、冷热 load/resume、fork 独立 cwd、
父子兄弟隔离、原生历史以及 fork 不发起模型请求。

`test/sessions.test.ts` 验证精确原生前缀和源文件不变；
`test/connection.test.ts` 验证 prompt 完成前发布边界。
`scripts/smoke.mjs` 在后续模型请求被挂起时分叉已完成边界，并验证子会话实际
发送给模型的上下文及源会话独立继续执行。本地未执行 Linux 或 Windows 验证。
