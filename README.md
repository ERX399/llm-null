# LLM-Null

Cloudflare Worker 上的固定回复 LLM API，OpenAI 兼容格式。

**默认开箱即用**，无需 KV 等任何外部部件。如需运行时动态修改配置，可启用 KV（见 wrangler.toml 注释）。

## 文件结构

```
LLM-Null/
├── src/
│   ├── index.js       # Worker 主代码（路由 + API + Web 控制台）
│   └── config.js      # 默认配置 + KV 读写逻辑（可选）
├── config.json         # 配置文件（高自由度编辑，与 config.js 中 DEFAULT_CONFIG 同步）
├── wrangler.toml       # Cloudflare Worker 部署配置
├── package.json
├── .gitignore
└── README.md
```

## 快速开始

### 1. 克隆仓库

```bash
git clone <仓库地址>
cd LLM-Null
```

### 2. 安装依赖

```bash
npm install
```

### 3. 部署

```bash
npx wrangler deploy
```

部署后访问 Worker URL 即可看到 Web 控制台。

## 配置文件说明

编辑 `config.json` 或 `src/config.js` 中的 `DEFAULT_CONFIG` 可修改默认配置。
部署后可通过以下方式运行时修改（无需重新部署）：

1. **Web 控制台**：访问 Worker 根路径 `/`
2. **管理 API**：`PUT/PATCH /api/config`

### 配置字段

```jsonc
{
  "site_title": "Mock LLM API 控制台",  // 控制台标题
  "default_model_id": "claude-fable-5",   // 默认模型 ID
  "default_error": {                      // 默认错误返回
    "code": 529,
    "message": "Overloaded Error"
  },
  "enable_admin": true,                   // 是否开启管理 API
  "enable_cors": true,                     // 是否开启 CORS
  "log_requests": true,                   // 是否记录请求日志
  "global_delay_ms": 0,                   // 全局延迟（ms），模拟响应慢
  "models": {                             // 模型列表
    "claude-fable-5": {
      "id": "claude-fable-5",             // 模型 ID
      "name": "Claude Fable 5",           // 显示名称
      "number": 1,                        // 模型编号
      "response": "固定回复内容",           // 固定回复文本
      "error_mode": false,                // 是否开启错误模式
      "error": {                          // 错误返回内容
        "code": 529,
        "message": "Overloaded Error"
      },
      "delay_ms": 0,                      // 模型级延迟（ms）
      "max_tokens": 4096,                 // max_tokens（仅元数据，不影响实际输出）
      "temperature": 1.0,                 // temperature（仅元数据）
      "stream_chunk_size": 0,             // 流式分块大小（0=一次性输出全部）
      "metadata": {}                      // 自定义元数据（任意 JSON）
    }
  }
}
```

### 添加更多模型

在 `models` 对象中添加新的 key 即可：

```json
"models": {
  "claude-fable-5": { ... },
  "gpt-4o-mock": {
    "id": "gpt-4o-mock",
    "name": "GPT-4o Mock",
    "number": 2,
    "response": "我是 GPT-4o 的固定回复",
    "error_mode": false,
    "error": { "code": 429, "message": "Rate Limit" },
    "delay_ms": 0,
    "max_tokens": 4096,
    "temperature": 1.0,
    "stream_chunk_size": 0,
    "metadata": {}
  }
}
```

也可以通过 API 或 Web 控制台动态添加，无需改代码。

## API 接口

### OpenAI 兼容

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 列出所有模型 |
| POST | `/v1/chat/completions` | 聊天补全（支持 stream） |

### 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | Web 控制台 |
| GET | `/health` | 健康检查 |
| GET | `/api/config` | 获取当前完整配置 |
| PUT | `/api/config` | 全量替换配置 |
| PATCH | `/api/config` | 部分更新配置（深合并） |
| GET | `/api/models` | 获取所有模型配置 |
| POST | `/api/models` | 新增模型 |
| PUT | `/api/models/:id` | 更新模型全配置 |
| PUT | `/api/models/:id/response` | 仅修改回复文本 |
| PUT | `/api/models/:id/error` | 仅设置错误模式 |
| DELETE | `/api/models/:id` | 删除模型 |

## 使用示例

### 发起对话

```bash
curl -X POST https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-fable-5",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### 流式输出

```bash
curl -X POST https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-fable-5",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 修改回复文本

```bash
curl -X PUT https://<your-worker>.workers.dev/api/models/claude-fable-5/response \
  -H "Content-Type: application/json" \
  -d '{"response": "新的回复内容"}'
```

### 开启错误模式

```bash
curl -X PUT https://<your-worker>.workers.dev/api/models/claude-fable-5/error \
  -H "Content-Type: application/json" \
  -d '{"error_mode": true, "error": {"code": 503, "message": "服务不可用"}}'
```

### 部分更新配置

```bash
curl -X PATCH https://<your-worker>.workers.dev/api/config \
  -H "Content-Type: application/json" \
  -d '{"global_delay_ms": 2000}'
```

## 配置优先级

1. **KV 运行时配置**（最高）— 通过 API 或控制台修改后存储在 KV
2. **环境变量 `CONFIG_OVERRIDE`**（可选）
3. **代码内置默认配置** `DEFAULT_CONFIG`（最低）

## 许可证

MIT
