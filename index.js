// index.js — Mock LLM API for Cloudflare Worker
// OpenAI 兼容固定回复 API（无前端 UI）

import { DEFAULT_CONFIG, getConfig, saveConfig, deepMerge } from './config.js';

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
  return new Response(JSON.stringify(data), { status, headers });
}

function genId() {
  return 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function resolveModel(config, modelId) {
  if (!modelId) modelId = config.default_model_id;
  return config.models?.[modelId] || null;
}

// 路由匹配
function matchRoute(method, pathname, pattern) {
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

function makeError(code, message) {
  return { error: { code, message, type: 'mock_error' } };
}

// ============================================================
//  OpenAI Chat Completions
// ============================================================

function makeChatCompletion(modelId, content, modelCfg) {
  const message = { role: 'assistant', content };
  const finishReason = modelCfg.finish_reason || (modelCfg.tool_calls ? 'tool_calls' : 'stop');

  // reasoning_content / reasoning（DeepSeek 推理模型标准字段）
  if (modelCfg.reasoning_content) {
    message.reasoning_content = modelCfg.reasoning_content;
  }
  if (modelCfg.reasoning) {
    message.reasoning = modelCfg.reasoning;
  }

  if (modelCfg.tool_calls) {
    try {
      const tc = typeof modelCfg.tool_calls === 'string' ? JSON.parse(modelCfg.tool_calls) : modelCfg.tool_calls;
      if (Array.isArray(tc)) {
        message.tool_calls = tc.map((c, i) => ({
          id: c.id || ('call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)),
          type: c.type || 'function',
          function: { name: c.function?.name || c.name || '', arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments || c.arguments || {}) },
          index: c.index ?? i
        }));
        if (!content) message.content = null;
      }
    } catch {}
  }

  // 构建标准 usage 对象（含 prompt_tokens_details 和 completion_tokens_details）
  const reasoningTokens = modelCfg.reasoning_tokens || 0;
  const usage = modelCfg.usage
    ? (typeof modelCfg.usage === 'string' ? JSON.parse(modelCfg.usage) : modelCfg.usage)
    : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (!usage.prompt_tokens_details) {
    usage.prompt_tokens_details = {
      audio_tokens: 0,
      cached_tokens: 0,
      image_tokens: 0,
      video_tokens: 0
    };
  }
  if (!usage.completion_tokens_details) {
    usage.completion_tokens_details = reasoningTokens > 0
      ? { audio_tokens: 0, reasoning_tokens: reasoningTokens, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 }
      : null;
  }

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

async function handleChatCompletions(request, config) {
  try {
    let body;
    try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON body'), 400, config); }
    const modelId = body.model || config.default_model_id;
    const model = resolveModel(config, modelId);
    if (!model) return json(makeError(404, `Model '${modelId}' not found`), 404, config);
    if (model.error_mode) {
      const err = model.error || config.default_error;
      return json(makeError(err.code, err.message), err.code, config);
    }
    const delay = (model.delay_ms || 0) + (config.global_delay_ms || 0);
    if (delay > 0) await sleep(delay);
    const content = model.response;
    if (body.stream) return streamResponse(modelId, content, model, body);
    return json(makeChatCompletion(modelId, content, model), 200, config);
  } catch (e) {
    return json(makeError(500, 'Internal error: ' + (e.message || String(e))), 500, config);
  }
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

  // 构建标准 usage（含 prompt_tokens_details 和 completion_tokens_details）
  function buildUsage() {
    const reasoningTokens = model.reasoning_tokens || 0;
    let usage;
    if (model.usage) {
      try { usage = typeof model.usage === 'string' ? JSON.parse(model.usage) : model.usage; } catch { usage = {}; }
    } else {
      usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    }
    if (!usage.prompt_tokens_details) {
      usage.prompt_tokens_details = { audio_tokens: 0, cached_tokens: 0, image_tokens: 0, video_tokens: 0 };
    }
    if (!usage.completion_tokens_details) {
      usage.completion_tokens_details = reasoningTokens > 0
        ? { audio_tokens: 0, reasoning_tokens: reasoningTokens, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 }
        : null;
    }
    return usage;
  }

  const stream = new ReadableStream({
    async start(controller) {
      // 先输出 reasoning_content（如果有）
      if (model.reasoning_content) {
        const rc = model.reasoning_content;
        const rcChunkSize = model.stream_chunk_size > 0 ? model.stream_chunk_size : rc.length;
        for (let i = 0; i < rc.length; i += rcChunkSize) {
          controller.enqueue(sendChunk({ reasoning_content: rc.slice(i, i + rcChunkSize) }));
        }
      }
      // 再输出正文 content
      for (let i = 0; i < content.length; i += chunkSize) {
        controller.enqueue(sendChunk({ content: content.slice(i, i + chunkSize) }));
      }
      const finishReason = model.finish_reason || (model.tool_calls ? 'tool_calls' : 'stop');
      const usage = buildUsage();
      const done = {
        id, object: 'chat.completion.chunk', created, model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage
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
//  Anthropic Claude Messages
// ============================================================

function claudeErrorType(code) {
  const m = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_denied_error', 404: 'not_found_error', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' };
  return m[code] || 'api_error';
}

function makeClaudeError(code, message) {
  return { type: 'error', error: { type: claudeErrorType(code), message } };
}

function makeClaudeMessage(modelId, modelCfg) {
  const content = [];
  let stopReason = 'end_turn';

  // Claude thinking/reasoning block
  if (modelCfg.reasoning || modelCfg.reasoning_content) {
    const thinkingText = modelCfg.reasoning || modelCfg.reasoning_content;
    content.push({ type: 'thinking', thinking: thinkingText, signature: '' });
  }

  if (modelCfg.tool_calls) {
    try {
      const tc = typeof modelCfg.tool_calls === 'string' ? JSON.parse(modelCfg.tool_calls) : modelCfg.tool_calls;
      if (Array.isArray(tc)) {
        for (const c of tc) {
          content.push({ type: 'tool_use', id: c.id || ('toolu_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)), name: c.function?.name || c.name || '', input: typeof c.function?.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : (c.function?.arguments || c.arguments || {}) });
        }
        stopReason = 'tool_use';
      }
    } catch {}
  }
  content.push({ type: 'text', text: modelCfg.response });
  let usage = { input_tokens: 0, output_tokens: 0 };
  if (modelCfg.usage) {
    try { const u = typeof modelCfg.usage === 'string' ? JSON.parse(modelCfg.usage) : modelCfg.usage; usage = { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 }; } catch {}
  }
  return {
    id: 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
    type: 'message', role: 'assistant', model: modelId, content,
    stop_reason: modelCfg.finish_reason || stopReason, stop_sequence: null,
    usage
  };
}

function makeClaudeModelsList(config) {
  return { data: Object.values(config.models || {}).map(m => ({
    id: m.id, display_name: m.name,
    created_at: Math.floor(Date.now() / 1000), type: 'model'
  })) };
}

async function handleClaudeMessages(request, config) {
  try {
    let body;
    try { body = await request.json(); } catch { return json(makeClaudeError(400, 'Invalid JSON body'), 400, config); }
    const modelId = body.model || config.default_model_id;
    const model = resolveModel(config, modelId);
    if (!model) return json(makeClaudeError(404, `Model '${modelId}' not found`), 404, config);
    if (model.error_mode) {
      const err = model.error || config.default_error;
      return json(makeClaudeError(err.code, err.message), err.code, config);
    }
    const delay = (model.delay_ms || 0) + (config.global_delay_ms || 0);
    if (delay > 0) await sleep(delay);
    if (body.stream) return streamClaudeResponse(modelId, model);
    return json(makeClaudeMessage(modelId, model), 200, config);
  } catch (e) {
    return json(makeClaudeError(500, 'Internal error: ' + (e.message || String(e))), 500, config);
  }
}

function streamClaudeResponse(modelId, model) {
  const msgId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const enc = new TextEncoder();
  const chunkSize = model.stream_chunk_size > 0 ? model.stream_chunk_size : 0;

  function ev(type, data) {
    return enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const stream = new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(ev('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: modelId, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
      
      // thinking/reasoning block
      if (model.reasoning || model.reasoning_content) {
        const thinkingText = model.reasoning || model.reasoning_content || '';
        ctrl.enqueue(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }));
        if (chunkSize > 0) {
          for (let i = 0; i < thinkingText.length; i += chunkSize) ctrl.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinkingText.slice(i, i + chunkSize) } }));
        } else {
          ctrl.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinkingText } }));
        }
        ctrl.enqueue(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
      }
      
      // text block
      ctrl.enqueue(ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
      const c = model.response;
      if (chunkSize > 0) {
        for (let i = 0; i < c.length; i += chunkSize) ctrl.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: c.slice(i, i + chunkSize) } }));
      } else {
        ctrl.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: c } }));
      }
      ctrl.enqueue(ev('content_block_stop', { type: 'content_block_stop', index: 1 }));
      const claudeStreamStopReason = model.finish_reason || (model.tool_calls ? 'tool_use' : 'end_turn');
      ctrl.enqueue(ev('message_delta', { type: 'message_delta', delta: { stop_reason: claudeStreamStopReason, stop_sequence: null }, usage: { output_tokens: 0 } }));
      ctrl.enqueue(ev('message_stop', { type: 'message_stop' }));
      ctrl.close();
    }
  });

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
}

