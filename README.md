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
curl --fail http://127.0.0.1:3000/health
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

使用本地 API 前先停止 Compose API，避免占用同一个端口或同时执行：`docker compose stop api`。验证生产编译产物可用 `pnpm build && pnpm start`，不需要 TypeScript 运行器。默认监听 `127.0.0.1:3000`；`HOST`、`PORT` 可通过环境变量覆盖。`GET /health` 实际查询 PostgreSQL，成功返回 200，失败返回 503，无需认证。

## 认证、原生输入与事件流

先通过 `POST /auth/register` 注册邮箱和密码，再通过 `POST /auth/login` 获取 `accessToken`。后续请求携带 `Authorization: Bearer <accessToken>`，账号信息通过 `GET /auth/me` 查询，令牌过期后重新登录。所有会话接口均验证账号和资源归属。

创建 Provider 和模型后保存返回的 `modelConfigId`。每次新输入在运行地址的 query 中选择模型，请求体直接使用 SDK 的消息形状：

```sh
export API_URL=http://127.0.0.1:3000
export TOKEN='替换为登录返回的accessToken'
export MODEL_CONFIG_ID='替换为modelConfigId'
curl --fail -X POST "$API_URL/conversations" \
  -H "Authorization: Bearer $TOKEN"
export CONVERSATION_ID='替换为响应中的conversationId'

curl -N --fail -X POST "$API_URL/conversations/$CONVERSATION_ID/runs?modelConfigId=$MODEL_CONFIG_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"请使用 echo 回显 hello"}]}'
```

新输入只接受一条用户消息。`content` 原样传递和保存，保留首尾空白、缩进、制表符和换行；全空白或超过 32000 字符返回 400。后续新输入自动沿用会话历史，模型必须每次显式选择。

响应是一次执行的 SSE 流，每个 `data` 直接携带 `streamEvents({ version: 'v3' })` 产生的官方 `ProtocolEvent`，包含 SDK 实际输出的消息、工具、更新、状态、reasoning、元数据和错误。字段、顺序和序号保持 SDK 原值，显示过滤、预览及折叠由前端处理。

前端可以直接使用官方 SSE 解码器：

```ts
import { BytesLineDecoder, SSEDecoder } from '@langchain/langgraph-sdk/utils';

const response = await fetch(
  `${apiUrl}/conversations/${conversationId}/runs?modelConfigId=${modelConfigId}`,
  {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  },
);
if (!response.ok) throw new Error(`HTTP ${response.status}`);
for await (const { data: event } of response
  .body!.pipeThrough(BytesLineDecoder())
  .pipeThrough(SSEDecoder())) {
  renderEvent(event);
}
```

`GET /conversations/:id` 直接返回 SDK snapshot，包括 `values`、`next`、`tasks` 和 checkpoint 配置等字段。消息使用 SDK 的 JSON 序列化表示，状态查询不会执行模型。`GET /conversations/:id/metadata` 返回会话记录、`active` 和 `approvalAudit`，用于业务状态和审计展示；会话列表通过 `GET /conversations?limit=20` 查询并使用 `nextCursor` 分页。

一次请求持有完整执行作用域。连接结束后按保存的 snapshot 判断下一步；普通未完成任务传 `null` 显式继续：

```sh
curl -N --fail -X POST "$API_URL/conversations/$CONVERSATION_ID/runs" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d 'null'
```

继续使用保存的执行模型配置 ID 及其当前配置，不接受模型覆盖。无未完成任务、正在执行、等待审批或已关闭时拒绝。每次输入、继续或审批使用独立限额和计时，默认模型调用 10 次、工具调用 20 次、超时 120000 毫秒，通过 `AGENT_MODEL_CALL_LIMIT`、`AGENT_TOOL_CALL_LIMIT`、`AGENT_TIMEOUT_MS` 配置。

关闭连接会请求停止本次调用，底层工作排空后释放活跃记录；不会关闭会话。事件只随当前响应发送，重启后从 checkpoint 查询，不自动重放 token 或重发输入。

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
- 模型配置相关 503：检查 `MODEL_CREDENTIALS_KEY` 是否与录入时一致；不可用模型返回 404。模型和工具执行错误沿用 SDK 输出，HTTP 响应头的 `x-request-id` 用于关联日志。
- SSE 没有增量：使用 `curl -N`，检查反向代理缓冲与超时；连接结束后查询 checkpoint 判断完成、待审批或未完成状态。

