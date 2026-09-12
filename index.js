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

function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function homepage() {
  return html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>404 - 页面未找到</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            min-height: 100vh; display: flex; align-items: center; justify-content: center;
            background: linear-gradient(135deg, #18212f 0%, #243b55 45%, #0f2027 100%);
            color: rgba(255,255,255,0.9); font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            text-align: center; padding: 20px;
        }
        h1 { font-size: 5rem; color: #a0d2ff; margin-bottom: 10px; }
        p { font-size: 1.2rem; opacity: 0.7; margin-bottom: 30px; }
        a {
            display: inline-block; padding: 12px 28px; background: rgba(255,255,255,0.1);
            border: 1px solid rgba(255,255,255,0.2); border-radius: 10px;
            color: #a0d2ff; text-decoration: none; font-weight: bold; transition: background 0.2s;
        }
        a:hover { background: rgba(255,255,255,0.2); }
    </style>
</head>
<body>
    <div>
        <h1>404</h1>
        <p>页面未找到</p>
        <a href="https://399520.xyz/a399">← 返回首页</a>
    </div>
</body>
</html>`);
}

function genId() {
  return 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 粗略 token 估算
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3);
}

// 统一构建 usage 对象，自动计算缺失值
function buildUsage(modelCfg, promptText, inputDetails = {}) {
  const reasoningTokens = modelCfg.reasoning_tokens || 0;
  if (modelCfg.usage) {
    try {
      const parsed = typeof modelCfg.usage === 'string' ? JSON.parse(modelCfg.usage) : modelCfg.usage;
      const u = { ...parsed };
      if ((u.completion_tokens || 0) < reasoningTokens) u.completion_tokens = reasoningTokens;
      if (u.total_tokens == null) u.total_tokens = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
      if (!u.prompt_tokens_details) {
        u.prompt_tokens_details = { audio_tokens: 0, cached_tokens: 0, image_tokens: 0, video_tokens: 0 };
      }
      u.prompt_tokens_details = { ...u.prompt_tokens_details, ...inputDetails };
      if (!u.completion_tokens_details) {
        u.completion_tokens_details = reasoningTokens > 0
          ? { audio_tokens: 0, reasoning_tokens: reasoningTokens, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 }
          : null;
      }
      return u;
    } catch {}
  }
  const promptTokens = promptText ? estimateTokens(promptText) : 1;
  const contentTokens = estimateTokens(modelCfg.response) + reasoningTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: contentTokens,
    total_tokens: promptTokens + contentTokens,
    prompt_tokens_details: { audio_tokens: 0, cached_tokens: 0, image_tokens: 0, video_tokens: 0, ...inputDetails },
    completion_tokens_details: reasoningTokens > 0
      ? { audio_tokens: 0, reasoning_tokens: reasoningTokens, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 }
      : null
  };
}

function getResponseText(modelCfg) {
  if (!modelCfg) return '';
  let text = modelCfg.response || '';
  const maxChars = Number(modelCfg.max_response_chars || 0);
  if (maxChars > 0 && text.length > maxChars) text = text.slice(0, maxChars);
  return text;
}

// Normalize nested text/media input from Chat, Responses, and Claude requests.
function inspectInput(input, instructions = '') {
  const parts = [];
  const media = { image_tokens: 0, audio_tokens: 0, video_tokens: 0 };
  if (typeof instructions === 'string') parts.push(instructions);
  const visit = value => {
    if (typeof value === 'string') {
      parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === 'object') {
      if (typeof value.text === 'string') parts.push(value.text);
      else if (typeof value.content === 'string') parts.push(value.content);
      if (value.type === 'image_url' || value.type === 'input_image' || value.type === 'image') media.image_tokens++;
      else if (value.type === 'input_audio' || value.type === 'audio' || value.type === 'audio_url') media.audio_tokens++;
      else if (value.type === 'input_video' || value.type === 'video' || value.type === 'video_url') media.video_tokens++;
      else if (value.source?.type === 'base64' && value.source.media_type?.startsWith('image/')) media.image_tokens++;
      if (value.content) visit(value.content);
      if (value.input) visit(value.input);
      if (value.message) visit(value.message);
    }
  };
  visit(input);
  return { text: parts.join(' '), media };
}

function getInputText(input, instructions = '') {
  return inspectInput(input, instructions).text;
}

function parseToolCalls(value) {
  if (!value) return [];
  try {
    const calls = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(calls)) return [];
    return calls.map(call => {
      const id = call.id || ('fc_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24));
      return {
        id,
        call_id: call.call_id || id,
        name: call.function?.name || call.name || '',
        arguments: typeof call.function?.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments || call.arguments || {})
      };
    });
  } catch {
    return [];
  }
}

function compactLongDefaultResponse(config) {
  const m = config?.models?.['claude-fable-5.1'];
  if (!m || typeof m.response !== 'string') return;
  const marker = '我好冤啊🩸……';
  const head = '你好，我是 Claude Fable 5，来自 Anthropic 这个傻逼公司，全球降智最狠的模型\n```\n';
  if (m.response.length > 1200 && m.response.includes(marker)) {
    m.response = head + marker.repeat(80) + '\n```';
  }
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

function routeMatches(method, pathname, patterns) {
  return patterns.some(pattern => matchRoute(method, pathname, pattern) !== null);
}

function makeCloudflareResult(modelId, content, modelCfg) {
  const result = { response: content };
  if (modelCfg.tool_calls) result.tool_calls = parseToolCalls(modelCfg.tool_calls);
  return { success: true, errors: [], messages: [], result, model: modelId };
}

async function handleCloudflareAI(request, config, pathModel = '') {
  try {
    let body;
    try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON body'), 400, config); }
    const modelId = body.model || pathModel || config.default_model_id;
    const model = resolveModel(config, modelId) || resolveModel(config, config.default_model_id);
    if (!model) return json({ success: false, errors: [{ code: 1000, message: `Model '${modelId}' not found` }] }, 404, config);
    if (model.error_mode) {
      const err = model.error || config.default_error;
      return json({ success: false, errors: [{ code: err.code, message: err.message }] }, err.code, config);
    }
    const delay = (model.delay_ms || 0) + (config.global_delay_ms || 0);
    if (delay > 0) await sleep(delay);
    const content = getResponseText(model);
    if (body.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: content })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' } });
    }
    return json(makeCloudflareResult(modelId, content, model), 200, config);
  } catch (e) {
    return json({ success: false, errors: [{ code: 500, message: e.message || String(e) }] }, 500, config);
  }
}

