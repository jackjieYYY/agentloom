# 数据库 Provider 与聊天模型选择

模型配置和加密后的 API Key 保存在 PostgreSQL。支持 `openai` 与 `openai-compatible`，后者固定使用 Chat Completions。全局可配置多个 provider，每个 provider 可配置多个模型。

## 初始化

```sh
node --import tsx scripts/init-env.ts
pnpm db:init
```

初始化脚本为缺失的 `MODEL_CREDENTIALS_KEY` 生成独立的 32 字节随机密钥，以 64 位十六进制保存在权限为 `0600` 的 `.env`，保留已有值。API Key 使用 `jose` 的 Compact JWE 存储，固定 `alg: dir`、`enc: A256GCM`。provider ID 放入受认证的 protected header，解密时校验绑定；IV 和认证标签由库管理。解密只接受上述算法，失败统一返回脱敏错误。丢失主密钥需要重新录入 Key；直接替换主密钥不会重新加密已有凭证。

缺少主密钥时可以查询配置、修改非凭证字段和取消聊天；创建 provider、更新 Key 及真实模型执行返回 503。开发阶段不提供旧配置导入、旧 checkpoint 补绑或业务版本迁移。旧自定义密文格式不再支持；旧开发库需使用空库重新初始化并通过 API 录入配置。

## 配置管理 API

所有接口要求 `Authorization: Bearer <JWT>`。JWT 使用 HS256 验签，必须包含 `exp` 和 `sub`；`sub` 是全局唯一的用户标识，必须为 1–200 字符且不能全为空白。Provider 和模型配置全局共享，所有通过认证的用户均可管理、查询和使用这些配置，暂不区分管理角色。请求体不接受 `userId` 或 `action`。配置管理只通过 API 提供，不保留运维 CLI。

| 方法与路径             | 请求与行为                                                        |
| ---------------------- | ----------------------------------------------------------------- |
| `GET /providers`       | 返回全局全部 provider，包含停用项、地址和协议，不含明文或加密 Key |
| `POST /providers`      | 创建 provider，返回 201 和 `{ providerId }`                       |
| `PATCH /providers/:id` | 更新 provider，返回 `{ providerId }`                              |
| `GET /models`          | 返回全局全部模型，包含停用模型及停用 provider 下的模型            |
| `POST /models`         | 创建模型配置，返回 201 和 `{ modelConfigId }`                     |
| `PATCH /models/:id`    | 更新模型配置，返回 `{ modelConfigId }`                            |

非法 UUID、空更新、未知字段或非法字段值返回 400；资源不存在返回 404。当前不提供删除接口。

创建 provider：

```http
POST /providers
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "name": "主要模型服务",
  "type": "openai-compatible",
  "baseUrl": "https://models.example/v1",
  "apiKey": "<API_KEY>"
}
```

必填字段为 `name`、`type`、`apiKey`；`openai-compatible` 还必须提供 `baseUrl`，`openai` 省略时默认 `https://api.openai.com/v1`。`enabled` 可选，默认 true。地址只接受 HTTPS，不允许 URL 内的用户名、密码、查询参数或 fragment。

PATCH 接受 `name`、`type`、`baseUrl`、`apiKey`、`enabled` 的任意非空子集。省略的字段保留原值，包括地址；修改 `type` 不自动重置地址。`apiKey` 仅用于写入，响应不返回任何凭证。

创建模型配置：

```http
POST /models
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "providerId": "<PROVIDER_UUID>",
  "modelName": "<UPSTREAM_MODEL_NAME>"
}
```

必填字段为 `providerId`、`modelName`；`enabled` 默认 true。创建时 provider 必须存在，关联在创建后固定。PATCH 仅接受 `modelName`、`enabled` 的任意非空子集，省略字段保留原值；传入 `providerId` 或 `isDefault` 返回 400。

后端不保存全局默认模型，前端自行维护默认选择。停用模型或 provider 会阻止后续执行；允许在停用 provider 下创建模型或修改模型名称、启用状态。可通过 PATCH 重新启用，不会中止在途调用。

模型列表包含 `id`、`modelName`、`providerId`、`providerName`、`enabled` 和 `providerEnabled`，不含 Key 和 provider 地址。调用方通过 `enabled && providerEnabled` 筛选可用模型，实际执行仍由服务端校验启用状态。

## 聊天模型选择

聊天只允许 JWT 的 `sub` 对应的所属用户访问。`POST /conversations` 接受空请求体或 `{}`，不接收模型参数。每次 `POST /conversations/:id/input` 都必须提供 `text` 和 `modelConfigId`：

```json
{
  "text": "你好",
  "modelConfigId": "<MODEL_CONFIG_UUID>"
}
```

前端维护模型选择，后端不保存全局或聊天默认模型，也不提供 `PATCH /conversations/:id`。缺少或传入非法 `modelConfigId` 返回 400 `Invalid request`，不会沿用上一轮模型。选择的模型或 provider 不可用时返回 404，不静默切换。`GET /conversations` 支持 `limit` 和 `cursor` 分页；列表返回最近执行模型 ID，详情还包含其模型标识，未执行时为 null。

## 更新与继续执行

每次输入或继续执行只读取一次配置，整个模型与工具循环固定使用准入时创建的模型实例。修改 provider 的地址、协议、Key 或模型标识不会改变在途调用，下一次输入或继续执行读取最新配置，无需重启服务。

新输入启动 SDK 前保存 `lastExecutionModelConfigId`；保存失败不调用模型。未完成任务只能使用 `/continue` 继续，不能借新输入或继续请求覆盖模型 ID。继续执行沿用保存的模型配置 ID，但使用该 ID 当前对应的模型标识、provider、地址、协议与凭证。因此修改配置后，未完成任务可能通过更新后的服务继续处理已有历史；最近执行模型引用不是不可变路由快照或逐消息审计记录。

前端改变所选模型只影响后续新输入，不改变在途调用或未完成任务的模型配置 ID。配置停用后不能继续，重新启用后可再次尝试。取消会永久关闭聊天。

应用复用一个 Agent，通过调用 runtime context 和 `wrapModelCall` 注入本次模型。配置实例、计数器和未结束工作按调用隔离，不写入 checkpoint；集成依据见 [LangChain 接入约定](langchain-integration.md)。

暂未接入管理前端、原生 Anthropic/Gemini、逐消息用量记录或自动故障切换。真实 provider 的协议及工具兼容性需要使用目标账号联调。
