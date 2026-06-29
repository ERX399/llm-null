// config.js — 从 config.yaml 加载配置，运行时可通过 KV 覆盖
// config.yaml 是唯一配置源，编辑它即可修改所有默认行为

import { parse } from './yaml.js';

// 构建时将 config.yaml 作为文本导入
import configFile from '../config.yaml?raw';

export const DEFAULT_CONFIG = parse(configFile);

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