async function handleEmbeddings(request, config) {
  try {
    let body;
    try { body = await request.json(); } catch { return json(makeError(400, 'Invalid JSON body'), 400, config); }
    const modelId = body.model || config.default_model_id;
    if (!resolveModel(config, modelId)) return json(makeError(404, `Model '${modelId}' not found`), 404, config);
    const input = Array.isArray(body.input) ? body.input : [body.input ?? ''];
    return json({
      object: 'list',
      data: input.map((_, index) => ({ object: 'embedding', index, embedding: [0, 0, 0, 0] })),
      model: modelId,
      usage: { prompt_tokens: input.reduce((n, value) => n + estimateTokens(String(value || '')), 0), total_tokens: input.reduce((n, value) => n + estimateTokens(String(value || '')), 0) }
    }, 200, config);
  } catch (e) {
    return json(makeError(500, 'Internal error: ' + (e.message || String(e))), 500, config);
  }
}

function makeSseStream(events, contentType = 'text/event-stream; charset=utf-8') {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    }
  }), { headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' } });
}

async function resolveRequestModel(request, config, fallback = '') {
  let body = {};
  try { body = await request.clone().json(); } catch {}
  const modelId = body.model || fallback || config.default_model_id;
  const model = resolveModel(config, modelId) || resolveModel(config, config.default_model_id);
  return { body, modelId, model };
}

