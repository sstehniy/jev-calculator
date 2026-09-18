import { test, expect } from 'bun:test';
import { solve, validate, RATE } from './solver.js';
import { compactNumber } from './numbers.js';

function modelFor(value, precision, { wrongMagnitude = false, rejectOnce = false, uncertain = false } = {}) {
  let calls = 0;

  return async ({ questions }) => {
    calls++;
    const answers = {};
    const text = String(value).replace('-', '');
    const [integer, fraction = ''] = text.split('.');
    const scaled = BigInt(integer + fraction.padEnd(precision, '0'));
    const number = Number(value);

    for (const [id, q] of Object.entries(questions)) {
      if (q.type === 'boolean') { answers[id] = { type: 'boolean', probability: 0.99 }; continue; }

      let chosen;

      if (id === 'sign') chosen = String(value).startsWith('-') ? 'negative' : 'positive';
      else if (id.startsWith('d')) {
        const p = Number(id.slice(1)) - 4;
        chosen = 'd' + (scaled / (10n ** BigInt(p + precision))) % 10n;
      } else if (id === 'magnitude') {
        const bound = text => {
          if (text.startsWith('10^')) return 10 ** Number(text.slice(3));

          return Number(text);
        };

        chosen = Object.keys(q.criteria).find(key => {
          const label = q.criteria[key];

          if (label === 'Zero') return number === 0;
          const match = label.match(/^(.*?) ≤ absolute answer < (.*)$/);

          if (match) return Math.abs(number) >= bound(match[1]) && Math.abs(number) < bound(match[2]);
          const more = label.match(/^Absolute answer is (.*?) or greater$/);

          if (more) return Math.abs(number) >= bound(more[1]);

          return false;
        });
      } else chosen = Object.keys(q.criteria).find(key => q.criteria[key] === compactNumber(value));

      if (id === 'answer' && rejectOnce && calls === 2) chosen = 'none';
      expect(chosen).toBeDefined();
      const probabilities = Object.fromEntries(Object.keys(q.criteria).map(key => [key, Number(key === chosen)]));

      if (id === 'magnitude' && wrongMagnitude) {
        probabilities[chosen] = 0.49; probabilities.r1 = 0.51; chosen = 'r1';
      }

      if (id === 'answer' && uncertain) { probabilities[chosen] = 0.6; probabilities.none = 0.4; }

      answers[id] = { type: 'choice', choice: chosen, probabilities };
    }

    return { answers, usage: { inputTokens: 100 }, providerMetadata: { gateway: { cost: '0.00001' } } };
  };
}

async function run(value, precision, options) {
  const events = [];
  await solve('200*123', precision, modelFor(value, precision, options), event => events.push(event));

  return events;
}

test('batched choices cover signed values, decimal boundaries, zero and costs', async () => {
  for (const [value, precision] of [[0, 0], [4, 2], [-42, 0], [24600, 0], [0.25, 2], [0.3333, 4], [-0.0001, 4], [999999.9999, 4]]) {
    const events = await run(value, precision);
    const final = events.at(-1);
    expect(final.type).toBe('done'); expect(final.value).toBe(String(value));
    expect(final.steps).toBe(2); expect(final.questions).toBe(9 + precision);
    expect(final.cost).toBeCloseTo(0.00002, 10); expect(final.tokens).toBe(200);
    expect(final.uncertain).toBe(false); expect(events[0].groups.length).toBe(8 + precision);
  }
});

test('retains the correct alternative after a 51% wrong magnitude choice', async () => {
  const events = await run(24600, 0, { wrongMagnitude: true });
  expect(events.at(-1).value).toBe('24600');
  expect(events.at(-1).steps).toBe(2);
});

test('recovers from rejected candidates and rechecks low probabilities automatically', async () => {
  const recovery = await run(24600, 0, { rejectOnce: true });
  expect(recovery.at(-1).value).toBe('24600'); expect(recovery.at(-1).steps).toBe(3);
  const uncertain = await run(5535, 0, { uncertain: true });
  expect(uncertain.at(-1).value).toBe('5535'); expect(uncertain.at(-1).steps).toBe(3);
  expect(uncertain.at(-1).uncertain).toBe(true); expect(uncertain.at(-1).cost).toBeCloseTo(0.00003, 10);
});

test('rejects invalid input and malformed responses, retains partial accounting', async () => {
  expect(() => validate('fetch(secret)', 2)).toThrow();
  expect(() => validate('2+2', 3)).toThrow();
  const events = [];
  await solve('2+2', 2, async () => ({ answers: {}, usage: { inputTokens: 100 } }), event => events.push(event));
  expect(events.at(-1).type).toBe('error'); expect(events.at(-1).cost).toBe(100 * RATE);
  let called = false;
  await solve('2+2', 0, async () => { called = true; }, () => {}, AbortSignal.abort());
  expect(called).toBe(false);
});

test('expands beyond a million and preserves large integer and decimal digits', async () => {
  for (const [value, precision] of [['1000000', 0], ['1234567890123', 0], ['-9007199254740993', 0], ['1234567890123456.7891', 4], ['1' + '0'.repeat(40), 0]]) {
    const events = await run(value, precision);
    expect(events.at(-1).type).toBe('done');
    expect(events.at(-1).value).toBe(compactNumber(value));
    expect(events.some(event => event.title === 'Explore larger magnitudes')).toBe(true);
    expect(events.some(event => event.title === 'Read the larger digits')).toBe(true);
  }
});
