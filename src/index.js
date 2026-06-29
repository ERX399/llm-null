// index.js — Mock LLM API for Cloudflare Worker
// OpenAI 兼容固定回复 API + Web 控制台 + 高自由度配置管理

import { DEFAULT_CONFIG, getConfig, saveConfig, deepMerge } from './config.js';
import { dump as yamlDump, parse as yamlParse } from './yaml.js';

// ============================================================
//  工具函数
// ============================================================

function json(data, status = 200, config = null) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (config?.enable_cors) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
  }
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

function html(content) {
  return new Response(content, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function genId() {
  return 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 从 models 对象中取 model 或回退到 default_model_id
function resolveModel(config, modelId) {
  if (!modelId) modelId = config.default_model_id;
  return config.models?.[modelId] || null;
}

// 构造 OpenAI chat completion 响应
function makeChatCompletion(modelId, content, modelCfg) {
  const message = { role: 'assistant', content };
  // 深度思考
  if (modelCfg.thinking) {
    message.reasoning_content = modelCfg.thinking;
    message.thinking = modelCfg.thinking;
  }
  // tool_calls
  const finishReason = modelCfg.finish_reason || (modelCfg.tool_calls ? 'tool_calls' : 'stop');
  if (modelCfg.tool_calls) {
    try {
      const tc = typeof modelCfg.tool_calls === 'string' ? JSON.parse(modelCfg.tool_calls) : modelCfg.tool_calls;
      if (Array.isArray(tc)) {
        message.tool_calls = tc.map((c, i) => ({
          id: c.id || ('call_' + crypto.randomUUID().replace(/-/g,'').slice(0,24)),
          type: c.type || 'function',
          function: { name: c.function?.name || c.name || '', arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments || c.arguments || {}) },
          index: c.index ?? i
        }));
        if (!content) message.content = null;
      }
    } catch {}
  }
  // usage
  const usage = modelCfg.usage
    ? (typeof modelCfg.usage === 'string' ? JSON.parse(modelCfg.usage) : modelCfg.usage)
    : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: genId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage
  };
}

function makeModelsList(config) {
  return {
    object: 'list',
    data: Object.values(config.models || {}).map(m => ({
      id: m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'mock',
      name: m.name,
      number: m.number
    }))
  };
}

function makeError(code, message) {
  return { error: { code, message, type: 'mock_error' } };
}

// 路由匹配
function matchRoute(method, pathname, pattern) {
  // pattern 例: 'GET /api/models/:id/response'
  const [pMethod, ...pParts] = pattern.split(' ');
  const pPath = pParts.join(' ');
  if (pMethod !== method) return null;

  const pSegs = pPath.split('/').filter(Boolean);
  const aSegs = pathname.split('/').filter(Boolean);
  if (pSegs.length !== aSegs.length) return null;

  const params = {};
  for (let i = 0; i < pSegs.length; i++) {
    if (pSegs[i].startsWith(':')) {
      params[pSegs[i].slice(1)] = decodeURIComponent(aSegs[i]);
    } else if (pSegs[i] !== aSegs[i]) {
      return null;
    }
  }
  return params;
}

// ============================================================
//  OpenAI 兼容接口
// ============================================================

async function handleChatCompletions(request, config) {
  let body;
  try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON body'), 400); }

  const modelId = body.model || config.default_model_id;
  const model = resolveModel(config, modelId);
  if (!model) return json(makeError(404, `Model '${modelId}' not found`), 404);

  // 错误模式
  if (model.error_mode) {
    const err = model.error || config.default_error;
    return json(makeError(err.code, err.message), err.code);
  }

  // 延迟
  const delay = (model.delay_ms || 0) + (config.global_delay_ms || 0);
  if (delay > 0) await sleep(delay);

  const content = model.response;

  // 流式
  if (body.stream) {
    return streamResponse(modelId, content, model, body);
  }

  return json(makeChatCompletion(modelId, content, model));
}

function streamResponse(modelId, content, model, body) {
  const id = genId();
  const created = Math.floor(Date.now() / 1000);
  const chunkSize = model.stream_chunk_size > 0 ? model.stream_chunk_size : content.length;
  const encoder = new TextEncoder();

  function sendChunk(delta) {
    const data = {
      id, object: 'chat.completion.chunk', created, model: modelId,
      choices: [{ index: 0, delta, finish_reason: null }]
    };
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  }

  const stream = new ReadableStream({
    async start(controller) {
      // 1. 先输出深度思考内容
      if (model.thinking) {
        const tSize = chunkSize;
        for (let i = 0; i < model.thinking.length; i += tSize) {
          const tChunk = model.thinking.slice(i, i + tSize);
          controller.enqueue(sendChunk({ reasoning_content: tChunk, thinking: tChunk }));
        }
      }
      // 2. 再输出正文回复
      for (let i = 0; i < content.length; i += chunkSize) {
        controller.enqueue(sendChunk({ content: content.slice(i, i + chunkSize) }));
      }
      // 3. 结束
      const done = {
        id, object: 'chat.completion.chunk', created, model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}

// ============================================================
//  Anthropic Claude 兼容接口
// ============================================================

function claudeErrorType(code) {
  const m = {400:'invalid_request_error',401:'authentication_error',403:'permission_denied_error',404:'not_found_error',429:'rate_limit_error',500:'api_error',529:'overloaded_error'};
  return m[code] || 'api_error';
}

function makeClaudeError(code, message) {
  return { type: 'error', error: { type: claudeErrorType(code), message } };
}

function makeClaudeMessage(modelId, modelCfg) {
  const content = [];
  if (modelCfg.thinking) content.push({ type: 'thinking', thinking: modelCfg.thinking });
  content.push({ type: 'text', text: modelCfg.response });
  return {
    id: 'msg_' + crypto.randomUUID().replace(/-/g,'').slice(0,24),
    type: 'message', role: 'assistant', model: modelId, content,
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 }
  };
}

function makeClaudeModelsList(config) {
  return { data: Object.values(config.models||{}).map(m => ({
    id: m.id, display_name: m.name,
    created_at: Math.floor(Date.now()/1000), type: 'model'
  }))};
}

async function handleClaudeMessages(request, config) {
  let body;
  try { body = await request.json(); } catch { return json(makeClaudeError(400, 'Invalid JSON body'), 400, config); }
  const modelId = body.model || config.default_model_id;
  const model = resolveModel(config, modelId);
  if (!model) return json(makeClaudeError(404, `Model '${modelId}' not found`), 404, config);
  if (model.error_mode) {
    const err = model.error || config.default_error;
    return json(makeClaudeError(err.code, err.message), err.code, config);
  }
  const delay = (model.delay_ms||0) + (config.global_delay_ms||0);
  if (delay > 0) await sleep(delay);
  if (body.stream) return streamClaudeResponse(modelId, model);
  return json(makeClaudeMessage(modelId, model), 200, config);
}

function streamClaudeResponse(modelId, model) {
  const msgId = 'msg_' + crypto.randomUUID().replace(/-/g,'').slice(0,24);
  const enc = new TextEncoder();
  const chunkSize = model.stream_chunk_size > 0 ? model.stream_chunk_size : 0;

  function ev(type, data) {
    return enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const stream = new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(ev('message_start', { type:'message_start', message: { id:msgId, type:'message', role:'assistant', content:[], model:modelId, stop_reason:null, stop_sequence:null, usage:{input_tokens:0,output_tokens:0} } }));
      // thinking
      if (model.thinking) {
        ctrl.enqueue(ev('content_block_start', { type:'content_block_start', index:0, content_block:{ type:'thinking', thinking:'' } }));
        const t = model.thinking;
        if (chunkSize > 0) {
          for (let i=0;i<t.length;i+=chunkSize) ctrl.enqueue(ev('content_block_delta', { type:'content_block_delta', index:0, delta:{ type:'thinking_delta', thinking:t.slice(i,i+chunkSize) } }));
        } else {
          ctrl.enqueue(ev('content_block_delta', { type:'content_block_delta', index:0, delta:{ type:'thinking_delta', thinking:t } }));
        }
        ctrl.enqueue(ev('content_block_stop', { type:'content_block_stop', index:0 }));
        // text block at index 1
        ctrl.enqueue(ev('content_block_start', { type:'content_block_start', index:1, content_block:{ type:'text', text:'' } }));
        const c = model.response;
        if (chunkSize > 0) {
          for (let i=0;i<c.length;i+=chunkSize) ctrl.enqueue(ev('content_block_delta', { type:'content_block_delta', index:1, delta:{ type:'text_delta', text:c.slice(i,i+chunkSize) } }));
        } else {
          ctrl.enqueue(ev('content_block_delta', { type:'content_block_delta', index:1, delta:{ type:'text_delta', text:c } }));
        }
        ctrl.enqueue(ev('content_block_stop', { type:'content_block_stop', index:1 }));
      } else {
        // text block at index 0 only
        ctrl.enqueue(ev('content_block_start', { type:'content_block_start', index:0, content_block:{ type:'text', text:'' } }));
        const c = model.response;
        if (chunkSize > 0) {
          for (let i=0;i<c.length;i+=chunkSize) ctrl.enqueue(ev('content_block_delta', { type:'content_block_delta', index:0, delta:{ type:'text_delta', text:c.slice(i,i+chunkSize) } }));
        } else {
          ctrl.enqueue(ev('content_block_delta', { type:'content_block_delta', index:0, delta:{ type:'text_delta', text:c } }));
        }
        ctrl.enqueue(ev('content_block_stop', { type:'content_block_stop', index:0 }));
      }
      ctrl.enqueue(ev('message_delta', { type:'message_delta', delta:{ stop_reason:'end_turn', stop_sequence:null }, usage:{ output_tokens:0 } }));
      ctrl.enqueue(ev('message_stop', { type:'message_stop' }));
      ctrl.close();
    }
  });

  return new Response(stream, { headers: { 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache', 'Connection':'keep-alive' } });
}

// ============================================================
//  OpenAI Responses API (/v1/responses)
// ============================================================

function makeResponsesResult(modelId, modelCfg) {
  const out = [];
  if (modelCfg.thinking) {
    out.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: modelCfg.thinking }] });
  }
  out.push({ type: 'message', role: 'assistant', id: 'msg_' + crypto.randomUUID().replace(/-/g,'').slice(0,12),
    content: [{ type: 'output_text', text: modelCfg.response }] });
  return {
    id: 'resp_' + crypto.randomUUID().replace(/-/g,'').slice(0,24),
    object: 'response', created_at: Math.floor(Date.now()/1000),
    model: modelId, output: out, status: 'completed',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  };
}

async function handleResponses(request, config) {
  let body;
  try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON body'), 400); }
  const modelId = body.model || config.default_model_id;
  const model = resolveModel(config, modelId);
  if (!model) return json(makeError(404, `Model '${modelId}' not found`), 404);
  if (model.error_mode) {
    const err = model.error || config.default_error;
    return json(makeError(err.code, err.message), err.code);
  }
  const delay = (model.delay_ms||0) + (config.global_delay_ms||0);
  if (delay > 0) await sleep(delay);
  if (body.stream) return streamResponses(modelId, model);
  return json(makeResponsesResult(modelId, model));
}

function streamResponses(modelId, model) {
  const respId = 'resp_' + crypto.randomUUID().replace(/-/g,'').slice(0,24);
  const enc = new TextEncoder();
  const chunkSize = model.stream_chunk_size > 0 ? model.stream_chunk_size : 0;

  function ev(type, data) {
    return enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const stream = new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(ev('response.created', { type:'response.created', response: { id:respId, object:'response', model:modelId, status:'in_progress', output:[] } }));
      // reasoning
      if (model.thinking) {
        ctrl.enqueue(ev('response.reasoning.delta', { type:'response.reasoning.delta', delta: model.thinking }));
      }
      // text
      const c = model.response;
      if (chunkSize > 0) {
        for (let i=0;i<c.length;i+=chunkSize) ctrl.enqueue(ev('response.output_text.delta', { type:'response.output_text.delta', delta: c.slice(i,i+chunkSize) }));
      } else {
        ctrl.enqueue(ev('response.output_text.delta', { type:'response.output_text.delta', delta: c }));
      }
      ctrl.enqueue(ev('response.completed', { type:'response.completed', response: { id:respId, object:'response', model:modelId, status:'completed', output:[] } }));
      ctrl.close();
    }
  });

  return new Response(stream, { headers: { 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache', 'Connection':'keep-alive' } });
}

// ============================================================
//  管理接口
// ============================================================

async function handleAdmin(method, pathname, request, config, env) {
  if (!config.enable_admin) return json(makeError(403, 'Admin API disabled'), 403);

  // GET /api/config
  let params = matchRoute(method, pathname, 'GET /api/config');
  if (params !== null) return json(config);

  // PUT /api/config — 全量替换
  params = matchRoute(method, pathname, 'PUT /api/config');
  if (params !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400); }
    const ok = await saveConfig(env, body);
    return json({ status: ok ? 'saved' : 'no_kv', config: body });
  }

  // PATCH /api/config — 部分更新
  params = matchRoute(method, pathname, 'PATCH /api/config');
  if (params !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400); }
    const merged = deepMerge(config, body);
    const ok = await saveConfig(env, merged);
    return json({ status: ok ? 'saved' : 'no_kv', config: merged });
  }

  // GET /api/models
  params = matchRoute(method, pathname, 'GET /api/models');
  if (params !== null) return json({ models: config.models || {} });

  // POST /api/models — 新增模型
  params = matchRoute(method, pathname, 'POST /api/models');
  if (params !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400); }
    const mid = body.id || '';
    if (!mid) return json(makeError(400, 'Field "id" is required'), 400);
    if (!config.models) config.models = {};
    if (config.models[mid]) return json(makeError(409, `Model '${mid}' already exists`), 409);
    const maxNum = Math.max(0, ...Object.values(config.models).map(m => m.number || 0));
    config.models[mid] = {
      id: mid,
      name: body.name || mid,
      number: body.number || maxNum + 1,
      response: body.response || '默认回复',
      thinking: body.thinking || '',
      error_mode: body.error_mode || false,
      error: body.error || config.default_error,
      delay_ms: body.delay_ms || 0,
      max_tokens: body.max_tokens || 4096,
      temperature: body.temperature || 1.0,
      stream_chunk_size: body.stream_chunk_size || 0,
      metadata: body.metadata || {},
      finish_reason: body.finish_reason || '',
      tool_calls: body.tool_calls || '',
      usage: body.usage || ''
    };
    const ok = await saveConfig(env, config);
    return json({ status: ok ? 'created' : 'no_kv', model: config.models[mid] }, 201);
  }

  // PUT /api/models/:id — 更新模型全配置
  params = matchRoute(method, pathname, 'PUT /api/models/:id');
  if (params !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400); }
    const m = config.models?.[params.id];
    if (!m) return json(makeError(404, `Model '${params.id}' not found`), 404);
    Object.assign(m, body);
    m.id = params.id; // 防止 id 被改
    const ok = await saveConfig(env, config);
    return json({ status: ok ? 'updated' : 'no_kv', model: m });
  }

  // PUT /api/models/:id/response — 修改回复文本
  params = matchRoute(method, pathname, 'PUT /api/models/:id/response');
  if (params !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400); }
    const m = config.models?.[params.id];
    if (!m) return json(makeError(404, `Model '${params.id}' not found`), 404);
    m.response = body.response ?? '';
    const ok = await saveConfig(env, config);
    return json({ status: ok ? 'updated' : 'no_kv', model_id: params.id, response: m.response });
  }

  // PUT /api/models/:id/thinking — 修改深度思考内容
  params = matchRoute(method, pathname, 'PUT /api/models/:id/thinking');
  if (params !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400); }
    const m = config.models?.[params.id];
    if (!m) return json(makeError(404, `Model '${params.id}' not found`), 404);
    m.thinking = body.thinking ?? '';
    const ok = await saveConfig(env, config);
    return json({ status: ok ? 'updated' : 'no_kv', model_id: params.id, thinking: m.thinking });
  }

  // PUT /api/models/:id/error — 设置错误模式
  params = matchRoute(method, pathname, 'PUT /api/models/:id/error');
  if (params !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400); }
    const m = config.models?.[params.id];
    if (!m) return json(makeError(404, `Model '${params.id}' not found`), 404);
    if ('error_mode' in body) m.error_mode = body.error_mode;
    if (body.error) m.error = { ...m.error, ...body.error };
    const ok = await saveConfig(env, config);
    return json({ status: ok ? 'updated' : 'no_kv', model_id: params.id, error_mode: m.error_mode, error: m.error });
  }

  // DELETE /api/models/:id — 删除模型
  params = matchRoute(method, pathname, 'DELETE /api/models/:id');
  if (params !== null) {
    if (!config.models?.[params.id]) return json(makeError(404, `Model '${params.id}' not found`), 404);
    delete config.models[params.id];
    const ok = await saveConfig(env, config);
    return json({ status: ok ? 'deleted' : 'no_kv', model_id: params.id });
  }

  return null; // 无匹配
}