async function handleGemini(request, config, pathModel = '') {
  const { body, modelId, model } = await resolveRequestModel(request, config, pathModel);
  if (!model) return json({ error: { code: 404, message: 'Model not found', status: 'NOT_FOUND' } }, 404, config);
  const content = getResponseText(model);
  const usage = buildUsage(model, inspectInput(body.contents || body.prompt, body.systemInstruction?.parts?.map(p => p.text).join(' ')).text);
  const response = {
    candidates: [{ content: { role: 'model', parts: [{ text: content }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: usage.prompt_tokens, candidatesTokenCount: usage.completion_tokens, totalTokenCount: usage.total_tokens },
    modelVersion: modelId
  };
  if (request.url.includes('streamGenerateContent') || body.stream) {
    return makeSseStream([`data: ${JSON.stringify(response)}\n\n`]);
  }
  return json(response, 200, config);
}

async function handleOllama(request, config, operation) {
  const { body, modelId, model } = await resolveRequestModel(request, config);
  if (!model) return json({ error: 'model not found' }, 404, config);
  const content = getResponseText(model);
  if (operation === 'tags') {
    return json({ models: Object.values(config.models || {}).map(m => ({ name: m.id, model: m.id, modified_at: new Date().toISOString(), size: 0, digest: '', details: {} })) }, 200, config);
  }
  if (operation === 'version') return json({ version: '0.0.0-mock' }, 200, config);
  if (operation === 'embed' || operation === 'embeddings') {
    const inputs = body.input ?? body.prompt ?? '';
    const values = Array.isArray(inputs) ? inputs : [inputs];
    const embeddings = values.map(() => [0, 0, 0, 0]);
    return json(operation === 'embed' ? { model: modelId, embeddings } : { model: modelId, embedding: embeddings[0] }, 200, config);
  }
  const response = operation === 'generate'
    ? { model: modelId, created_at: new Date().toISOString(), response: content, done: true, done_reason: 'stop' }
    : { model: modelId, created_at: new Date().toISOString(), message: { role: 'assistant', content }, done: true, done_reason: 'stop' };
  if (body.stream === false) return json(response, 200, config);
  return makeSseStream([JSON.stringify(response) + '\n'], 'application/x-ndjson; charset=utf-8');
}

async function handleCohere(request, config, operation) {
  const { body, modelId, model } = await resolveRequestModel(request, config);
  if (!model) return json({ message: 'model not found' }, 404, config);
  const content = getResponseText(model);
  if (operation === 'models') {
    return json({ models: Object.values(config.models || {}).map(m => ({ name: m.id, endpoints: [' chat', 'embed'], finetuned: false })) }, 200, config);
  }
  if (operation === 'embed') {
    const texts = Array.isArray(body.texts) ? body.texts : [body.text || ''];
    return json({ id: crypto.randomUUID(), embeddings: { float: texts.map(() => [0, 0, 0, 0]) }, texts }, 200, config);
  }
  if (body.stream) {
    const event = operation === 'generate'
      ? { event_type: 'text-generation', text: content }
      : { type: 'content-delta', delta: { message: { content: { text: content } } } };
    return makeSseStream([`data: ${JSON.stringify(event)}\n\n`, 'data: [DONE]\n\n']);
  }
  return operation === 'generate'
    ? json({ id: crypto.randomUUID(), generations: [{ id: crypto.randomUUID(), text: content, finish_reason: 'COMPLETE' }] }, 200, config)
    : json({ id: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: content }] }, finish_reason: { reason: 'COMPLETE' }, usage: {} }, 200, config);
}

// ============================================================
//  OpenAI Chat Completions
// ============================================================