// ============================================================
//  OpenAI Responses API
// ============================================================

function makeResponsesResult(modelId, modelCfg) {
  const out = [];
  
  // reasoning 输出项（OpenAI Responses API 格式）
  if (modelCfg.reasoning_content || modelCfg.reasoning) {
    const rcText = modelCfg.reasoning_content || modelCfg.reasoning;
    out.push({
      type: 'reasoning',
      id: 'rs_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
      summary: [{ type: 'summary_text', text: rcText }]
    });
  }
  
  if (modelCfg.tool_calls) {
    try {
      const tc = typeof modelCfg.tool_calls === 'string' ? JSON.parse(modelCfg.tool_calls) : modelCfg.tool_calls;
      if (Array.isArray(tc)) {
        for (const c of tc) {
          out.push({ type: 'tool_call', id: c.id || ('call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)),
            tool: c.function?.name || c.name || '', arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments || c.arguments || {}) });
        }
      }
    } catch {}
  }
  out.push({ type: 'message', role: 'assistant', id: 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    content: [{ type: 'output_text', text: modelCfg.response || '', annotations: [] }] });
  
  // 构建标准 usage（含 input_tokens_details 和 output_tokens_details）
  const reasoningTokens = modelCfg.reasoning_tokens || 0;
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  if (modelCfg.usage) {
    try { usage = typeof modelCfg.usage === 'string' ? JSON.parse(modelCfg.usage) : modelCfg.usage; } catch {}
  }
  if (!usage.input_tokens_details) {
    usage.input_tokens_details = { cached_tokens: 0 };
  }
  if (!usage.output_tokens_details) {
    usage.output_tokens_details = reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : null;
  }
  
  return {
    id: 'resp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
    object: 'response', created_at: Math.floor(Date.now() / 1000),
    model: modelId, output: out, status: 'completed',
    usage
  };
}

