# Agentloom

Agentloom 是使用 Deep Agents SDK 和 PostgreSQL 的单进程 Agent 后端。运行环境为 Node.js 24.16.0、pnpm 11.7.0；认证使用可信签发端生成的 HS256 JWT，`sub` 是全局唯一的用户标识。模型配置和新输入调用方式见[模型配置与 API 使用说明](docs/model-configuration.md)。

## 范围与部署约束

首版支持 HS256 JWT 认证、用户会话隔离、全局模型配置、持久化状态查询、SSE、调用限额、显式继续、取消和人工审批。服务只运行一个 API 进程、一个实例；不要使用 cluster、多 worker、多个 Compose 项目共享业务库或扩容 API。Provider 和模型配置由所有认证用户共享并可管理，暂不区分管理员。

不提供自动恢复、任务队列、逐次执行归档、历史快照浏览、SSE 重放、长期记忆、任意代码执行或 Agent 安全沙箱。重启不会自动调用模型或工具。

## 从干净检出启动

需要 Git、Node.js 24.16.0、pnpm 11.7.0、Docker 和 Docker Compose 2.24.4 及以上版本。普通检查和集成测试无需真实模型 Key；通过 API 交互执行需要配置可用的模型服务。

```sh
git clone https://github.com/jackjieYYY/agentloom.git
cd agentloom
corepack enable
pnpm install --frozen-lockfile
node --import tsx scripts/init-env.ts
```

初始化环境脚本生成独立的 PostgreSQL 密码、JWT 签名密钥和模型凭证加密密钥，写入权限为 `0600` 的 `.env`，已有值会保留。不要提交或共享 `.env`；保留它与数据库卷，单独备份 `MODEL_CREDENTIALS_KEY`。丢失或替换加密密钥后，已有 provider 凭证无法解密，需要重新录入。

Docker 部署使用以下命令：

```sh
docker compose build api db-init
docker compose up -d --wait postgres
# 仅在首次准备或主动清空数据库时执行；会删除整个 database。
docker compose run --rm db-init
docker compose up -d --wait api
curl --fail http://127.0.0.1:3000/health/ready
```

`db-init` 是按需运行的工具服务，执行同一个 `pnpm db:init`，不会随 `docker compose up` 启动。API 使用非 root 用户运行，仅包含生产依赖和编译产物，启动时不初始化数据库。Compose 将 PostgreSQL 和 API 分别绑定到本机 `5432`、`3000`；API 使用容器内的 PostgreSQL 地址。API 限制为 1 CPU、1 GiB 内存及 128 个进程，停止宽限期为 15 秒，服务内部退出上限为 10 秒。

`pnpm db:init` 每次都会强制断开连接，删除并重建 `DATABASE_URL` 指向的整个数据库，清空所有业务数据及 checkpoint。只指向专用数据库，账号需有删库、建库和终止连接权限。开发阶段只初始化当前结构，不维护版本迁移；日常启动和重建容器时不要重复初始化。

更新或重启时保留 PostgreSQL 命名卷：

```sh
docker compose up -d --build --wait api
docker compose down
docker compose up -d --wait
```

`down` 保留卷，会话、已保存结果及待审批内容仍在。`down --volumes` 会删除数据库卷。生产入口需要另行配置 HTTPS 反向代理，CORS 由代理统一处理；转发 SSE 时关闭缓冲。

## 本地开发

使用同一份 `.env`，只在 Docker 中运行 PostgreSQL，API 在宿主机运行：

```sh
docker compose up -d --wait postgres
# 首次准备数据库，或明确需要清空时执行。
pnpm db:init
pnpm dev
```

使用本地 API 前先停止 Compose API，避免占用同一个端口或同时执行：`docker compose stop api`。验证生产编译产物可用 `pnpm build && pnpm start`，不需要 TypeScript 运行器。默认监听 `127.0.0.1:3000`；`HOST`、`PORT` 可通过环境变量覆盖。`/health/live` 检查进程响应，`/health/ready` 会实际查询 PostgreSQL；二者不需要认证。

## 认证、输入与 SSE

可信签发端与服务端共享 `AUTH_JWT_SECRET`，仅允许 HS256，必须包含未过期的 `exp` 和全局唯一的 `sub`，存在 `nbf` 时也会校验。`sub` 为 1–200 字符且不能全为空白。服务没有开发身份绕过；请求体或自定义用户标识 header 不参与身份判断。

本地验证可以用 `.env` 中的服务端密钥生成短期 JWT；不要把该密钥分发给浏览器：

```sh
export API_URL=http://127.0.0.1:3000
export TOKEN="$(node --env-file=.env --input-type=module <<'JS'
import { SignJWT } from 'jose';
console.log(await new SignJWT({ sub: 'local-user' })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET)));
JS
)"
```

