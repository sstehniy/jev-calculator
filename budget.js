import { Database } from 'bun:sqlite';
import { closeSync, openSync } from 'node:fs';

const LIMIT = 1_000_000_000; // Nanodollars keep accounting exact.
const RESERVE = 10_000_000;

export function openBudget(path) {
  const db = new Database(path, { readwrite: true, create: false });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
  const row = db.query('SELECT used FROM budget WHERE id = 1').get();
  if (!Number.isSafeInteger(row?.used) || row.used < 0) throw new Error('Invalid budget ledger.');
  return db;
}

export async function evaluateWithBudget(db, evaluate, request) {
  // $0.01 covers this bounded request at Jev's $0.042/M input price, with ample headroom.
  if (Buffer.byteLength(JSON.stringify({ state: request.state, questions: request.questions })) > 64_000) {
    throw new Error('This calculation needs a larger request than Jev can accept.');
  }
  request.abortSignal?.throwIfAborted();
  const reserved = db.query('UPDATE budget SET used = used + ? WHERE id = 1 AND blocked = 0 AND used <= ?').run(RESERVE, LIMIT - RESERVE);
  if (reserved.changes !== 1) throw new Error('The demo has reached its $1 lifetime budget. Thanks for playing!');
  // Failed, cancelled, or interrupted requests keep their reservation, including across restarts.
  const result = await evaluate(request);
  const reported = result.providerMetadata?.gateway?.cost;
  const cost = Math.ceil(Number(reported) * 1_000_000_000);
  if (reported != null && Number.isSafeInteger(cost) && cost >= 0) {
    if (cost > RESERVE) {
      db.query('UPDATE budget SET used = max(used, ?), blocked = 1 WHERE id = 1').run(LIMIT);
      throw new Error('Unexpected gateway pricing. The demo is paused to protect its budget.');
    }
    db.query('UPDATE budget SET used = used - ? WHERE id = 1').run(RESERVE - cost);
  }
  return result;
}

if (import.meta.main) {
  const [command, path] = process.argv.slice(2);
  if (command !== 'init' || !path) throw new Error('Usage: bun budget.js init /path/to/budget.sqlite');
  closeSync(openSync(path, 'wx', 0o600));
  const db = new Database(path);
  db.exec('CREATE TABLE budget (id INTEGER PRIMARY KEY CHECK(id = 1), used INTEGER NOT NULL CHECK(used >= 0), blocked INTEGER NOT NULL DEFAULT 0); INSERT INTO budget (id, used) VALUES (1, 0)');
  db.close();
  console.log('Initialized a new $1 lifetime ledger. Keep it for the lifetime of this API key.');
}