// ============================================================
//  Web 控制台 (内嵌 HTML)
// ============================================================

function consoleHTML(config) {
  const title = config.site_title || 'Mock LLM API';
  const configYAML = yamlDump(config);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background:#0f172a; color:#e2e8f0; min-height:100vh; }
  .container { max-width:1200px; margin:0 auto; padding:20px; }
  h1 { font-size:1.6rem; margin-bottom:8px; }
  .subtitle { color:#94a3b8; font-size:0.9rem; margin-bottom:24px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media(max-width:768px){ .grid{ grid-template-columns:1fr; } }
  .card { background:#1e293b; border:1px solid #334155; border-radius:12px; padding:20px; }
  .card h2 { font-size:1.1rem; margin-bottom:12px; color:#38bdf8; }
  .card h3 { font-size:0.95rem; margin:12px 0 6px; color:#94a3b8; }
  textarea { width:100%; min-height:300px; background:#0f172a; color:#e2e8f0; border:1px solid #334155; border-radius:8px; padding:12px; font-family:"Cascadia Code", "Fira Code", monospace; font-size:0.85rem; resize:vertical; }
  textarea:focus { outline:none; border-color:#38bdf8; }
  .btn { display:inline-block; padding:8px 20px; border:none; border-radius:8px; font-size:0.9rem; cursor:pointer; transition:all .15s; }
  .btn-primary { background:#3b82f6; color:#fff; }
  .btn-primary:hover { background:#2563eb; }
  .btn-danger { background:#ef4444; color:#fff; }
  .btn-danger:hover { background:#dc2626; }
  .btn-sm { padding:4px 12px; font-size:0.8rem; }
  .btn-row { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
  .model-list { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
  .model-item { background:#0f172a; border:1px solid #334155; border-radius:8px; padding:12px; }
  .model-item .name { font-weight:600; color:#f1f5f9; }
  .model-item .id { color:#64748b; font-size:0.8rem; }
  .model-item .actions { margin-top:8px; display:flex; gap:6px; flex-wrap:wrap; }
  .badge { display:inline-block; padding:2px 8px; border-radius:4px; font-size:0.75rem; }
  .badge-on { background:#ef4444; color:#fff; }
  .badge-off { background:#22c55e; color:#fff; }
  .toast { position:fixed; top:20px; right:20px; padding:12px 24px; border-radius:8px; color:#fff; z-index:999; opacity:0; transition:opacity .2s; }
  .toast.show { opacity:1; }
  .toast-ok { background:#22c55e; }
  .toast-err { background:#ef4444; }
  .api-info { background:#0f172a; border:1px solid #334155; border-radius:8px; padding:12px; font-size:0.8rem; }
  .api-info code { color:#38bdf8; }
  .api-info .row { display:flex; justify-content:space-between; padding:3px 0; border-bottom:1px solid #1e293b; }
  .api-info .row:last-child{ border:none; }
  input[type="text"], input[type="number"] { width:100%; background:#0f172a; color:#e2e8f0; border:1px solid #334155; border-radius:6px; padding:6px 10px; font-size:0.85rem; }
  input:focus{ outline:none; border-color:#38bdf8; }
  label { font-size:0.8rem; color:#94a3b8; display:block; margin-bottom:3px; }
  .form-row { margin-bottom:10px; }
  .switch { display:flex; align-items:center; gap:8px; }
  .switch input { width:auto; }
</style>
</head>
<body>
<div class="container">
  <h1>🧩 ${title}</h1>
  <p class="subtitle">Mock LLM API — 固定回复 / 错误模拟 / 多模型管理</p>

  <div class="grid">
    <!-- 模型列表 -->
    <div class="card">
      <h2>📋 模型列表</h2>
      <div class="model-list" id="modelList">加载中...</div>
      <div class="btn-row">
        <button class="btn btn-primary btn-sm" onclick="openCreateModal()">+ 新增模型</button>
        <button class="btn btn-sm" style="background:#475569;color:#fff" onclick="loadModels()">刷新</button>
      </div>
    </div>

    <!-- 配置编辑器 -->
    <div class="card">
      <h2>⚙️ 全局配置 (YAML)</h2>
      <p style="font-size:0.8rem;color:#64748b;margin-bottom:8px">YAML 格式，支持注释和多行文本（| 保留换行），修改后点保存</p>
      <textarea id="configEditor" style="min-height:500px">${configYAML}</textarea>
      <div class="btn-row">
        <button class="btn btn-primary btn-sm" onclick="saveConfig()">保存配置</button>
        <button class="btn btn-sm" style="background:#475569;color:#fff" onclick="loadConfig()">重载</button>
      </div>
    </div>

    <!-- 模型编辑器 -->
    <div class="card" id="modelEditorCard" style="display:none">
      <h2>✏️ 编辑模型</h2>
      <div id="modelEditorBody"></div>
    </div>

    <!-- API 信息 -->
    <div class="card">
      <h2>📡 API 接口</h2>
      <div class="api-info">
        <div class="row" style="border-top:2px solid #334155;padding-top:6px;margin-top:4px"><span style="color:#f59e0b;font-weight:600">OpenAI 格式</span><code></code></div>
        <div class="row"><span>聊天补全</span><code>POST /v1/chat/completions</code></div>
        <div class="row"><span>Responses API</span><code>POST /v1/responses</code></div>
        <div class="row"><span>模型列表</span><code>GET /v1/models</code></div>
        <div class="row" style="border-top:2px solid #334155;padding-top:6px;margin-top:4px"><span style="color:#a855f7;font-weight:600">Claude 格式</span><code></code></div>
        <div class="row"><span>Claude 对话</span><code>POST /v1/messages</code></div>
        <div class="row"><span>兼容路径</span><code>POST /claude/v1/messages</code></div>
        <div class="row"><span>Claude 模型</span><code>GET /anthropic/v1/models</code></div>
        <div class="row"><span>获取配置</span><code>GET /api/config</code></div>
        <div class="row"><span>更新配置</span><code>PUT /api/config</code></div>
        <div class="row"><span>部分更新</span><code>PATCH /api/config</code></div>
        <div class="row"><span>新增模型</span><code>POST /api/models</code></div>
        <div class="row"><span>更新模型</span><code>PUT /api/models/:id</code></div>
        <div class="row"><span>修改回复</span><code>PUT /api/models/:id/response</code></div>
        <div class="row"><span>深度思考</span><code>PUT /api/models/:id/thinking</code></div>
        <div class="row"><span>错误模式</span><code>PUT /api/models/:id/error</code></div>
        <div class="row"><span>删除模型</span><code>DELETE /api/models/:id</code></div>
        <div class="row"><span>健康检查</span><code>GET /health</code></div>
      </div>
    </div>
  </div>
</div>

<!-- 新增模型弹窗 -->
<div id="createModal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:100;align-items:center;justify-content:center">
  <div class="card" style="width:400px;max-width:90vw">
    <h2>新增模型</h2>
    <div class="form-row"><label>模型 ID</label><input type="text" id="newId" placeholder="my-model"></div>
    <div class="form-row"><label>显示名称</label><input type="text" id="newName" placeholder="My Model"></div>
    <div class="form-row"><label>回复文本</label><input type="text" id="newResponse" placeholder="固定回复内容"></div>
    <div class="btn-row">
      <button class="btn btn-primary btn-sm" onclick="createModel()">创建</button>
      <button class="btn btn-sm" style="background:#475569;color:#fff" onclick="closeCreateModal()">取消</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const API = '';

// ===== 轻量 YAML 解析器（浏览器端） =====
function yamlParse(text) {
  const lines = text.split('\\n');
  return _parseBlock(lines, 0, 0).value || {};
}
function _parseBlock(lines, start, indent) {
  const result = {};
  let i = start;
  let pending = null;
  while (i < lines.length) {
    let line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
    if (pending) {
      const li = (line.match(/^(\\s*)/)||[''])[0].length;
      if (line.trim() === '' || li > indent) { pending.lines.push(line.slice(indent+2)); i++; continue; }
      else { result[pending.key] = _joinML(pending.lines, pending.mode); pending = null; }
    }
    const li = (line.match(/^(\\s*)/)||[''])[0].length;
    if (li < indent) break;
    const t = line.slice(li);
    const ci = _findColon(t);
    if (ci === -1) { i++; continue; }
    const k = t.slice(0, ci).trim();
    let v = t.slice(ci+1).trim();
    v = _stripComment(v);
    if (v === '|' || v === '>' || v === '|-' || v === '>-') { pending = {key:k, mode:v[0], lines:[]}; i++; continue; }
    if (v === '') {
      let ni = -1;
      for (let j=i+1; j<lines.length; j++) { if (lines[j].trim()===''||lines[j].trim().startsWith('#')) continue; ni=(lines[j].match(/^(\\s*)/)||[''])[0].length; break; }
      if (ni > li) { const sub = _parseBlock(lines, i+1, ni); result[k] = sub.value; i = sub.end; } else { result[k] = {}; }
      i++;
    } else { result[k] = _scalar(v); i++; }
  }
  if (pending) result[pending.key] = _joinML(pending.lines, pending.mode);
  return { value: result, end: i };
}
function _findColon(s) { let q=false, c=''; for (let i=0;i<s.length;i++) { if (q) { if (s[i]===c) q=false; } else { if (s[i]==='"'||s[i]==="'") { q=true; c=s[i]; } else if (s[i]===':') return i; } } return -1; }
function _stripComment(v) { if (v.startsWith('"')||v.startsWith("'")) return v; const m = v.match(/\\s+#/); return m ? v.slice(0, m.index).trim() : v; }
function _scalar(v) {
  if (v==='true') return true; if (v==='false') return false; if (v==='null'||v==='~') return null;
  if (v==='{}') return {}; if (v==='[]') return [];
  if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) return v.slice(1,-1);
  if (/^-?\\d+$/.test(v)) return parseInt(v);
  if (/^-?\\d+\\.\\d+$/.test(v)) return parseFloat(v);
  return v;
}
function _joinML(lines, mode) { while (lines.length && lines[lines.length-1].trim()==='') lines.pop(); return lines.join('\\n')+'\\n'; }

function yamlDump(obj, indent=0) {
  const pad = '  '.repeat(indent);
  const lines = [];
  if (obj===null||obj===undefined) return '';
  if (typeof obj !== 'object') return _fmtSc(obj);
  if (Array.isArray(obj)) { for (const it of obj) { lines.push(pad+'- '+(typeof it==='object'?yamlDump(it,indent+1).trimStart():_fmtSc(it))); } return lines.join('\\n'); }
  for (const [k,v] of Object.entries(obj)) {
    if (v===null||v===undefined) { lines.push(pad+k+': null'); }
    else if (typeof v==='string' && (v.includes('\\n')||v.length>80)) { const ml=v.split('\\n'); while(ml.length&&ml[ml.length-1]==='') ml.pop(); lines.push(pad+k+': |'); for (const l of ml) lines.push(pad+'  '+l); }
    else if (typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===0) { lines.push(pad+k+': {}'); }
    else if (Array.isArray(v)&&v.length===0) { lines.push(pad+k+': []'); }
    else if (typeof v==='object') { const s=yamlDump(v,indent+1); if (s) { lines.push(pad+k+':'); lines.push(s); } else { lines.push(pad+k+': {}'); } }
    else { lines.push(pad+k+': '+_fmtSc(v)); }
  }
  return lines.join('\\n');
}
function _fmtSc(v) {
  if (v===true) return 'true'; if (v===false) return 'false'; if (v===null) return 'null';
  if (typeof v==='number') return String(v);
  if (typeof v==='string') { if (v==='') return '""'; if (v.startsWith(' ')||v.endsWith(' ')||v.includes(': ')||v.startsWith('#')||v==='true'||v==='false'||v==='null'||/^\\d+$/.test(v)) return '"'+v.replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\"')+'"'; return v; }
  return String(v);
}

function toast(msg, ok=true) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'toast-ok' : 'toast-err');
  setTimeout(() => t.classList.remove('show'), 2000);
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  const data = await res.json();
  if (!res.ok) { toast(data.error?.message || 'Error', false); throw new Error(JSON.stringify(data)); }
  return data;
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'"').replace(/'/g,'&#39;').replace(/\\\\/g,'&#92;');
}

async function loadModels() {
  const data = await api('GET', '/api/models');
  const list = document.getElementById('modelList');
  list.innerHTML = '';
  const models = Object.values(data.models).sort((a,b) => (a.number||0)-(b.number||0));
  if (models.length === 0) { list.innerHTML = '<p style="color:#64748b">暂无模型</p>'; return; }
  for (const m of models) {
    const div = document.createElement('div');
    div.className = 'model-item';
    div.innerHTML = \`
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <span class="name">\${esc(m.name)}</span>
          <span class="badge \${m.error_mode?'badge-on':'badge-off'}" style="margin-left:8px">\${m.error_mode?'错误':'正常'}</span>
        </div>
        <span class="id">#\${m.number} · \${esc(m.id)}</span>
      </div>
      <div style="margin-top:6px;font-size:0.85rem;color:#94a3b8">回复: \${esc(m.response.slice(0,50))}\${m.response.length>50?'...':''}</div>
      \${m.thinking ? '<div style="margin-top:2px;font-size:0.8rem;color:#7c3aed">思考: '+esc(m.thinking.slice(0,40))+(m.thinking.length>40?'...':'')+'</div>' : ''}
      <div class="actions">
        <button class="btn btn-primary btn-sm" onclick="editModel('\${esc(m.id)}')">编辑</button>
        <button class="btn btn-sm" style="background:#f59e0b;color:#000" onclick="toggleError('\${esc(m.id)}', \${!m.error_mode})">\${m.error_mode?'关闭错误':'开启错误'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteModel('\${esc(m.id)}')">删除</button>
      </div>\`;
    list.appendChild(div);
  }
}

async function loadConfig() {
  const data = await api('GET', '/api/config');
  document.getElementById('configEditor').value = yamlDump(data);
  toast('配置已重载');
}

async function saveConfig() {
  try {
    const text = document.getElementById('configEditor').value;
    const body = yamlParse(text);
    await api('PATCH', '/api/config', body);
    toast('配置已保存');
    loadModels();
  } catch(e) { toast('YAML 格式错误: ' + e.message, false); }
}

async function editModel(id) {
  const data = await api('GET', '/api/models');
  const m = data.models[id];
  if (!m) return;
  const card = document.getElementById('modelEditorCard');
  const body = document.getElementById('modelEditorBody');
  card.style.display = 'block';
  body.innerHTML = \`
    <div class="form-row"><label>模型 ID</label><input type="text" id="editId" value="\${esc(m.id)}" disabled></div>
    <div class="form-row"><label>显示名称</label><input type="text" id="editName" value="\${esc(m.name)}"></div>
    <div class="form-row"><label>编号</label><input type="number" id="editNumber" value="\${m.number}"></div>
    <div class="form-row"><label>回复文本</label><textarea id="editResponse" style="min-height:100px">\${esc(m.response)}</textarea></div>
    <div class="form-row"><label>深度思考 (thinking)</label><textarea id="editThinking" style="min-height:80px" placeholder="深度思考内容，留空则不输出">\${esc(m.thinking||'')}</textarea></div>
    <div class="form-row"><label>延迟 (ms)</label><input type="number" id="editDelay" value="\${m.delay_ms||0}"></div>
    <div class="form-row"><label>max_tokens</label><input type="number" id="editMaxTokens" value="\${m.max_tokens||4096}"></div>
    <div class="form-row"><label>temperature</label><input type="text" id="editTemp" value="\${m.temperature||1.0}"></div>
    <div class="form-row"><label>stream 分块大小 (0=不分块)</label><input type="number" id="editChunk" value="\${m.stream_chunk_size||0}"></div>
    <div class="form-row"><label>错误模式</label><div class="switch"><input type="checkbox" id="editErrorMode" \${m.error_mode?'checked':''}><span>\${m.error_mode?'开启':'关闭'}</span></div></div>
    <div class="form-row"><label>错误码</label><input type="number" id="editErrCode" value="\${m.error?.code||500}"></div>
    <div class="form-row"><label>错误消息</label><input type="text" id="editErrMsg" value="\${esc(m.error?.message||'')}"></div>
    <div class="form-row"><label>metadata (JSON)</label><textarea id="editMeta" style="min-height:60px">\${esc(JSON.stringify(m.metadata||{}, null, 2))}</textarea></div>
    <div class="btn-row">
      <button class="btn btn-primary btn-sm" onclick="saveModel('\${esc(id)}')">保存</button>
      <button class="btn btn-sm" style="background:#475569;color:#fff" onclick="document.getElementById('modelEditorCard').style.display='none'">关闭</button>
    </div>\`;
}

async function saveModel(id) {
  try {
    const meta = JSON.parse(document.getElementById('editMeta').value || '{}');
  } catch { toast('metadata JSON 格式错误', false); return; }
  const body = {
    name: document.getElementById('editName').value,
    number: parseInt(document.getElementById('editNumber').value),
    response: document.getElementById('editResponse').value,
    thinking: document.getElementById('editThinking').value,
    delay_ms: parseInt(document.getElementById('editDelay').value),
    max_tokens: parseInt(document.getElementById('editMaxTokens').value),
    temperature: parseFloat(document.getElementById('editTemp').value),
    stream_chunk_size: parseInt(document.getElementById('editChunk').value),
    error_mode: document.getElementById('editErrorMode').checked,
    error: {
      code: parseInt(document.getElementById('editErrCode').value),
      message: document.getElementById('editErrMsg').value
    },
    metadata: JSON.parse(document.getElementById('editMeta').value || '{}')
  };
  await api('PUT', '/api/models/' + id, body);
  toast('模型已保存');
  loadModels();
}

async function toggleError(id, mode) {
  await api('PUT', '/api/models/' + id + '/error', { error_mode: mode });
  toast(mode ? '错误模式已开启' : '错误模式已关闭');
  loadModels();
}

async function deleteModel(id) {
  if (!confirm('确认删除模型 ' + id + '?')) return;
  await api('DELETE', '/api/models/' + id);
  toast('模型已删除');
  loadModels();
}

function openCreateModal() {
  document.getElementById('createModal').style.display = 'flex';
}
function closeCreateModal() {
  document.getElementById('createModal').style.display = 'none';
}

async function createModel() {
  const body = {
    id: document.getElementById('newId').value,
    name: document.getElementById('newName').value,
    response: document.getElementById('newResponse').value
  };
  if (!body.id) { toast('模型 ID 不能为空', false); return; }
  await api('POST', '/api/models', body);
  toast('模型已创建');
  closeCreateModal();
  loadModels();
}

// 初始化
loadModels();
</script>
</body>
</html>`;
}

// ============================================================
//  主入口
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    // 获取配置
    const config = await getConfig(env);

    // 日志
    if (config.log_requests) {
      console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);
    }

    // CORS 预检
    if (method === 'OPTIONS' && config.enable_cors) {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // 健康检查
    if (matchRoute(method, pathname, 'GET /health')) {
      return json({ status: 'ok', timestamp: Date.now() });
    }

    // OpenAI: 列出模型
    if (matchRoute(method, pathname, 'GET /v1/models') || matchRoute(method, pathname, 'GET /models')) {
      return json(makeModelsList(config));
    }

    // OpenAI: 聊天补全
    if (matchRoute(method, pathname, 'POST /v1/chat/completions') || matchRoute(method, pathname, 'POST /chat/completions')) {
      return await handleChatCompletions(request, config);
    }

    // OpenAI: Responses API
    if (matchRoute(method, pathname, 'POST /v1/responses') || matchRoute(method, pathname, 'POST /responses')) {
      return await handleResponses(request, config);
    }

    // Claude: 模型列表
    if (matchRoute(method, pathname, 'GET /v1/models') === null && (matchRoute(method, pathname, 'GET /claude/v1/models') || matchRoute(method, pathname, 'GET /anthropic/v1/models'))) {
      return json(makeClaudeModelsList(config), 200, config);
    }

    // Claude: Messages
    if (matchRoute(method, pathname, 'POST /v1/messages') || matchRoute(method, pathname, 'POST /claude/v1/messages') || matchRoute(method, pathname, 'POST /anthropic/v1/messages')) {
      return await handleClaudeMessages(request, config);
    }

    // 管理接口
    const adminResult = await handleAdmin(method, pathname, request, config, env);
    if (adminResult) return adminResult;

    // Web 控制台
    if (method === 'GET' && (pathname === '/' || pathname === '')) {
      return html(consoleHTML(config));
    }

    return json(makeError(404, `Cannot ${method} ${pathname}`), 404);
  }
};