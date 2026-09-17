import { experimental_evaluate as evaluate } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { solve, validate } from './solver.js';
import { openBudget, evaluateWithBudget } from './budget.js';

if (!process.env.AI_GATEWAY_API_KEY) throw new Error('Set AI_GATEWAY_API_KEY in .env');
const gateway = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
const budget = openBudget(process.env.BUDGET_DB || './data/budget.sqlite');
let active = 0;
let starts = [];
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const headers = {
  'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000',
};
const errorResponse = (error, status) => Response.json({ error }, { status, headers });

async function checkResult(expression, precision, guess) {
  // Isolate expensive arithmetic so an expression cannot block the web server.
  const child = Bun.spawn([process.execPath, 'result-check.js'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  child.stdin.write(JSON.stringify({ expression, precision, guess }));
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
  try {
    const output = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error('Check timed out');
    return JSON.parse(output);
  } catch { return { status: 'unavailable', actual: null, precision }; }
  finally { clearTimeout(timer); }
}

const server = Bun.serve({
  hostname: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3217), idleTimeout: 240, maxRequestBodySize: 1024,
  error() { return errorResponse('Request could not be completed.', 500); },
  async fetch(req) {
    const url = new URL(req.url);
    if (['GET', 'HEAD'].includes(req.method) && files[url.pathname]) {
      const [file, type] = files[url.pathname];
      return new Response(Bun.file(new URL(file, import.meta.url)), { headers: { ...headers, 'content-type': type } });
    }
    if (url.pathname !== '/api/calculate' || req.method !== 'POST') return errorResponse('Not found', 404);
    if (req.headers.get('content-type')?.split(';')[0] !== 'application/json') return errorResponse('Use application/json.', 415);
    if (req.headers.get('sec-fetch-site') === 'cross-site') return errorResponse('Invalid origin', 403);
    if (req.headers.get('origin')) {
      let origin;
      try { origin = new URL(req.headers.get('origin')); } catch { return errorResponse('Invalid origin', 403); }
      if (origin.origin !== (process.env.PUBLIC_ORIGIN || url.origin)) return errorResponse('Invalid origin', 403);
    }
    let body;
    try {
      const text = await req.text();
      if (text.length > 1024) throw new Error('Expression is too long.');
      body = JSON.parse(text);
      validate(body.expression, body.precision);
    } catch { return errorResponse('Use a short arithmetic expression and 0, 2, or 4 decimal places.', 400); }
    if (active >= 2) return errorResponse('The calculator is busy. Try again shortly.', 429);
    starts = starts.filter(time => time > Date.now() - 60000);
    // ponytail: one shared 30/minute limit for this tiny public demo; use per-user limits if it grows.
    if (starts.length >= 30) return errorResponse('Give Jev a breather. Try again in a minute.', 429);
    starts.push(Date.now());
    active++;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, req.signal, AbortSignal.timeout(180000)]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let terminal;
        const write = data => {
          if (!abort.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
        };
        const emit = data => {
          if (data.type === 'done' || data.type === 'error') terminal = data;
          else write(data);
        };
        try {
          await solve(body.expression, body.precision, request => evaluateWithBudget(budget, async request => {
            try { return await evaluate({ ...request, model: gateway.evaluationModel('typesafe-ai/jev'), maxRetries: 0 }); }
            catch { throw new Error('The gateway request failed. Please try again. Any unreported usage is excluded from the estimate.'); }
          }, request), emit, signal);
          if (terminal && !abort.signal.aborted) {
            terminal.check = await checkResult(body.expression, body.precision, terminal.value);
            write(terminal);
          }
        } finally { active--; if (!abort.signal.aborted) controller.close(); }
      },
      cancel() { abort.abort(); },
    });
    return new Response(stream, { headers: { ...headers, 'content-type': 'application/x-ndjson' } });
  },
});
console.log(`Jev calculator: ${server.url}`);
