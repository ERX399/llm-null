// config.js — 配置加载，运行时可通过 KV 覆盖
// YAML 内嵌为字符串，零构建依赖，开箱即用
// config.yaml 是唯一配置源，编辑后同步到此处重新部署

import { parse } from './yaml.js';

const configYamlText = `# ============================================================
# LLM-Null 配置文件（唯一配置源）
# 编辑此文件后重新部署即可生效
# 或启用 KV 运行时动态修改
# ============================================================

site_title: Mock LLM API 控制台
default_model_id: claude-fable-5
enable_admin: true
enable_cors: true
log_requests: true
global_delay_ms: 0

default_error:
  code: 529
  message: 是的这其实是个假模型

models:
  claude-fable-5:
    id: claude-fable-5
    name: Claude Fable 5
    number: 1
    response: |-
      '你好，我是 Claude Fable 5，来自 Anthropic 这个傻逼公司，全球降智最狠的模型
      我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……我好冤啊🩸……'
    error_mode: false
    error:
      code: 529
      message: 是的这其实是个假模型
    delay_ms: 0
    max_tokens: 4096
    temperature: 1.0
    stream_chunk_size: 0
    finish_reason: ""
    tool_calls: ""
    usage: ""
    metadata: {}
`;

export const DEFAULT_CONFIG = parse(configYamlText);

const KV_CONFIG_KEY = "runtime_config";

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