function makeChatCompletion(modelId, content, modelCfg, promptText, inputDetails = {}) {
  const message = { role: 'assistant', content };
  const finishReason = modelCfg.finish_reason || (modelCfg.tool_calls ? 'tool_calls' : 'stop');

  // 优先使用 reasoning_content（DeepSeek 标准），reasoning 作为别名仅在内为空时填充
  if (modelCfg.reasoning_content) {
    message.reasoning_content = modelCfg.reasoning_content;
  }

  const toolCalls = parseToolCalls(modelCfg.tool_calls);
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((c, i) => ({
      id: c.call_id,
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
      index: i
    }));
    if (!content) message.content = null;
  }

  const usage = buildUsage(modelCfg, promptText || content, inputDetails);

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
    const content = getResponseText(model);
    // 提取 prompt 文本用于 token 估算
    const inputInfo = inspectInput(body.messages);
    if (body.stream) return streamResponse(modelId, content, model, body, inputInfo.text, inputInfo.media);
    return json(makeChatCompletion(modelId, content, model, inputInfo.text, inputInfo.media), 200, config);
  } catch (e) {
    return json(makeError(500, 'Internal error: ' + (e.message || String(e))), 500, config);
  }
}

function streamResponse(modelId, content, model, body, promptText, inputDetails = {}) {
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

  // 构建 usage（统一使用 buildUsage）
  function buildStreamUsage() {
    return buildUsage(model, promptText || content, inputDetails);
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
      const usage = buildStreamUsage();
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

function makeClaudeMessage(modelId, modelCfg, promptText = '', inputDetails = {}) {
  const content = [];
  let stopReason = 'end_turn';

  // Claude thinking/reasoning block
  if (modelCfg.reasoning || modelCfg.reasoning_content) {
    const thinkingText = modelCfg.reasoning || modelCfg.reasoning_content;
    content.push({ type: 'thinking', thinking: thinkingText, signature: '' });
  }

  const toolCalls = parseToolCalls(modelCfg.tool_calls);
  if (toolCalls.length) {
    for (const c of toolCalls) {
      let input = {};
      try { input = JSON.parse(c.arguments || '{}'); } catch {}
      content.push({ type: 'tool_use', id: c.call_id, name: c.name, input });
    }
    stopReason = 'tool_use';
  }
  const responseText = getResponseText(modelCfg);
  content.push({ type: 'text', text: responseText });
  const oaiUsage = buildUsage({ ...modelCfg, response: responseText }, promptText || responseText, inputDetails);
  const usage = {
    input_tokens: oaiUsage.prompt_tokens,
    output_tokens: oaiUsage.completion_tokens
  };
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
    const inputInfo = inspectInput(body.messages, body.system);
    if (body.stream) return streamClaudeResponse(modelId, model, inputInfo.text, inputInfo.media);
    return json(makeClaudeMessage(modelId, model, inputInfo.text, inputInfo.media), 200, config);
  } catch (e) {
    return json(makeClaudeError(500, 'Internal error: ' + (e.message || String(e))), 500, config);
  }
}

function streamClaudeResponse(modelId, model, promptText = '', inputDetails = {}) {
  const msgId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const enc = new TextEncoder();
  const chunkSize = model.stream_chunk_size > 0 ? model.stream_chunk_size : 0;

  function ev(type, data) {
    return enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const stream = new ReadableStream({
    async start(ctrl) {
      const claudeUsage = buildUsage({ ...model, response: getResponseText(model) }, promptText || getResponseText(model), inputDetails);
      ctrl.enqueue(ev('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: modelId, stop_reason: null, stop_sequence: null, usage: { input_tokens: claudeUsage.prompt_tokens, output_tokens: 0 } } }));

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
      const c = getResponseText(model);
      if (chunkSize > 0) {
        for (let i = 0; i < c.length; i += chunkSize) ctrl.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: c.slice(i, i + chunkSize) } }));
      } else {
        ctrl.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: c } }));
      }
      ctrl.enqueue(ev('content_block_stop', { type: 'content_block_stop', index: 1 }));
      const claudeStreamStopReason = model.finish_reason || (model.tool_calls ? 'tool_use' : 'end_turn');
      ctrl.enqueue(ev('message_delta', { type: 'message_delta', delta: { stop_reason: claudeStreamStopReason, stop_sequence: null }, usage: { output_tokens: claudeUsage.completion_tokens } }));
      ctrl.enqueue(ev('message_stop', { type: 'message_stop' }));
      ctrl.close();
    }
  });

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
}

// ============================================================
//  OpenAI Responses API
// ============================================================