## 人工审批

`echo` 工具调用由会话所属用户审查，支持 SDK 的四种决策：

| 决策      | 效果                                           | 决策字段                               |
| --------- | ---------------------------------------------- | -------------------------------------- |
| `approve` | 使用原始参数执行工具                           | `type`                                 |
| `edit`    | 使用人工修改后的调用执行工具                   | `type`、`editedAction: { name, args }` |
| `reject`  | 跳过工具，把拒绝反馈交给模型                   | `type`、可选 `message`                 |
| `respond` | 跳过工具，把人工回复作为成功的工具结果交给模型 | `type`、`message`                      |

配置使用 `interruptOn: { echo: true }`，四种决策均由 SDK 处理。

提交新输入后，模型请求 `echo` 时，SDK 在执行工具前中断并保存 checkpoint。查询 `GET /conversations/:id`，读取 `tasks[].interrupts`：`id` 是中断 ID，`value` 包含原生 `actionRequests` 和 `reviewConfigs`。

`actionRequests[].description` 使用 SDK 默认生成的工具名和完整参数说明，显示截取和折叠由前端处理。工具参数及其他 SDK 输出原样可见。

用原生 `Command.resume` 的中断 ID 映射提交决策：

```sh
curl -N --fail -X POST "$API_URL/conversations/$CONVERSATION_ID/runs" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"resume":{"替换为当前中断ID":{"decisions":[{"type":"approve"}]}}}'
```

服务端将请求体传给 `new Command(body)`。当前采用单个批量中断，`decisions` 的数量和顺序对应 `actionRequests`；每个调用选择一种决策。例如，四个待审调用可以分别批准、编辑、拒绝和人工回答：

```json
{
  "resume": {
    "替换为当前中断ID": {
      "decisions": [
        { "type": "approve" },
        {
          "type": "edit",
          "editedAction": {
            "name": "echo",
            "args": { "text": "人工修改后的文本" }
          }
        },
        { "type": "reject", "message": "不执行这次调用" },
        { "type": "respond", "message": "由人工提供的工具结果" }
      ]
    }
  }
}
```

批量模式使用 `editedAction`；修改后的工具参数由 SDK 和工具 schema 校验。`respond` 的内容作为成功的工具结果，因此拒绝调用时使用 `reject`。SDK 把结果交给模型继续执行，再次请求受审工具需要新的审批。普通消息和 `null` 不能绕过待审批状态。

审批沿用保存的执行模型，不接收新输入或模型覆盖，每次恢复使用独立预算。未认证返回 401，其他用户访问返回 404；关闭、活跃、过期中断和重复决策返回 409，非法决策及数量不匹配返回 400。

`GET /conversations/:id/metadata` 的 `approvalAudit` 记录中断 ID、完整决策、可信操作者和时间，包含编辑后的工具名与参数、拒绝说明或人工回复。审计在 SDK 恢复前写入，只证明服务已接收决策，不证明工具已执行。写入失败不会恢复。

若审计已经存在但 SDK snapshot 仍保留同一中断，决策结果尚未确认；再次提交返回 409 `Decision outcome unconfirmed`。服务不重发或补偿，可以查询，或关闭会话后另建会话。当前 SDK 的原始流在审批时根 lifecycle 可能为 completed，待审批以原生 snapshot 或更新中的中断信息为准。

## 等待、重启与取消

重启服务不会自动执行任务。尚未提交决策的审批保存在 PostgreSQL checkpoint 中，重启后先查询，再提交当前决策。已完成的审批审计不会因重启而丢失。

所属用户可以关闭会话，包括等待审批的会话：

```sh
curl -X POST "$API_URL/conversations/$CONVERSATION_ID/cancel" \
  -H "Authorization: Bearer $TOKEN"
```

取消先持久化关闭标记，再通知在途调用停止。响应中的 `active: true` 表示执行仍在收尾；关闭不撤销已发生的工具调用。关闭后禁止输入、继续和审批，已有内容仍可查询。审批与取消共用会话准入锁；关闭之后不再接纳执行。

执行连接关闭会请求停止当前调用，会话保持开放。重新连接后查询 checkpoint，按保存状态显式继续或审批，不自动重发输入或决策。人工批准不保证有外部副作用的工具只执行一次；当前 `echo` 没有外部副作用。

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