async function handleResponses(request, config) {
  try {
    let body;
    try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON body'), 400, config); }
    const modelId = body.model || config.default_model_id;
    const model = resolveModel(config, modelId);
    if (!model) return json(makeError(404, `Model '${modelId}' not found`), 404, config);
    if (model.error_mode) {
      const err = model.error || config.default_error;
      return json(makeError(err.code, err.message), err.code, config);
    }
    const delay = (model.delay_ms || 0) + (config.global_delay_ms || 0);
    if (delay > 0) await sleep(delay);
    if (body.stream) return streamResponses(modelId, model);
    return json(makeResponsesResult(modelId, model), 200, config);
  } catch (e) {
    return json(makeError(500, 'Internal error: ' + (e.message || String(e))), 500, config);
  }
}

function streamResponses(modelId, model) {
  const respId = 'resp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const enc = new TextEncoder();
  const chunkSize = model.stream_chunk_size > 0 ? model.stream_chunk_size : 0;

  function ev(type, data) {
    return enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // 构建标准 usage
  function buildUsage() {
    const reasoningTokens = model.reasoning_tokens || 0;
    let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    if (model.usage) {
      try { usage = typeof model.usage === 'string' ? JSON.parse(model.usage) : model.usage; } catch {}
    }
    if (!usage.input_tokens_details) {
      usage.input_tokens_details = { cached_tokens: 0 };
    }
    if (!usage.output_tokens_details) {
      usage.output_tokens_details = reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : null;
    }
    return usage;
  }

  const stream = new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(ev('response.created', { type: 'response.created', response: { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: modelId, status: 'in_progress', output: [] } }));
      
      // reasoning 流式输出
      const rcText = model.reasoning_content || model.reasoning || '';
      if (rcText) {
        const rsId = 'rs_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
        ctrl.enqueue(ev('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: rsId, output_index: 0, delta: rcText }));
        ctrl.enqueue(ev('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: rsId, output_index: 0, text: rcText }));
      }

      const c = model.response || '';
      if (chunkSize > 0) {
        for (let i = 0; i < c.length; i += chunkSize) ctrl.enqueue(ev('response.output_text.delta', { type: 'response.output_text.delta', delta: c.slice(i, i + chunkSize) }));
      } else {
        ctrl.enqueue(ev('response.output_text.delta', { type: 'response.output_text.delta', delta: c }));
      }
      ctrl.enqueue(ev('response.output_text.done', { type: 'response.output_text.done', text: c }));
      
      const usage = buildUsage();
      const finalOutput = [];
      if (rcText) {
        finalOutput.push({ type: 'reasoning', id: 'rs_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24), summary: [{ type: 'summary_text', text: rcText }] });
      }
      finalOutput.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: c, annotations: [] }] });
      ctrl.enqueue(ev('response.completed', { type: 'response.completed', response: { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: modelId, status: 'completed', output: finalOutput, usage } }));
      ctrl.close();
    }
  });

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
}