先按[模型配置文档](docs/model-configuration.md#配置管理-api)创建 provider 和模型，将返回的 `modelConfigId` 保存为 `MODEL_CONFIG_ID`。所有配置管理接口同样要求 JWT；响应不包含 API Key。

```sh
export MODEL_CONFIG_ID='替换为modelConfigId'
curl --fail -X POST "$API_URL/conversations" \
  -H "Authorization: Bearer $TOKEN"
export CONVERSATION_ID='替换为响应中的conversationId'

curl -N --fail -X POST "$API_URL/conversations/$CONVERSATION_ID/input" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"text\":\"请使用 echo 回显 hello\",\"modelConfigId\":\"$MODEL_CONFIG_ID\"}"
```

每次新输入都必须提交 `text` 和 `modelConfigId`，后端不保存默认模型，也不会回退上一轮选择。模型是否请求 `echo` 由模型决定。`curl -N` 禁止客户端缓冲；SSE 包括 `message`、`tool`、`awaiting_approval`、`completed`、`error` 和最终 `end`，其中 `end.status` 表示本次调用结束状态。HTTP 已开始返回流后，通过 SSE 的错误及结束事件判断结果。

查询读取最新保存的内容，不触发执行，也不证明某次提交已经保存或完成。流中增量可能尚未持久化；断线后先查询，不重放或自动重发输入。查询中的 `active`、`canSubmit`、`canContinue`、`canApprove` 表示当前允许的操作。存在普通未完成任务时可显式继续：

```sh
curl -N --fail -X POST "$API_URL/conversations/$CONVERSATION_ID/continue" \
  -H "Authorization: Bearer $TOKEN"
```

继续不接受新输入或模型覆盖，使用已保存的执行模型配置 ID 及其当前配置，可能重新执行尚未保存完成的工作。无未完成任务、会话正在执行、等待审批或已关闭时会被拒绝。后续新输入保留历史；所属会话列表通过 `GET /conversations?limit=20` 查询，并可使用返回的 `nextCursor` 分页。

每次输入、继续或审批分别使用新的限额和计时，默认模型调用 10 次、工具调用 20 次、活跃超时 120000 毫秒，可通过 `AGENT_MODEL_CALL_LIMIT`、`AGENT_TOOL_CALL_LIMIT`、`AGENT_TIMEOUT_MS` 配置。不自动重试，不承诺跨请求或跨重启的累计预算。超时、上限或活跃断线请求停止当前调用，调用实际结束前不能再执行；这些操作不会关闭会话。

## 检查与故障排查

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
# 必须使用可被删除并重建的独立 PostgreSQL 测试数据库。
TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/agentloom_test pnpm test:integration
# 需要 Docker；使用独立 Compose 项目、随机凭证及随机端口，结束后清理测试卷。
pnpm exec tsx tests/docker.smoke.ts
```

`test:integration` 先构建，再由应用组装函数注入共享 fake 模型，对编译产物验证认证、执行、SSE、审批和恢复。镜像 smoke 仅验证构建、非 root、健康、保留卷重建后的会话／结果／待审批查询及 SIGTERM；fake 模型与测试依赖留在宿主机，不进入生产镜像。GitHub Actions 运行上述检查，不需要真实模型 Key。

- 启动失败或容器不健康：运行 `docker compose ps`、`docker compose logs api postgres`。`Invalid configuration` 只列出非法字段；确认 `.env` 已生成，端口没有被占用。
- ready 返回 503：检查 PostgreSQL 健康、网络和凭证。修改 `.env` 中的密码不会修改已有卷里的数据库密码；恢复正确凭证，不要为排障直接删除卷。
- 数据库表不存在：空库尚未初始化。先停止 API，确认允许清空目标库后执行初始化命令；API 不会自动补建 schema。
- 401：检查 Bearer JWT 的签名、`exp`、`sub`、可选 `nbf` 和服务器时间。404 也可能表示资源属于其他用户。
- 400：检查请求字段，接口拒绝未知字段。409：先查询会话，按当前状态继续、审批或创建新会话，不盲目重发。
- 模型配置相关 503：检查 `MODEL_CREDENTIALS_KEY` 是否与录入时一致；不可用模型返回 404。模型和工具错误只提供脱敏摘要，用响应或 SSE 的 `requestId` 关联日志。
- SSE 没有增量：使用 `curl -N`，检查反向代理缓冲与超时；连接结束后查询已保存状态。待审批正常关流，后续操作见下文。

## 人工审批

`echo` 工具必须由会话所属用户批准或拒绝。仅允许 `approve`、`reject`，不提供参数编辑或独立审批角色。

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
