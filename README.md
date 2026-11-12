# 项目约束

除非有明确的特别指令，否则不得擅自修改 `package.json`、`tsconfig.json`、`vitest.config.ts`、`README.md` 等项目配置文件。

## 本地运行

使用 Node.js 24.16.0、pnpm 11.7.0 和 Docker Compose，以下命令均在仓库根目录执行。

```sh
pnpm install --frozen-lockfile
node --import tsx scripts/init-env.ts
docker compose up -d --wait postgres
pnpm db:migrate
```

初始化脚本在缺少 `DATABASE_URL` 时生成本地数据库密码，并在缺少 `AUTH_JWT_SECRET` 时独立生成 JWT 密钥，保存到 `.env`（权限 `0600`）；已有凭证不覆盖。使用外部 PostgreSQL 时自行配置 `DATABASE_URL`。保留 `.env` 与数据库卷：删除或修改 `.env` 不会重置已有数据库密码。

初始化完成后启动服务：

```sh
pnpm dev
```

`HOST`、`PORT` 和 `LANGSMITH_TRACING` 可省略，默认分别为 `127.0.0.1`、`3000` 和 `false`。服务默认监听 `127.0.0.1:3000`；`GET /health/live` 检查进程响应，`GET /health/ready` 检查数据库连接。服务启动不自动迁移，`pnpm db:migrate` 可重复执行。

编译后运行（先停止开发服务）：

```sh
pnpm build
pnpm start
```

停止数据库使用 `docker compose down`，不要加 `-v`，以保留数据卷。

## 生产认证与会话 API

所有环境统一使用 HS256 JWT，通过 `Authorization: Bearer <token>` 提交。`AUTH_JWT_SECRET` 由初始化脚本生成，可信签发端与本服务使用同一密钥；密钥只保存在服务端，不提供给浏览器。生产环境设置 `NODE_ENV=production`。当前服务不创建账号或签发凭证。

服务固定校验 HS256 签名、必需的过期时间 `exp`，以及存在时的 `nbf`。不需要配置认证模式、issuer、audience、公钥或开发固定身份；此密钥应仅供 Agentloom 使用。密钥至少 32 字符，脚本生成 32 字节随机值的十六进制字符串；更换后重启服务，旧令牌随即失效。公网入口由 Nginx 提供 HTTPS。

可信身份取自 JWT 的 `tenant_id`（租户）和 `sub`（用户）；两者必须是 1–200 字符且不能全为空白的字符串。签发方必须根据已经验证的用户及租户关系生成这些声明，不能照抄客户端提交的身份。请求体、查询参数和 `x-tenant-id` / `x-user-id` 请求头均不能改变可信身份。缺少或无效凭证返回 401，响应携带 `x-request-id`。

创建会话（请求体可省略，也可为 `{}`，不接受自定义 ID 或其他字段）：

```sh
export TOKEN='<可信签发方提供的访问令牌>'
curl -i -X POST http://127.0.0.1:3000/conversations \
  -H "Authorization: Bearer $TOKEN"
```

成功返回 201 和 `{ "conversationId": "<服务端生成的 UUID>", "createdAt": "<ISO 时间>" }`。使用返回的 ID 查询：

```sh
export CONVERSATION_ID='<创建接口返回的 conversationId>'
curl -i "http://127.0.0.1:3000/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $TOKEN"
```

仅所属租户且所属用户可查询，成功返回 200 及相同会话元数据；不存在和越权均返回 404，非法 UUID 返回 400。所有环境都必须携带 JWT。健康检查仍无需认证。

会话保存在 PostgreSQL，重启后仍可查询。`conversationId` 同时是后续 SDK 使用的 `thread_id`，ID 本身不是访问凭证。当前只开放创建和查询元数据，不执行 Agent，不提供 SSE、继续、取消或审批接口。

## 业务迁移

修改 `src/database/schema.ts` 后执行 `pnpm db:generate`，检查并提交 `migrations/` 中生成的 SQL 与元数据。生成迁移无需数据库连接或认证配置。不要手工维护官方 checkpointer 的表。

`pnpm db:migrate` 是唯一数据库准备入口：先串行应用 Drizzle 业务迁移，再执行官方 saver 的 `setup()`；可重复执行，只需 `DATABASE_URL`。API 启动不自动迁移。升级已有 Step 2 数据库时也先执行此命令，已有 checkpoint 会保留。

## 检查与测试

```sh
pnpm check
pnpm test
```

`check` 依次执行 `typecheck`、`lint`、`format:check`，也可分别运行。单元及集成测试均无需真实模型 Key。

集成测试使用独立 PostgreSQL 测试库；首次创建后，替换下方密码占位符并执行：

```sh
docker compose exec postgres createdb -U myagents myagents_test
export TEST_DATABASE_URL='postgresql://myagents:<POSTGRES_PASSWORD>@127.0.0.1:5432/myagents_test'
pnpm test:integration
```

密码使用 `.env` 中的 `POSTGRES_PASSWORD`。测试不自动加载 `.env`，必须显式设置 `TEST_DATABASE_URL`，不要指向业务或生产库；测试会应用业务迁移并创建 checkpoint 表和数据，验证 JWT 与会话归属以及编译后服务重启的持久化查询。`test:integration` 自动先构建，无需预先生成 `dist/`。
