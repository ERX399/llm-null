#!/usr/bin/env node

// Dependency-free load tester for the mock OpenAI-compatible API.

const DEFAULT_PROMPT = 'Reply with the fixed test response.';

function usage() {
  console.log(`Usage: node load-test.mjs [options]

Options:
  --url <url>              Target URL (default: http://127.0.0.1:8787/v1/chat/completions)
  --model <id>             Model id (default: gpt-3o)
  --requests <n>           Total requests (default: 100)
  --concurrency <n>        In-flight requests (default: 10)
  --timeout-ms <n>         Per-request timeout (default: 30000)
  --fake                   Run against an in-process fake model, no network required
  --fake-delay-ms <n>      Fake model delay (default: 20)
  --fake-error-rate <n>    Fake error probability, 0 to 1 (default: 0)
  --json                   Print machine-readable JSON only
  --help                   Show this help

Examples:
  node load-test.mjs --fake --requests 1000 --concurrency 50
  node load-test.mjs --url http://127.0.0.1:8787/v1/chat/completions --requests 200
`);
}

function numberOption(options, name, fallback, { integer = true, min = 0, max = Infinity } = {}) {
  const value = options[name] === undefined ? fallback : Number(options[name]);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw new Error(`Invalid value for --${name}: ${options[name]}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') options.help = true;
    else if (arg === '--fake' || arg === '--json') options[arg.slice(2)] = true;
    else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
      options[name] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1);
  return values[index];
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`;
}

function makeRequestBody(model) {
  return {
    model,
    messages: [{ role: 'user', content: DEFAULT_PROMPT }],
    stream: false
  };
}

async function requestOnce(options) {
  const started = performance.now();
  if (options.fake) {
    await sleep(options.fakeDelayMs);
    if (Math.random() < options.fakeErrorRate) {
      return { ok: false, status: 503, latencyMs: performance.now() - started };
    }
    return { ok: true, status: 200, latencyMs: performance.now() - started };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeRequestBody(options.model)),
      signal: controller.signal
    });
    await response.arrayBuffer();
    return { ok: response.ok, status: response.status, latencyMs: performance.now() - started };
  } catch (error) {
    return {
      ok: false,
      status: error.name === 'AbortError' ? 'timeout' : 'network_error',
      latencyMs: performance.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

async function run(options) {
  const latencies = [];
  const statuses = {};
  let completed = 0;
  let succeeded = 0;
  const started = performance.now();
  let next = 0;

  async function worker() {
    while (true) {
      const requestNumber = next++;
      if (requestNumber >= options.requests) return;
      const result = await requestOnce(options);
      latencies.push(result.latencyMs);
      statuses[result.status] = (statuses[result.status] || 0) + 1;
      if (result.ok) succeeded++;
      completed++;
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, worker));
  latencies.sort((a, b) => a - b);
  const durationMs = performance.now() - started;
  const total = latencies.reduce((sum, value) => sum + value, 0);
  return {
    mode: options.fake ? 'fake' : 'http',
    url: options.fake ? null : options.url,
    model: options.model,
    requests: completed,
    concurrency: options.concurrency,
    succeeded,
    failed: completed - succeeded,
    successRate: completed ? succeeded / completed : 0,
    durationMs,
    throughputRps: completed / (durationMs / 1000),
    latencyMs: {
      min: latencies[0] || 0,
      average: completed ? total / completed : 0,
      p50: percentile(latencies, 0.50),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies[latencies.length - 1] || 0
    },
    statuses
  };
}

async function main() {
  const raw = parseArgs(process.argv.slice(2));
  if (raw.help) return usage();
  const options = {
    ...raw,
    url: raw.url || 'http://127.0.0.1:8787/v1/chat/completions',
    model: raw.model || 'gpt-3o',
    requests: numberOption(raw, 'requests', 100, { min: 1 }),
    concurrency: numberOption(raw, 'concurrency', 10, { min: 1 }),
    timeoutMs: numberOption(raw, 'timeout-ms', 30000, { min: 1 }),
    fakeDelayMs: numberOption(raw, 'fake-delay-ms', 20, { min: 0 }),
    fakeErrorRate: numberOption(raw, 'fake-error-rate', 0, { integer: false, min: 0, max: 1 })
  };
  options.concurrency = Math.min(options.concurrency, options.requests);
  const result = await run(options);
  if (options.json) return console.log(JSON.stringify(result));
  console.log(`Mode: ${result.mode}${result.url ? ` (${result.url})` : ''}`);
  console.log(`Requests: ${result.requests} | Concurrency: ${result.concurrency}`);
  console.log(`Success: ${result.succeeded} | Failed: ${result.failed} | Rate: ${(result.successRate * 100).toFixed(2)}%`);
  console.log(`Duration: ${formatMs(result.durationMs)} | Throughput: ${result.throughputRps.toFixed(2)} req/s`);
  console.log(`Latency: min ${formatMs(result.latencyMs.min)}, avg ${formatMs(result.latencyMs.average)}, p50 ${formatMs(result.latencyMs.p50)}, p95 ${formatMs(result.latencyMs.p95)}, p99 ${formatMs(result.latencyMs.p99)}, max ${formatMs(result.latencyMs.max)}`);
  console.log(`Statuses: ${Object.entries(result.statuses).map(([status, count]) => `${status}=${count}`).join(', ')}`);
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