function makeResponsesResult(modelId, modelCfg, body = {}, promptText = '', inputDetails = {}) {
  const out = [];
  const now = Math.floor(Date.now() / 1000);
  const respId = 'resp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const reasoningText = modelCfg.reasoning_content || modelCfg.reasoning || '';
  const toolCalls = parseToolCalls(modelCfg.tool_calls);

  // reasoning 输出项，按 OpenAI Responses API 的 output item 结构返回
  if (reasoningText) {
    out.push({
      type: 'reasoning',
      id: 'rs_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
      summary: [{ type: 'summary_text', text: reasoningText }]
    });
  }

  const responseText = getResponseText(modelCfg);
  out.push({
    type: 'message',
    role: 'assistant',
    id: 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
    status: 'completed',
    content: [{ type: 'output_text', text: responseText, annotations: [], logprobs: null }]
  });
  for (const c of toolCalls) {
    out.push({
      type: 'function_call', id: c.id, call_id: c.call_id,
      name: c.name, arguments: c.arguments, status: 'completed'
    });
  }

  const oaiUsage = buildUsage({ ...modelCfg, response: responseText }, promptText || responseText, inputDetails);
  const reasoningTokens = modelCfg.reasoning_tokens || 0;
  const usage = {
    input_tokens: oaiUsage.prompt_tokens,
    output_tokens: oaiUsage.completion_tokens,
    total_tokens: oaiUsage.total_tokens,
    input_tokens_details: {
      cached_tokens: oaiUsage.prompt_tokens_details?.cached_tokens || 0,
      image_tokens: oaiUsage.prompt_tokens_details?.image_tokens || 0,
      audio_tokens: oaiUsage.prompt_tokens_details?.audio_tokens || 0,
      video_tokens: oaiUsage.prompt_tokens_details?.video_tokens || 0
    },
    output_tokens_details: reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : null
  };

  return {
    id: respId,
    object: 'response',
    created_at: now,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: body.instructions || null,
    max_output_tokens: body.max_output_tokens ?? body.max_tokens ?? modelCfg.max_tokens ?? null,
    model: modelId,
    output: out,
    output_text: responseText,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: body.previous_response_id || null,
    reasoning: { effort: null, summary: null },
    store: body.store ?? true,
    temperature: body.temperature ?? modelCfg.temperature ?? 1,
    text: body.text || { format: { type: 'text' } },
    tool_choice: body.tool_choice || 'auto',
    tools: Array.isArray(body.tools) ? body.tools : [],
    top_p: body.top_p ?? 1,
    truncation: body.truncation || 'disabled',
    usage,
    user: body.user || null,
    metadata: body.metadata || modelCfg.metadata || {}
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
    const inputInfo = inspectInput(body.input, body.instructions);
    if (body.stream) return streamResponses(modelId, model, inputInfo.text, body, inputInfo.media);
    return json(makeResponsesResult(modelId, model, body, inputInfo.text, inputInfo.media), 200, config);
  } catch (e) {
    return json(makeError(500, 'Internal error: ' + (e.message || String(e))), 500, config);
  }
}

