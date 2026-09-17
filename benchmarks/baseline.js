export const RATE = 0.042 / 1_000_000;
export const fmt = n => Number(n.toFixed(4)).toLocaleString('en-US', { maximumFractionDigits: 4, useGrouping: false });

export function validate(expression, precision) {
  if (typeof expression !== 'string' || expression.length > 160 || !/[0-9]/.test(expression) || !/^[0-9\s.+\-*/^()%×÷−]+$/.test(expression)) throw new Error('Use numbers, parentheses, and arithmetic operators only.');
  if (![0, 2, 4].includes(precision)) throw new Error('Choose 0, 2, or 4 decimal places.');
}

export async function solve(expression, precision, evaluate, emit, signal) {
  validate(expression, precision);
  const scale = 10 ** precision;
  const started = performance.now();
  let steps = 0, tokens = 0, cost = 0, estimated = false, costKnown = true, weakest = 1;
  const stats = () => ({ steps, tokens, cost: costKnown ? cost : null, estimated, seconds: (performance.now() - started) / 1000 });
  async function ask(title, criteria, instructions) {
    signal?.throwIfAborted();
    const result = await evaluate({
      state: `Calculate: ${expression.replaceAll("×", "*").replaceAll("÷", "/").replaceAll("−", "-")}. Round to ${precision} decimal places (half away from zero).`,
      questions: { answer: { type: 'choice', instructions, criteria } },
      abortSignal: signal,
    });
    steps++;
    if (Number.isFinite(result.usage?.inputTokens)) tokens += result.usage.inputTokens;
    else costKnown = false;
    const reportedCost = result.providerMetadata?.gateway?.cost;
    if (reportedCost != null && Number.isFinite(Number(reportedCost))) cost += Number(reportedCost);
    else { cost += (result.usage?.inputTokens ?? 0) * RATE; estimated = true; }
    const answer = result.answers?.answer;
    if (!answer || !Object.hasOwn(criteria, answer.choice)) throw new Error('Jev returned an invalid choice. Try again.');
    const probability = answer.probabilities?.[answer.choice];
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Jev did not return a valid probability.');
    weakest = Math.min(weakest, probability);
    emit({ type: 'step', title, choices: Object.entries(criteria).map(([id, label]) => ({ label, selected: id === answer.choice, probability: answer.probabilities?.[id] ?? null })), probability, ...stats() });
    return { choice: answer.choice, probability };
  }
  try {
    const ranges = [];
    const criteria = { zero: 'The rounded answer is exactly 0.' };
    for (const sign of [1, -1]) {
      for (let exponent = -precision; exponent < 6; exponent++) {
        const low = Math.round(10 ** exponent * scale), high = Math.round(10 ** (exponent + 1) * scale) - 1;
        const id = `r${ranges.length}`;
        ranges.push({ id, sign, low, high });
        criteria[id] = `${sign === 1 ? 'Positive' : 'Negative'} answer, absolute value ${fmt(low / scale)} to ${fmt(high / scale)} inclusive.`;
      }
    }
    criteria.other = 'Undefined, not a real number, invalid expression, or absolute rounded answer is 1000000 or greater.';
    const first = await ask('Find the magnitude', criteria, 'Calculate the expression. Choose the range containing the rounded answer. Consider both sign and magnitude.');
    if (first.choice === 'other') throw new Error('Jev found an undefined result or a value outside ±999,999. Try a smaller expression.');
    let value = 0, finalProbability = first.probability;
    if (first.choice !== 'zero') {
      let { low, high, sign } = ranges.find(r => r.id === first.choice);
      while (high - low >= 5) {
        const mid = Math.floor((low + high) / 2);
        const lower = `${fmt(low / scale)} to ${fmt(mid / scale)}`;
        const upper = `${fmt((mid + 1) / scale)} to ${fmt(high / scale)}`;
        const next = await ask('Narrow the range', { lower: `Absolute rounded answer is ${lower}, inclusive.`, upper: `Absolute rounded answer is ${upper}, inclusive.`, neither: 'Neither range contains the absolute rounded answer.' }, `What is ${expression}? Select the range containing the absolute value of the answer rounded to ${precision} decimal places. Compare the answer against BOTH endpoints.`);
        if (next.choice === 'neither') throw new Error('Jev disagreed with an earlier range. Run again to retry.');
        if (next.choice === 'lower') high = mid;
        else low = mid + 1;
      }
      const candidates = {};
      for (let n = low; n <= high; n++) candidates[`n${n}`] = `The rounded answer is ${fmt(sign * n / scale)}.`;
      candidates.neither = 'None of these answers is correct.';
      const final = await ask('Choose the answer', candidates, 'Calculate the expression independently and choose its correct rounded answer.');
      if (final.choice === 'neither') throw new Error('Jev rejected the final candidates. Run again to retry.');
      value = sign * Number(final.choice.slice(1)) / scale;
      finalProbability = final.probability;
    }
    emit({ type: 'done', value, probability: finalProbability, weakest, ...stats() });
  } catch (error) {
    emit({ type: 'error', message: signal?.aborted ? 'Calculation stopped.' : error.message, ...stats() });
  }
}
