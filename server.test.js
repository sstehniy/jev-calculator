import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBudget } from './budget.js';

test('HTTP boundary protects files, rejects cross-site requests, and blocks exhausted budgets before billing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-http-'));
  const path = join(dir, 'budget.sqlite');
  Bun.spawnSync([process.execPath, 'budget.js', 'init', path]);
  const db = openBudget(path);
  db.query('UPDATE budget SET used = 1000000000').run();
  db.close();
  const server = Bun.spawn([process.execPath, 'server.js'], {
    env: { ...process.env, AI_GATEWAY_API_KEY: 'test-no-real-key', BUDGET_DB: path, PORT: '0', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'https://jev-calculator.vercel.app,https://oracle.tail92806c.ts.net' },
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const reader = server.stdout.getReader();
    const first = await reader.read();
    const url = new TextDecoder().decode(first.value).match(/http:\/\/[^\s]+/)[0];
    reader.releaseLock();
    const home = await fetch(url);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('href="/favicon.svg"');
    const favicon = await fetch(url + 'favicon.svg');
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get('content-type')).toContain('image/svg+xml');
    expect(await favicon.text()).toContain('<svg');
    expect(home.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    for (const file of ['.env', '.secrets/oracle.env', 'budget.sqlite', 'server.js']) expect((await fetch(url + file)).status).toBe(404);
    const post = options => fetch(url + 'api/calculate', { method: 'POST', ...options });
    expect((await post({ body: '{}' })).status).toBe(415);
    const headers = { 'content-type': 'application/json' };
    expect((await post({ headers: { ...headers, origin: 'https://attacker.invalid' }, body: '{}' })).status).toBe(403);
    expect((await post({ headers, body: '{' })).status).toBe(400);
    expect((await post({ headers, body: JSON.stringify({ expression: 'fetch(secret)', precision: 0 }) })).status).toBe(400);
    expect((await post({ headers, body: 'a'.repeat(1025) })).status).toBe(413);
    const response = await post({ headers: { ...headers, origin: 'https://jev-calculator.vercel.app' }, body: JSON.stringify({ expression: '2*2', precision: 0 }) });
    const event = JSON.parse((await response.text()).trim());
    expect(event.type).toBe('error');
    expect(event.message).toContain('$1 lifetime budget');
    expect(event.steps).toBe(0);
    expect(event.check.actual).toBe('4');
    expect(event.cost).toBe(0);
  } finally {
    server.kill();
    await server.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
