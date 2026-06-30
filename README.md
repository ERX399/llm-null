# LLM-Null

Cloudflare Worker 上的固定回复 LLM API，支持 OpenAI / Claude / Responses 三套接口格式

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