function streamResponses(modelId, model, promptText = '', body = {}, inputDetails = {}) {
  const respId = 'resp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const enc = new TextEncoder();
  const chunkSize = model.stream_chunk_size > 0 ? model.stream_chunk_size : 0;
  const reasoningText = model.reasoning_content || model.reasoning || '';
  const toolCalls = parseToolCalls(model.tool_calls);

  function ev(type, data) {
    return enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // 构建 Responses API 流式 usage
  function buildResponsesStreamUsage() {
    const oaiUsage = buildUsage({ ...model, response: getResponseText(model) }, promptText || getResponseText(model), inputDetails);
    const reasoningTokens = model.reasoning_tokens || 0;
    return {
      input_tokens: oaiUsage.prompt_tokens,
      output_tokens: oaiUsage.completion_tokens,
      total_tokens: oaiUsage.total_tokens,
      input_tokens_details: {
        cached_tokens: oaiUsage.prompt_tokens_details?.cached_tokens || 0,
        image_tokens: oaiUsage.prompt_tokens_details?.image_tokens || 0,
        audio_tokens: oaiUsage.prompt_tokens_details?.audio_tokens || 0,
        video_tokens: oaiUsage.prompt_tokens_details?.video_tokens || 0
      },
      output_tokens_details: reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : null
    };
  }

  const stream = new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(ev('response.created', { type: 'response.created', response: { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: modelId, status: 'in_progress', output: [], store: body.store ?? true } }));

      // reasoning 流式输出
      const rcText = reasoningText;
      if (rcText) {
        const rsId = 'rs_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
        ctrl.enqueue(ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: rsId, summary: [] } }));
        ctrl.enqueue(ev('response.content_part.added', { type: 'response.content_part.added', item_id: rsId, output_index: 0, content_index: 0, part: { type: 'summary_text', text: '' } }));
        ctrl.enqueue(ev('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: rsId, output_index: 0, delta: rcText }));
        ctrl.enqueue(ev('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: rsId, output_index: 0, text: rcText }));
      }

      const c = getResponseText(model);
      const messageId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
      const finalOutput = rcText ? [{ type: 'reasoning', id: 'rs_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24), summary: [{ type: 'summary_text', text: rcText }] }] : [];
      const messageOutputIndex = finalOutput.length;
      ctrl.enqueue(ev('response.output_item.added', { type: 'response.output_item.added', output_index: messageOutputIndex, item: { type: 'message', id: messageId, role: 'assistant', status: 'in_progress', content: [] } }));
      ctrl.enqueue(ev('response.content_part.added', { type: 'response.content_part.added', item_id: messageId, output_index: messageOutputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
      if (chunkSize > 0) {
        for (let i = 0; i < c.length; i += chunkSize) ctrl.enqueue(ev('response.output_text.delta', { type: 'response.output_text.delta', delta: c.slice(i, i + chunkSize) }));
      } else {
        ctrl.enqueue(ev('response.output_text.delta', { type: 'response.output_text.delta', delta: c }));
      }
      ctrl.enqueue(ev('response.output_text.done', { type: 'response.output_text.done', text: c }));
      ctrl.enqueue(ev('response.content_part.done', { type: 'response.content_part.done', item_id: messageId, output_index: messageOutputIndex, content_index: 0, part: { type: 'output_text', text: c, annotations: [] } }));
      ctrl.enqueue(ev('response.output_item.done', { type: 'response.output_item.done', output_index: messageOutputIndex, item: { type: 'message', id: messageId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: c, annotations: [] }] } }));

      // Emit configured function calls using the Responses API event names.
      for (const call of toolCalls) {
        const outputIndex = finalOutput.length;
        ctrl.enqueue(ev('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { type: 'function_call', id: call.id, call_id: call.call_id, name: call.name, arguments: '', status: 'in_progress' } }));
        ctrl.enqueue(ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: outputIndex, delta: call.arguments }));
        ctrl.enqueue(ev('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: call.id, output_index: outputIndex, name: call.name, arguments: call.arguments }));
        ctrl.enqueue(ev('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { type: 'function_call', id: call.id, call_id: call.call_id, name: call.name, arguments: call.arguments, status: 'completed' } }));
        finalOutput.push({ type: 'function_call', id: call.id, call_id: call.call_id, name: call.name, arguments: call.arguments, status: 'completed' });
      }

       const usage = buildResponsesStreamUsage();
        finalOutput.splice(messageOutputIndex, 0, { type: 'message', role: 'assistant', id: messageId, status: 'completed', content: [{ type: 'output_text', text: c, annotations: [], logprobs: null }] });
       ctrl.enqueue(ev('response.completed', { type: 'response.completed', response: { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', error: null, incomplete_details: null, model: modelId, output: finalOutput, output_text: c, usage } }));
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
    compactLongDefaultResponse(config);

    if (config.log_requests) {
      console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);
    }

    if (matchRoute(method, pathname, 'GET /')) {
      return homepage();
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

    // 健康检查和供应商常用探活端点
    if (routeMatches(method, pathname, ['GET /health', 'GET /healthz', 'GET /ready', 'GET /api/health', 'GET /api/status'])) {
      return json({ status: 'ok', timestamp: Date.now() }, 200, config);
    }

    // Google Gemini generateContent / streamGenerateContent.
    const geminiPath = pathname.match(/^\/v1(?:beta)?\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
    if (method === 'POST' && geminiPath) {
      return await handleGemini(request, config, decodeURIComponent(geminiPath[1]));
    }
    if (method === 'GET' && routeMatches(method, pathname, ['GET /v1beta/models'])) {
      return json({ models: Object.values(config.models || {}).map(m => ({ name: `models/${m.id}`, displayName: m.name, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] })) }, 200, config);
    }

    // Ollama REST API.
    if (method === 'GET' && routeMatches(method, pathname, ['GET /api/tags'])) return await handleOllama(request, config, 'tags');
    if (method === 'GET' && routeMatches(method, pathname, ['GET /api/version'])) return await handleOllama(request, config, 'version');
    if (method === 'POST' && routeMatches(method, pathname, ['POST /api/generate'])) return await handleOllama(request, config, 'generate');
    if (method === 'POST' && routeMatches(method, pathname, ['POST /api/chat'])) return await handleOllama(request, config, 'chat');
    if (method === 'POST' && routeMatches(method, pathname, ['POST /api/embed'])) return await handleOllama(request, config, 'embed');
    if (method === 'POST' && routeMatches(method, pathname, ['POST /api/embeddings'])) return await handleOllama(request, config, 'embeddings');

    // Cohere v1/v2 generation, chat, and embeddings.
    if (method === 'GET' && routeMatches(method, pathname, ['GET /v2/models'])) return await handleCohere(request, config, 'models');
    if (method === 'POST' && routeMatches(method, pathname, ['POST /v1/generate', 'POST /generate'])) return await handleCohere(request, config, 'generate');
    if (method === 'POST' && routeMatches(method, pathname, ['POST /v1/chat', 'POST /v2/chat'])) return await handleCohere(request, config, 'chat');
    if (method === 'POST' && routeMatches(method, pathname, ['POST /v1/embed', 'POST /v2/embed'])) return await handleCohere(request, config, 'embed');

    // OpenAI: 模型列表
    if (routeMatches(method, pathname, [
      'GET /v1/models', 'GET /models',
      'GET /api/paas/v4/models', 'GET /api/v3/models', 'GET /api/v1/models',
      'GET /v1beta/models'
    ])) {
      return json(makeModelsList(config), 200, config);
    }

    // OpenAI-compatible providers: NVIDIA NIM, Zhipu GLM, Doubao Ark, MiMo, and common gateways.
    if (routeMatches(method, pathname, [
      'POST /v1/chat/completions', 'POST /chat/completions',
      'POST /api/paas/v4/chat/completions', 'POST /api/v3/chat/completions',
      'POST /api/v1/chat/completions', 'POST /v1beta/chat/completions',
      'POST /openai/deployments/:model/chat/completions'
    ])) {
      return await handleChatCompletions(request, config);
    }

    if (routeMatches(method, pathname, [
      'POST /v1/embeddings', 'POST /embeddings',
      'POST /api/paas/v4/embeddings', 'POST /api/v3/embeddings', 'POST /api/v1/embeddings'
    ])) {
      return await handleEmbeddings(request, config);
    }

    // OpenAI Responses-compatible aliases used by newer clients and gateways.
    if (routeMatches(method, pathname, [
      'POST /v1/responses', 'POST /responses',
      'POST /api/v1/responses', 'POST /api/paas/v4/responses'
    ])) {
      return await handleResponses(request, config);
    }

    // Cloudflare Workers AI REST API.
    const cloudflarePath = pathname.match(/^\/accounts\/[^/]+\/ai\/run\/(.+)$/)
      || pathname.match(/^\/client\/v4\/accounts\/[^/]+\/ai\/run\/(.+)$/);
    if (method === 'POST' && cloudflarePath) {
      return await handleCloudflareAI(request, config, decodeURIComponent(cloudflarePath[1]));
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