// ============================================================
//  管理接口
// ============================================================

async function handleAdmin(method, pathname, request, config, env) {
  if (!config.enable_admin) return json(makeError(403, 'Admin API disabled'), 403, config);

  let params;
  if ((params = matchRoute(method, pathname, 'GET /api/config')) !== null) return json(config, 200, config);

  if ((params = matchRoute(method, pathname, 'PUT /api/config')) !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400, config); }
    const ok = await saveConfig(env, body);
    return json({ status: ok ? 'saved' : 'no_kv', config: body }, 200, config);
  }

  if ((params = matchRoute(method, pathname, 'PATCH /api/config')) !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400, config); }
    const merged = deepMerge(config, body);
    const ok = await saveConfig(env, merged);
    return json({ status: ok ? 'saved' : 'no_kv', config: merged }, 200, config);
  }

  if ((params = matchRoute(method, pathname, 'GET /api/models')) !== null) return json({ models: config.models || {} }, 200, config);

  if ((params = matchRoute(method, pathname, 'POST /api/models')) !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400, config); }
    const mid = body.id || '';
    if (!mid) return json(makeError(400, 'Field "id" is required'), 400, config);
    if (!config.models) config.models = {};
    if (config.models[mid]) return json(makeError(409, `Model '${mid}' already exists`), 409, config);
    const maxNum = Math.max(0, ...Object.values(config.models).map(m => m.number || 0));
    config.models[mid] = {
      id: mid,
      name: body.name || mid,
      number: body.number || maxNum + 1,
      response: body.response || '默认回复',
      error_mode: body.error_mode || false,
      error: body.error || config.default_error,
      delay_ms: body.delay_ms || 0,
      max_tokens: body.max_tokens || 4096,
      temperature: body.temperature || 1.0,
      stream_chunk_size: body.stream_chunk_size || 0,
      metadata: body.metadata || {},
      finish_reason: body.finish_reason || '',
      reasoning_content: body.reasoning_content || '',
      reasoning: body.reasoning || '',
      reasoning_tokens: body.reasoning_tokens || 0,
      tool_calls: body.tool_calls || '',
      usage: body.usage || ''
    };
    const ok = await saveConfig(env, config);
    return json({ status: ok ? 'created' : 'no_kv', model: config.models[mid] }, 201, config);
  }

  if ((params = matchRoute(method, pathname, 'PUT /api/models/:id')) !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400, config); }
    const m = config.models?.[params.id];
    if (!m) return json(makeError(404, `Model '${params.id}' not found`), 404, config);
    Object.assign(m, body);
    m.id = params.id;
    const ok = await saveConfig(env, config);
    return json({ status: ok ? 'updated' : 'no_kv', model: m }, 200, config);
  }

  if ((params = matchRoute(method, pathname, 'PUT /api/models/:id/response')) !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400, config); }
    const m = config.models?.[params.id];
    if (!m) return json(makeError(404, `Model '${params.id}' not found`), 404, config);
    m.response = body.response ?? '';
    const ok = await saveConfig(env, config);
    return json({ status: ok ? 'updated' : 'no_kv', model_id: params.id, response: m.response }, 200, config);
  }

  if ((params = matchRoute(method, pathname, 'PUT /api/models/:id/error')) !== null) {
    let body; try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON'), 400, config); }
    const m = config.models?.[params.id];
    if (!m) return json(makeError(404, `Model '${params.id}' not found`), 404, config);
    if ('error_mode' in body) m.error_mode = body.error_mode;
    if (body.error) m.error = { ...m.error, ...body.error };
    const ok = await saveConfig(env, config);
    return json({ status: ok ? 'updated' : 'no_kv', model_id: params.id, error_mode: m.error_mode, error: m.error }, 200, config);
  }

  if ((params = matchRoute(method, pathname, 'DELETE /api/models/:id')) !== null) {
    if (!config.models?.[params.id]) return json(makeError(404, `Model '${params.id}' not found`), 404, config);
    delete config.models[params.id];
    const ok = await saveConfig(env, config);
    return json({ status: ok ? 'deleted' : 'no_kv', model_id: params.id }, 200, config);
  }

  return null;
}

// ============================================================
//  主入口
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    const config = await getConfig(env);

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
      return json({ status: 'ok', timestamp: Date.now() }, 200, config);
    }

    // OpenAI: 模型列表
    if (matchRoute(method, pathname, 'GET /v1/models') || matchRoute(method, pathname, 'GET /models')) {
      return json(makeModelsList(config), 200, config);
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
    if (matchRoute(method, pathname, 'GET /claude/v1/models') || matchRoute(method, pathname, 'GET /anthropic/v1/models')) {
      return json(makeClaudeModelsList(config), 200, config);
    }

    // Claude: Messages
    if (matchRoute(method, pathname, 'POST /v1/messages') || matchRoute(method, pathname, 'POST /claude/v1/messages') || matchRoute(method, pathname, 'POST /anthropic/v1/messages')) {
      return await handleClaudeMessages(request, config);
    }

    // 管理接口
    const adminResult = await handleAdmin(method, pathname, request, config, env);
    if (adminResult) return adminResult;

    return json(makeError(404, `Cannot ${method} ${pathname}`), 404, config);
  }
};
