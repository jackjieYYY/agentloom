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

## 消息、流和恢复

| 功能           | 使用的公开 SDK 机制                                                       |
| -------------- | ------------------------------------------------------------------------- |
| 聊天历史       | 每个聊天独立的 `configurable.thread_id`，使用 PostgreSQL checkpointer     |
| 查询           | `agent.graph.getState()`，只读取最新保存状态                              |
| 新输入         | `agent.stream({ messages }, config)`，沿用相同 thread 的历史              |
| 错误后继续     | `agent.stream(null, config)`，不传历史 checkpoint ID                      |
| 待审批中断     | 读取 SDK task interrupts；不把普通 continue 当成 `Command({ resume })`    |
| 流式输出       | SDK `messages` 与 `updates` 流模式，服务端投影成脱敏 SSE                  |
| 文本与消息类型 | SDK `message.text`、`isHumanMessage`、`isAIMessage`、`isToolMessage`      |
| 停止           | 向 SDK 传递 `AbortSignal`，等待流、hooks 和模型生命周期结束后释放活跃记录 |
| 持久性         | 执行设置 `durability: 'sync'`；沿用官方 saver 的初始化与连接池            |

没有自写的消息内容解析器或第二套消息历史。`message.text` 通过 SDK 的标准内容块提取文本，思考块、工具参数和其他内部内容不进入公开文本响应。API 的 SSE 是业务投影，客户端使用 `fetch` 读取；未宣称兼容 Agent Server 的 HTTP 协议或 `useStream`。

LangGraph 的新输入、错误后继续、审批恢复和历史重放语义不同，不能只凭相同 thread ID 判断为恢复。进程重启不自动执行任务；取消聊天先保存关闭状态再请求停止，停止信号不代表在途工作已经结束。

开发阶段改变图结构后不承诺旧的未完成 checkpoint 跨版本恢复；需要保留的状态必须另行验证。服务不会自动清空数据库或重提输入。

参考：[Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)、[Messages](https://docs.langchain.com/oss/javascript/langchain/messages)、[Streaming](https://docs.langchain.com/oss/javascript/langchain/streaming)。

## 执行生命周期与停止

执行服务通过 `execute(id, identity, input, consume)` 持有整个执行作用域。新输入为 `{ text, modelConfigId }`，继续执行传 null。归属、状态和模型准入仍在每聊天锁内串行进行，锁在准入后释放；其他聊天独立运行，同一聊天的第二次执行返回 409。HTTP 层只在 `consume` 中初始化 SSE、消费 `call.stream(send)` 并关闭响应，不接管一个已登记但尚未启动的调用。即使响应初始化失败，也由执行服务的外层 `finally` 排空工作并释放活跃记录。

| 所有者             | 职责                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ |
| `AgentInvocation`  | 模型实例、独立预算、取消信号、超时、middleware 工作登记、模型回调登记、排空与 `done` |
| `execution.ts`     | 归属与准入、活跃槽位、SDK 流与状态投影、执行作用域、停止接收执行并等待准入和活跃调用 |
| 会话路由           | 输入校验、SSE 响应头与编码、背压、断线通知与响应关闭                                 |
| Fastify / shutdown | `preClose` 停止执行，等待请求后在 `onClose` 关闭连接池；外层 10 秒硬截止             |

`callModel` / `callTool` 通过公开 wrap hooks 登记 handler Promise，调用前检查取消信号与预算。模型另外用官方 `handleChatModelStart`、`handleLLMEnd`、`handleLLMError` 按 run ID 登记和解除等待。这两项跟踪不能互相替代：锁定 SDK 的 Agent 模型节点使用 `raceWithSignal`，取消可先结束 handler 的等待，而底层模型稍后才报告结束／错误。工具 handler 在锁定 SDK 中会等待实际工具调用结束。

生命周期 callbacks 显式设置 `awaitHandlers = true`，使开始与结束登记不依赖全局后台回调队列的调度。回调只做短小的登记操作，不在开始回调中等待模型完成。不使用 `awaitAllCallbacks()` 作为本次执行的结束条件：它等待全局回调队列，既不隔离聊天，也不代表尚未提交结束回调的模型已经结束。

停止顺序为：请求取消 → 消费 SDK 流退出（包含 SDK 已登记的 checkpoint 写入）→ `waitForIdle()` 等待模型与工具工作排空 → 发送结束事件并关闭响应 → 完成本次 invocation 并释放活跃槽位。输出失败时先请求取消，再退出迭代器，避免迭代器关闭等待仍运行的图。计时器覆盖响应收尾期间的背压等待；最终完成通知也包含传输收尾。`run()` 的外层清理负责覆盖传输初始化、消费和收尾抛错的路径，不依赖 `afterAgent` 执行。

服务停止先关闭执行准入并通知活跃调用取消，然后等待已经进入准入锁的数据库／checkpoint 操作，最后等待 invocation 完成；准入在所有异步检查后再次检查关闭状态，避免关闭期间启动新 Agent。取消是协作式的，忽略信号且一直不结束的工作会继续占用槽位，进程退出由既有硬截止处理，不提前遗忘仍在运行的工作。

这套作用域归属是本项目的工程约定，官方 SDK 提供 context、wrap hooks、callbacks 和 signal 扩展点，并未提供或要求应用采用同名生命周期类。核心测试覆盖后台回调队列阻塞时的模型排空、排空期间新增工具工作、响应初始化失败、结束输出阻塞、准入与关闭竞态。

参考：[Custom middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/custom)、[BaseCallbackHandler](https://reference.langchain.com/javascript/langchain-core/callbacks/base/BaseCallbackHandler)、[awaitAllCallbacks](https://reference.langchain.com/javascript/langchain-core/callbacks/promises/awaitAllCallbacks)。

## Provider 与应用层的边界

模型通过公开集成类创建，`openai` 使用 `ChatOpenAI`，`openai-compatible` 使用公开导出的 `ChatOpenAICompletions` 固定协议。模型与底层客户端都显式关闭重试。兼容地址不等于兼容全部模型特性；目标模型必须支持工具调用，启用前应验证流、工具消息和已有上下文。厂商专有功能需要对应的集成与测试，不能仅通过替换地址保证兼容。

以下属于应用业务规则，官方 SDK 不替应用定义：

- 用户权限、Provider / ModelConfig 数据表、凭证加密及管理入口。
- 每次新输入由前端显式指定模型；全局和聊天默认选择均由前端维护，后端不保存默认值。
- 保存实际模型引用，未完成任务继续使用原配置，凭证可以轮换。
- 每聊天单个活跃调用、显式继续、无自动 fallback、脱敏 HTTP / SSE 返回。

这些规则继续保留；数据库与 API 无需为了 middleware 机制而重做。API 的完整用法见 [模型配置文档](model-configuration.md)。

参考：[Chat model integrations](https://docs.langchain.com/oss/javascript/integrations/chat#chat-completions-api)。
