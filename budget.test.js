import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBudget, evaluateWithBudget } from './budget.js';

test('lifetime budget survives restarts, reserves concurrent calls, and fails closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-budget-'));
  const path = join(dir, 'budget.sqlite');
  let db;
  const request = { state: '2*2', questions: {} };
  const result = { providerMetadata: { gateway: { cost: '0.000001' } } };
  try {
    expect(() => openBudget(path)).toThrow();
    expect(Bun.spawnSync([process.execPath, 'budget.js', 'init', path]).exitCode).toBe(0);
    db = openBudget(path);
    await evaluateWithBudget(db, async () => result, request);
    expect(db.query('SELECT used FROM budget').get().used).toBe(1000);
    await expect(evaluateWithBudget(db, async () => { throw new Error('network'); }, request)).rejects.toThrow('network');
    await evaluateWithBudget(db, async () => ({}), request);
    db.close();
    db = openBudget(path);
    expect(db.query('SELECT used FROM budget').get().used).toBe(20_001_000);
    expect(Bun.spawnSync([process.execPath, 'budget.js', 'init', path]).exitCode).not.toBe(0);
    db.query('UPDATE budget SET used = 980000000').run();
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const calls = [evaluateWithBudget(db, () => pending, request), evaluateWithBudget(db, () => pending, request)];
    let called = false;
    await expect(evaluateWithBudget(db, () => { called = true; }, request)).rejects.toThrow('$1');
    expect(called).toBe(false);
    finish(result);
    await Promise.all(calls);
    expect(db.query('SELECT used FROM budget').get().used).toBe(980_002_000);
    await expect(evaluateWithBudget(db, () => { called = true; }, { ...request, state: 'a'.repeat(64001) })).rejects.toThrow('larger request');
    expect(called).toBe(false);
    await expect(evaluateWithBudget(db, async () => ({ providerMetadata: { gateway: { cost: '0.02' } } }), request)).rejects.toThrow('pricing');
    expect(db.query('SELECT used FROM budget').get().used).toBe(1_000_000_000);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
