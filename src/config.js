// config.js — 默认配置（与 config.json 同步，部署时打包进 Worker）
// 运行时可通过 KV 覆盖，也可通过 PUT /api/config 全量替换

export const DEFAULT_CONFIG = {
  "site_title": "Mock LLM API 控制台",
  "default_model_id": "claude-fable-5",
  "default_error": {
    "code": 529,
    "message": "是的这其实是个假模型"
  },
  "enable_admin": true,
  "enable_cors": true,
  "log_requests": true,
  "global_delay_ms": 0,
  "models": {
    "claude-fable-5": {
      "id": "claude-fable-5",
      "name": "Claude Fable 5",
      "number": 1,
      "response": "你好，我是 Claude Fable 5，这是一个固定回复",
      "error_mode": false,
      "error": {
        "code": 529,
        "message": "是的这其实是个假模型"
      },
      "delay_ms": 0,
      "max_tokens": 4096,
      "temperature": 1.0,
      "stream_chunk_size": 0,
      "metadata": {}
    }
  }
};

// KV key
const KV_CONFIG_KEY = "runtime_config";

// 深合并（简单实现：覆盖标量，递归合并对象，数组直接替换）
export function deepMerge(base, override) {
  if (typeof base !== 'object' || base === null) return override;
  if (typeof override !== 'object' || override === null) return override;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (key in base) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

export async function getConfig(env) {
  if (env.MOCK_LLM_KV) {
    const raw = await env.MOCK_LLM_KV.get(KV_CONFIG_KEY);
    if (raw) {
      try {
        const runtime = JSON.parse(raw);
        return deepMerge(DEFAULT_CONFIG, runtime);
      } catch {}
    }
  }
  // 环境变量覆盖
  if (env.CONFIG_OVERRIDE) {
    try {
      const override = JSON.parse(env.CONFIG_OVERRIDE);
      return deepMerge(DEFAULT_CONFIG, override);
    } catch {}
  }
  return DEFAULT_CONFIG;
}

export async function saveConfig(env, config) {
  if (env.MOCK_LLM_KV) {
    await env.MOCK_LLM_KV.put(KV_CONFIG_KEY, JSON.stringify(config));
    return true;
  }
  return false;
}
