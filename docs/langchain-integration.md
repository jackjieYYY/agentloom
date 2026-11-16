# LangChain / Deep Agents 接入约定

本项目按官方 JavaScript / TypeScript 接口组装 Agent；当前锁定 `langchain@1.6.3`、`deepagents@1.16.3`、`@langchain/core@1.3.5`、`@langchain/openai@1.8.2` 和 `@langchain/langgraph@1.7.3`。在线文档会滚动更新，使用前同时核对锁定版本的公开类型与运行行为。

## 模型选择与并发

每个应用实例构建一个 Deep Agent，供查询和执行复用。每次执行先完成身份、聊天归属、状态和模型配置校验，再创建独立的 `AgentInvocation`，通过 `context` 传给 SDK。`wrapModelCall` 调用本次 invocation 的 `callModel`，由它检查预算并提供准入时选定的模型；middleware 再调用 `handler({ ...request, model })`，由 SDK 绑定工具并执行模型。

这是官方 [Select a model at runtime](https://docs.langchain.com/oss/javascript/deepagents/models#select-a-model-at-runtime) 的 middleware 模式。模型配置只在本次执行准入时解析一次；不会在每次模型调用时重新读取可能变化的配置。模型客户端不预先绑定工具，不修改共享 Agent 上的当前模型。

`src/agents/invocation.ts` 中的 `AgentInvocation` 独占本次模型、模型／工具预算、取消控制器、计时器、未结束工作与完成通知。它通过 `z.instanceof` 作为 runtime 依赖传递，保持对象身份；不放入输入消息、checkpoint state、工具参数或公开响应。不同聊天的并发调用各有自己的对象；每次显式继续也创建新对象。测试同时检查 checkpoint 数据和元数据不含 invocation 或调用计数。

基础模型使用公开的 `initChatModel` 初始化，显式关闭 configurable fields；其固定名称 `openai:agentloom-runtime` 只用于组装应用的 harness profile，不承担真实模型调用。请求必须通过 context 提供本次模型，缺失或非法 context 会失败。初始化无需业务 provider、真实 Key 或模型网络请求；同一个图的 `getState()` 也不执行模型。

参考：[Runtime](https://docs.langchain.com/oss/javascript/langchain/runtime)、[Dynamic model selection](https://docs.langchain.com/oss/javascript/langchain/models#dynamic-model-selection)。

## 内置能力与调用限额

通过官方 `registerHarnessProfile` 为基础模型注册应用固定的 harness：

- `excludedMiddleware: ['SummarizationMiddleware']` 关闭自动摘要。
- `generalPurposeSubagent: { enabled: false }` 关闭默认通用子 Agent。
- `excludedTools: ['task']` 排除委派工具；保留 SDK 必需的 SubAgentMiddleware scaffolding。

不再用同名空 middleware 覆盖内置行为。保留默认 StateBackend 与工具调用修补、内容兼容处理；没有宿主机文件、Shell 或代码执行能力。以后开放摘要或子 Agent 时，需要一并明确其调用预算，不能让额外模型调用绕过限额。

SDK 提供 `modelCallLimitMiddleware` 和 `toolCallLimitMiddleware`。当前锁定版本的模型限额计数保存在 checkpoint state，`runModelCallCount` 在 `afterAgent` 清零；错误或中断后的恢复不能据此获得本项目要求的独立预算。因此，采用官方公开的 `wrapModelCall` / `wrapToolCall` 扩展点，在本次 runtime 对象中统计调用尝试，并跟踪未结束工作。现有 SDK 探针和执行恢复测试覆盖此差异。

这是一项明确的运行语义选择：不持久化预算，不保证跨调用累计额度。共享 Agent 的闭包中只保存固定配置，不保存用户、模型选择或调用计数。

参考：[Harness profiles](https://docs.langchain.com/oss/javascript/deepagents/profiles#harness-profiles)、[Built-in middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in)。

## 原生输入、事件与恢复

执行直接使用 `agent.streamEvents(input, { version: 'v3', ...config })`。HTTP 请求体采用 SDK 的输入形状；SSE 每个 `data` 是 SDK 产生的 `ProtocolEvent` 经 JSON 序列化后的原值。消息、工具、更新、状态和 lifecycle 事件的内容、顺序与序号均由 SDK 决定。

| 功能           | HTTP / SDK 输入                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| 创建、列出会话 | `POST /conversations`、`GET /conversations`，按 userId 隔离                                          |
| 新输入         | `POST /conversations/:id/runs?modelConfigId=:id`，请求体 `{ messages: [{ role: 'user', content }] }` |
| 普通继续       | `POST /conversations/:id/runs`，请求体 `null` 或空请求体；SDK 输入为 `null`                          |
| 审批恢复       | 同一运行接口，请求体 `{ resume: { [interruptId]: { decisions } } }`，由 `new Command(body)` 恢复     |
| 保存状态       | `GET /conversations/:id`，直接返回 `agent.graph.getState()` 的 snapshot                              |
| 业务信息       | `GET /conversations/:id/metadata`，返回会话记录、active 和 approvalAudit                             |
| 关闭会话       | `POST /conversations/:id/cancel`，保存关闭标记并通知当前调用停止                                     |

新输入仅接受一条用户消息，`content` 原样传递和保存，保留首尾空白、缩进、制表符与换行；全空白或超过 32000 字符返回 400。新输入必须选择模型，继续与审批沿用保存的执行模型配置 ID，不接受覆盖。

前端可以通过 `@langchain/langgraph-sdk/utils` 的 `BytesLineDecoder` 和 `SSEDecoder` 读取 SSE。一次请求对应一次执行，响应结束后读取 snapshot；事件的 `seq` 属于该次 SDK 运行。执行、连接和收尾共用一个调用作用域，客户端断线会请求取消；服务不保留传输事件缓存或自动重发输入。

SDK 输出对会话所属用户完整可见，包括工具参数、工具结果、reasoning、SDK 状态、元数据和执行错误中实际存在的内容。后端不生成摘要 DTO、筛选频道、重编号、改写生命周期或补造事件。认证失败、输入非法和执行准入等 HTTP 错误仍按统一错误处理器返回。

`AgentInvocation` 作为 runtime context 依赖，Provider 凭证在模型客户端中使用；账号密码、应用配置和运行时对象不加入输入或 checkpoint。授权和会话归属仍在服务端校验。

审批直接使用 snapshot 的 `tasks[].interrupts`。其 `id` 为恢复键，`value` 是 SDK 的批量 HITL 请求，包含 `actionRequests` 与 `reviewConfigs`。`interruptOn: { echo: true }` 开放四种原生决策，审批说明使用 SDK 默认的工具名和完整参数；显示折叠由前端处理。决策的数量和顺序对应 `actionRequests`。

- `approve`：按原始调用执行。
- `edit`：使用 `editedAction: { name, args }` 替换调用后执行；工具参数由 SDK 校验。
- `reject`：跳过工具并返回拒绝反馈，可以携带 `message`。
- `respond`：跳过工具，把必填 `message` 作为成功的工具结果返回给模型。

HTTP 边界校验当前批量模式的官方决策结构，请求体传入 `new Command(body)`。执行层使用 `HITLResponse`，审计使用官方 `Decision[]`，保留编辑参数和反馈原文。

`approval_audits` 以会话和中断 ID 为复合主键，保存决策、可信 userId 和时间。准入先验证当前中断与审计，再检查执行模型，随后写入审计并启动 SDK。审计只证明收到决策；若审计已经存在但 checkpoint 仍保留该中断，再次提交返回 409 `Decision outcome unconfirmed`，不自动重发或补偿。客户端结合原生中断与 metadata 中的审计判断待审批状态。

当前锁定 SDK 的原始流在审批时可能将根 lifecycle 标记为 completed；审批中断仍保存在 snapshot 或 updates / values 的 `__interrupt__` 中。SDK 没有输出的事件由前端根据原生状态处理。重启服务只恢复查询能力，不执行模型；普通未完成任务显式传 `null`，审批使用 `Command.resume`。

参考：[Event streaming](https://docs.langchain.com/oss/javascript/langchain/event-streaming)、[Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)、[Human-in-the-loop](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop)。

## 执行生命周期与停止

`execute(id, identity, input, modelConfigId, consume)` 完成业务准入后，将 SDK 原生流交给 HTTP 层消费。每会话的短期准入队列协调执行与关闭；活跃记录保护整个 SDK 运行和收尾，另一执行返回 409。

| 所有者             | 职责                                                              |
| ------------------ | ----------------------------------------------------------------- |
| `AgentInvocation`  | 模型、独立预算、取消信号、超时、hooks 与模型回调登记、排空及 done |
| `execution.ts`     | 归属与准入、模型选择、审批审计、原生流调用、关闭和停止            |
| 会话路由           | 请求校验、SDK Command 构造、SSE 编码、背压和连接清理              |
| Fastify / shutdown | 先停止并排空执行，再关闭 HTTP 连接和数据库；进程保留硬截止        |

调用范围为 `AgentInvocation.run()`：创建 SDK 流，消费事件并等待 `run.output`；输出失败时先取消，再等待 SDK 结束。模型调用和工具工作排空后，释放活跃记录并关闭 HTTP 响应。取消可能先结束 SDK handler 的等待，因此模型生命周期回调仍独立登记底层工作，回调设置 `awaitHandlers = true`，不使用全局 `awaitAllCallbacks()`。

客户端断线、超时、预算耗尽和服务停止不关闭会话，能否继续由保存的 snapshot 决定。关闭会话先持久化关闭标记，再取消在途执行；写入失败不发送取消。服务停止时拒绝新准入，取消活跃执行，等待已经开始的准入和 invocation。协作式取消无法结束的工作由进程硬截止处理。

集成测试通过官方 SSE 解码器读取真实 HTTP 输出，覆盖原始事件相等、原文保存、SDK 状态、四种审批决策、混合批量恢复、完整审计重启持久化、模型切换、断线、预算、取消排空和停止竞态。

参考：[Custom middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/custom)、[BaseCallbackHandler](https://reference.langchain.com/javascript/langchain-core/callbacks/base/BaseCallbackHandler)。

## Provider 与应用层的边界

模型通过公开集成类创建，`openai` 使用 `ChatOpenAI`，`openai-compatible` 使用公开导出的 `ChatOpenAICompletions` 固定协议。模型与底层客户端都显式关闭重试。兼容地址不等于兼容全部模型特性；目标模型必须支持工具调用，启用前应验证流、工具消息和已有上下文。厂商专有功能需要对应的集成与测试，不能仅通过替换地址保证兼容。

以下属于应用业务规则，官方 SDK 不替应用定义：

- 用户权限、Provider / ModelConfig 数据表、凭证加密及管理入口。
- 每次新输入由前端显式指定模型；全局和聊天默认选择均由前端维护，后端不保存默认值。
- 保存实际模型引用，未完成任务继续使用原配置，凭证可以轮换。
- 每聊天单个活跃调用、显式继续、无自动 fallback；HTTP 错误脱敏，SDK 输出原样返回所属用户。

这些规则继续保留；数据库与 API 无需为了 middleware 机制而重做。API 的完整用法见 [模型配置文档](model-configuration.md)。

参考：[Chat model integrations](https://docs.langchain.com/oss/javascript/integrations/chat#chat-completions-api)。
