# Agentloom

Agentloom 是使用 Deep Agents SDK 和 PostgreSQL 的单进程 Agent 后端。运行环境为 Node.js 24.16.0、pnpm 11.7.0；认证使用可信签发端生成的 HS256 JWT，`sub` 是全局唯一的用户标识。模型配置和新输入调用方式见[模型配置与 API 使用说明](docs/model-configuration.md)。

## 人工审批

`echo` 工具必须由会话所属用户批准或拒绝。仅允许 `approve`、`reject`，不提供参数编辑或独立审批角色。更新到当前 schema 需要执行 `pnpm db:init`；该命令会删除并重建整个目标数据库，清空所有会话、模型配置、审批审计和 checkpoint。

提交新输入后，如果模型请求 `echo`，工具在批准前不会执行。请求返回 `awaiting_approval` SSE，然后以 `end`（`status: awaiting_approval`）正常结束。等待期间没有活跃调用或执行超时，不需要保持连接；普通新输入和 `/continue` 都不能绕过审批。

即使没有收到待审批事件，也可以使用所属用户的 JWT 查询：

```sh
curl "$API_URL/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $TOKEN"
```

响应包含 `awaitingApproval`、`active`、`canApprove`、`approvals` 和 `approvalAudit`。待审批项示例：

```json
{
  "interruptId": "从当前查询响应获取的中断ID",
  "decisionStatus": "pending",
  "actions": [
    {
      "toolName": "echo",
      "argumentSummary": "待回显文本的前200字符",
      "allowedDecisions": ["approve", "reject"]
    }
  ]
}
```

参数摘要只是预览，不是完整参数。接口不返回完整图状态或 SDK 中断内容。

用当前中断 ID 提交决策，响应沿用执行 SSE：

```sh
curl -N -X POST "$API_URL/conversations/$CONVERSATION_ID/approvals" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"interruptId":"从当前查询响应复制","decisions":[{"type":"approve"}]}'
```

拒绝时把 `approve` 换成 `reject`。一个中断可能包含多个待审批工具调用，`decisions` 必须与查询中 `actions` 的顺序和数量一一对应；例如 `[{"type":"approve"},{"type":"reject"}]` 表示批准第一个、拒绝第二个。拒绝使当前工具调用不执行，并把拒绝结果交给模型；模型再次请求该工具时需要新的审批。

审批使用该会话已保存的执行模型配置，不接收新输入或模型覆盖。每次审批恢复使用新的模型／工具调用限额和计时。未认证请求返回 401，其他用户访问返回 404；已关闭、正在执行、过期中断以及重复或冲突决策返回 409，非法决策和数量不匹配返回 400。

审批审计只记录会话、中断 ID、决策、可信操作者和时间，可以通过会话查询中的 `approvalAudit` 查看。审计在 SDK 恢复前写入，只证明服务已接收决策，不证明 SDK 已应用决策或工具已执行。审计写入失败时不会恢复执行。

如果进程在审计写入后、SDK 应用决策前中断，同一审批仍待处理时会返回 `decisionStatus: unconfirmed`、`canApprove: false`。再次提交批准或拒绝均返回 409 `Decision outcome unconfirmed`。服务不重发、不补偿；可以继续查询，或取消后创建新会话。

## 等待、重启与取消

重启服务不会自动执行任务。尚未提交决策的审批保存在 PostgreSQL checkpoint 中，重启后先查询，再提交当前决策。已完成的审批审计不会因重启而丢失。

所属用户可以关闭会话，包括等待审批的会话：

```sh
curl -X POST "$API_URL/conversations/$CONVERSATION_ID/cancel" \
  -H "Authorization: Bearer $TOKEN"
```

取消先持久化关闭标记，再通知在途调用停止。响应中的 `active: true` 表示执行仍在收尾；关闭不撤销已发生的工具调用。关闭后禁止输入、继续和审批，已有内容仍可查询。审批与取消共用会话准入锁；关闭之后不再接纳执行。

审批前的正常 SSE 关流不会关闭会话。执行期间断线会请求停止当前调用；重新连接后先查询，不自动重发输入或决策。人工批准不保证有外部副作用的工具只执行一次；当前 `echo` 没有外部副作用。

## Checkpoint 保留与运维清理

首版没有自动过期时间或后台清理：checkpoint 和审批审计一直保留，直到运维主动清理。关闭会话也不会删除 checkpoint。

清理单个会话时，先通过 API 确认会话已关闭，再停止唯一 API 进程，避免与在途工作并发。构建后通过官方 saver 的公开 `deleteThread` 方法删除该会话的全部 checkpoint，不直接操作 SDK 内部表：

```sh
pnpm build
node --env-file=.env --input-type=module <<'JS'
import { createDatabase } from './dist/database/client.js';
const database = createDatabase(process.env.DATABASE_URL);
try {
  await database.saver.deleteThread('替换为已关闭的conversationId');
} finally {
  await database.close();
}
JS
```

删除 checkpoint 不可恢复，该会话的历史消息与中断将无法查询；业务关闭标记和最小审批审计仍然保留。清理后可以重新启动 API。开发环境需要全部重置时使用 `pnpm db:init`，它会连同业务数据和审计一起清空整个数据库。
