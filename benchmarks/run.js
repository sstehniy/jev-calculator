import { experimental_evaluate as evaluate } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { writeFile } from 'node:fs/promises';

const { solve } = await import(process.argv[2] || './baseline.js');

const gateway = createGateway();

export const cases = [
  ['2 * 2', 0, 4], ['2 * 2', 2, 4], ['12 + 8', 0, 20], ['7 - 12', 0, -5],
  ['1 / 4', 2, 0.25], ['1 / 3', 4, 0.3333], ['(12 + 8) * 3', 0, 60],
  ['123 * 45', 0, 5535], ['999 + 1', 0, 1000], ['0.1 + 0.2', 2, 0.3],
  ['15 * 17', 0, 255], ['2 ^ 8', 0, 256],
];

const results = [];

for (const [expression, precision, expected] of cases) {
  let last;
  const calls = [];
  await solve(expression, precision, async request => {
    const start = performance.now();
    const result = await evaluate({ ...request, model: gateway.evaluationModel('typesafe-ai/jev'), maxRetries: 0 });
    calls.push({ ms: performance.now() - start, questions: Object.keys(request.questions).length });

    return result;
  }, event => { last = event; }, AbortSignal.timeout(45000));
  const row = { expression, precision, expected, correct: last.type === 'done' && String(last.value) === String(expected), ...last, calls };
  results.push(row); console.log(JSON.stringify(row));
}

const median = values => { values.sort((a,b) => a-b); const mid = Math.floor(values.length / 2);

 if (values.length % 2) return values[mid];

 return (values[mid - 1] + values[mid]) / 2; };

console.log(JSON.stringify({ summary: true, correct: results.filter(r => r.correct).length, total: results.length, medianSeconds: median(results.map(r=>r.seconds)), medianSteps: median(results.map(r=>r.steps)), totalCost: results.reduce((sum,r)=>sum+(r.cost||0),0), totalCallMs: results.flatMap(r=>r.calls).reduce((sum,c)=>sum+c.ms,0) }));

await writeFile(process.argv[3] || 'benchmarks/baseline.json', JSON.stringify(results, null, 2));
