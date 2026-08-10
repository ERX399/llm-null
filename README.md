<div align="center">

![:name](https://count.getloli.com/@llm-null?name=llm-null&theme=minecraft&padding=6&offset=0&align=top&scale=1&pixelated=1&darkmode=auto)

# LLM-Null

_✨ Cloudflare Worker 固定回复 LLM API ✨_

[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers-orange.svg)](https://workers.cloudflare.com/)
[![GitHub](https://img.shields.io/badge/作者-ERX399-blue)](https://github.com/ERX399)

</div>

# LLM-Null

Cloudflare Worker 上的固定回复 LLM API，支持 OpenAI / Claude / Responses 三套接口格式，也可作为 Codex 等使用 OpenAI Responses API 的客户端后端

## 快速开始

```bash
git clone https://github.com/ERX399/LLM-Null.git
cd LLM-Null
npm install
npx wrangler deploy
```

## 项目结构

```
LLM-Null/
├── index.js          # Worker 主代码（API 路由 + 响应构造）
├── config.js         # 配置（纯 JS 对象，直接编辑）
├── wrangler.toml     # Cloudflare Worker 部署配置
├── package.json
└── .gitignore
```

## 配置

编辑 `config.js` 中的 `DEFAULT_CONFIG` 对象，重新部署即可生效

配置优先级：KV 运行时配置（最高）> 环境变量 CONFIG_OVERRIDE > 代码内嵌 DEFAULT_CONFIG（最低）

## API 接口

| 接口 | 方法 | 路径 |
|------|------|------|
| OpenAI 聊天补全 | POST | /v1/chat/completions |
| OpenAI Responses | POST | /v1/responses |
| OpenAI 模型列表 | GET | /v1/models |
| Claude Messages | POST | /v1/messages |
| Claude 兼容路径 | POST | /claude/v1/messages |
| Claude 模型列表 | GET | /anthropic/v1/models |
| 健康检查 | GET | /health |
| 获取配置 | GET | /api/config |
| 更新配置 | PUT | /api/config |
| 部分更新 | PATCH | /api/config |
| 模型管理 | GET/POST/PUT/DELETE | /api/models |
| 修改回复 | PUT | /api/models/:id/response |
| 错误模式 | PUT | /api/models/:id/error |

## 压测

项目内置无依赖的 Node.js 压测脚本 `load-test.mjs`。它默认发送中性测试提示词到 OpenAI Chat Completions 接口，不会输出模型回复内容。

先启动 Worker，再压测本地接口：

```bash
npm run dev
node load-test.mjs --url http://127.0.0.1:8787/v1/chat/completions --requests 1000 --concurrency 50
```

也可以使用进程内假模型测试压测脚本本身，无需启动 Worker 或访问网络：

```bash
node load-test.mjs --fake --requests 1000 --concurrency 50 --fake-delay-ms 20
```

可选参数包括 `--timeout-ms`、`--model`、`--fake-error-rate` 和 `--json`。`--json` 适合接入 CI 或监控系统；延迟单位为毫秒，吞吐量单位为请求/秒。

### Codex / Responses API

Codex 等客户端使用 `POST /v1/responses`。服务端接受字符串或消息数组形式的 `input`，支持 `instructions`、`stream`、工具定义和固定模型回复；流式响应使用 Responses API 的 SSE 事件格式。

### 多模态输入

Chat Completions、Responses 和 Claude Messages 都可以发送文本、图片、音频和视频内容块。服务端会提取其中的文本用于 prompt 估算，并在 usage 中记录 `image_tokens`、`audio_tokens`、`video_tokens` 的输入块数量；模型仍返回配置文件中的固定文本。

示例：

```json
{
  "model": "gpt-3o",
  "input": [{
    "role": "user",
    "content": [
      { "type": "input_text", "text": "描述这张图片" },
      { "type": "input_image", "image_url": "https://example.com/image.jpg" }
    ]
  }]
}
```

### 供应商兼容入口

以下入口复用固定模型逻辑，适用于使用对应公开 JSON 协议的客户端：

- NVIDIA NIM、MiMo 等 OpenAI 兼容客户端：`/v1/chat/completions`、`/v1/models`、`/v1/embeddings`
- 智谱 GLM：`/api/paas/v4/chat/completions`、`/api/paas/v4/models`、`/api/paas/v4/embeddings`
- 豆包 Ark：`/api/v3/chat/completions`、`/api/v3/models`、`/api/v3/embeddings`
- 常见网关别名：`/api/v1/chat/completions`、`/api/v1/responses`、`/v1beta/chat/completions`
- Cloudflare Workers AI：`/accounts/:account_id/ai/run/:model` 和 `/client/v4/accounts/:account_id/ai/run/:model`
- Google Gemini：`/v1beta/models/:model:generateContent`、`/v1beta/models/:model:streamGenerateContent`、`/v1/models/:model:generateContent`
- Ollama：`/api/generate`、`/api/chat`、`/api/embed`、`/api/embeddings`、`/api/tags`、`/api/version`
- Cohere：`/v1/generate`、`/v1/chat`、`/v2/chat`、`/v1/embed`、`/v2/embed`、`/v2/models`
- 通用健康检查：`/health`、`/healthz`、`/ready`、`/api/health`、`/api/status`

Cloudflare Workers AI 路由返回 `{ success, errors, messages, result }` 外壳，普通兼容路由返回对应 OpenAI/Responses 格式。需要真实供应商的 Cookie、签名、动态 token、WebSocket 或内部 RPC 的私有站点协议，仍必须提供该站点的请求样例才能实现，不能仅凭站点名称推导。
