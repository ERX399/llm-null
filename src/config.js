// config.js — 从 config.json 加载配置，运行时可通过 KV 覆盖
// config.json 是唯一配置源，编辑它即可修改所有默认行为

import configJson from '../config.json';

export const DEFAULT_CONFIG = configJson;

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
