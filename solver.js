import { decimalString, compactNumber } from './numbers.js';

export const RATE = 0.042 / 1_000_000;

export const fmt = n => Number(n.toFixed(4)).toString();

const PLACES = ['ten-thousandths', 'thousandths', 'hundredths', 'tenths', 'ones', 'tens', 'hundreds', 'thousands', 'ten-thousands', 'hundred-thousands'];

const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });

const ranked = probabilities => Object.entries(probabilities).sort((a, b) => b[1] - a[1]);

export function validate(expression, precision) {
  if (expression.length > 160 || !/[0-9]/.test(expression) || !/^[0-9\s.+\-*/^()%×÷−]+$/.test(expression)) throw new Error('Use numbers, parentheses, and arithmetic operators only.');

  if (![0, 2, 4].includes(precision)) throw new Error('Choose 0, 2, or 4 decimal places.');
}

export async function solve(expression, precision, evaluate, emit, signal) {
  validate(expression, precision);
  const started = performance.now();
  const normalized = expression.replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-');
  let state = `Calculate ${normalized}. Round the answer to ${precision} decimal places.`;

  if (normalized.includes('^')) state += ' The ^ operator means exponentiation.';

  if (normalized.includes('%')) state += ' The % operator means percent, not remainder.';
  let steps = 0, questionsCount = 0, tokens = 0, cost = 0, estimated = false, costKnown = true;
  const stats = () => ({ steps, questions: questionsCount, tokens, cost: costKnown ? cost : null, estimated, seconds: (performance.now() - started) / 1000 });

  async function ask(title, questions) {
    signal?.throwIfAborted();
    const result = await evaluate({ state, questions, abortSignal: signal });
    steps++;
    questionsCount += Object.keys(questions).length;
    const inputTokens = result.usage?.inputTokens;

    if (Number.isFinite(inputTokens) && inputTokens >= 0) tokens += inputTokens;
    const reported = result.providerMetadata?.gateway?.cost;

    if (reported != null && Number.isFinite(Number(reported)) && Number(reported) >= 0) cost += Number(reported);
    else if (Number.isFinite(inputTokens) && inputTokens >= 0) { cost += inputTokens * RATE; estimated = true; }
    else costKnown = false;
    const groups = [];

    for (const [id, question] of Object.entries(questions)) {
      const answer = result.answers?.[id];
      let options, selected, probability;

      if (question.type === 'boolean') {
        probability = answer?.probability;
        options = { yes: 'Correct', no: 'Incorrect' };
        selected = 'yes';

        if (probability < 0.5) selected = 'no';

        if (answer?.type !== 'boolean' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Jev returned an invalid verification.');
        groups.push({ title: question.instructions, choices: [{ label: 'Correct', probability, selected: selected === 'yes' }, { label: 'Incorrect', probability: 1 - probability, selected: selected === 'no' }] });
        continue;
      }

      options = question.criteria;
      selected = answer?.choice;

      if (answer?.type !== 'choice' || !Object.hasOwn(options, selected) || !answer.probabilities || Object.keys(answer.probabilities).length !== Object.keys(options).length || Object.entries(options).some(([key]) => !Number.isFinite(answer.probabilities[key]) || answer.probabilities[key] < 0 || answer.probabilities[key] > 1)) throw new Error('Jev returned an invalid choice distribution.');
      probability = answer.probabilities[selected];
      const confidence = result.providerMetadata?.typesafe?.confidence?.[id];
      groups.push({ title: question.instructions, probability, confidence, choices: Object.entries(options).map(([key, label]) => ({ label, selected: key === selected, probability: answer.probabilities[key] })) });
    }

    emit({ type: 'step', title, groups, probability: groups[0]?.probability, ...stats() });

    return result.answers;
  }

  try {
    const powerLabel = exponent => {
      if (exponent < 7) return fmt(10 ** exponent);

      return `10^${exponent}`;
    };

    const range = (lowExponent, highExponent) => ({
      low: 10n ** BigInt(lowExponent + precision),
      high: 10n ** BigInt(highExponent + precision + 1) - 1n,
      highExponent,
      label: `${powerLabel(lowExponent)} ≤ absolute answer < ${powerLabel(highExponent + 1)}`,
    });

    const ranges = [{ low: 0n, high: 0n, highExponent: 0, label: 'Zero' }];

    for (let exponent = -precision; exponent < 6; exponent++) ranges.push(range(exponent, exponent));

    const questions = {
      magnitude: choice('Which range contains the absolute answer?', { ...Object.fromEntries(ranges.map((r, i) => ['r' + i, r.label])), larger: 'Absolute answer is 1000000 or greater', invalid: 'Undefined or not a real number' }),
      sign: choice('Is the answer negative or nonnegative?', { positive: 'Zero or positive', negative: 'Negative' }),
    };

    const digitQuestion = p => {
      let place = PLACES[p + 4];

      if (!place) place = `10^${p} place`;

      return choice(`What is the ${place} digit of the absolute rounded answer? Leading and trailing missing digits are 0.`, Object.fromEntries(Array.from({ length: 10 }, (_, d) => ['d' + d, String(d)])));
    };

    // Independent digit questions save the network round trip for each range split.
    for (let p = 5; p >= -precision; p--) questions[`d${p + 4}`] = digitQuestion(p);
    const answers = await ask('Find magnitude & digits together', questions);

    for (const [i, range] of ranges.entries()) range.probability = answers.magnitude.probabilities['r' + i];
    let larger = answers.magnitude.probabilities.larger;
    let exponent = 6, width = 1;

    while (larger >= 0.1) {
      const expanded = Array.from({ length: 6 }, (_, i) => range(exponent + i * width, exponent + (i + 1) * width - 1));
      const ceiling = exponent + 6 * width;

      const answer = (await ask('Explore larger magnitudes', {
        magnitude: choice('Which range contains the absolute answer?', {
          ...Object.fromEntries(expanded.map((r, i) => ['r' + i, r.label])),
          larger: `Absolute answer is ${powerLabel(ceiling)} or greater`,
          smaller: `Absolute answer is less than ${powerLabel(exponent)}`,
          invalid: 'Undefined or not a real number',
        }),
      })).magnitude;

      for (const [i, range] of expanded.entries()) {
        range.probability = larger * answer.probabilities['r' + i];
        ranges.push(range);
      }

      larger *= answer.probabilities.larger;
      exponent = ceiling;
      width *= 2;
    }

    const plausible = ranges.filter(range => range.probability >= 0.01);
    const highest = Math.max(5, ...plausible.map(range => range.highExponent));

    // Batch digits to stay within provider request sizes as the number grows.
    for (let top = highest; top >= 6; top -= 16) {
      const batch = {};

      for (let p = top; p >= Math.max(6, top - 15); p--) batch[`d${p + 4}`] = digitQuestion(p);
      Object.assign(answers, await ask('Read the larger digits', batch));
    }

    const candidates = [];

    for (const range of plausible) {
      let beam = [{ value: 0n, score: Math.log(range.probability) }];

      for (let p = highest; p >= -precision; p--) {
        const place = 10n ** BigInt(p + precision), next = [];

        for (const path of beam) {
          for (let digit = 0; digit < 10; digit++) {
            const value = path.value + BigInt(digit) * place;

            if (value > range.high || value + place - 1n < range.low) continue;
            const probability = answers[`d${p + 4}`].probabilities['d' + digit];

            if (probability > 0) next.push({ value, score: path.score + Math.log(probability) });
          }
        }

        // ponytail: keep 32 paths per magnitude; widen only if measured candidate recall suffers.
        beam = next.sort((a, b) => b.score - a.score).slice(0, 32);
      }

      for (const path of beam) {
        for (const [id, sign] of [['positive', 1], ['negative', -1]]) {
          if (answers.sign.probabilities[id] > 0) {
            let value = decimalString(path.value, precision);

            if (sign < 0 && path.value !== 0n) value = '-' + value;
            candidates.push({ value, score: path.score + Math.log(answers.sign.probabilities[id]) });
          }
        }
      }
    }

    const values = [...new Set(candidates.sort((a, b) => b.score - a.score).map(candidate => candidate.value))].slice(0, 128);
    const labels = Object.fromEntries(values.map((value, i) => ['v' + i, compactNumber(value)]));
    const escapes = { none: 'None of these numbers is the correct rounded answer', invalid: 'Undefined or not a real number' };
    const initial = Object.fromEntries(Object.entries(labels).slice(0, 48));
    let final = (await ask(`Choose among ${Object.keys(initial).length} answers`, { answer: choice('What is the correct rounded answer to the arithmetic expression?', { ...initial, ...escapes }) })).answer;
    let verification;

    if (final.choice === 'none') {
      final = (await ask('Recover with more candidates', { answer: choice('Calculate the expression again. Select its correct rounded answer.', { ...labels, ...escapes }) })).answer;
    }

    if (final.choice.startsWith('v') && final.probabilities[final.choice] < 0.9) {
      const finalists = ranked(final.probabilities).filter(([id]) => id.startsWith('v')).slice(0, 8).map(([id]) => id).reverse();
      const recheck = { answer: choice(`Solve ${normalized}. Which number is the correct answer, rounded to ${precision} decimal places?`, { ...Object.fromEntries(finalists.map(id => [id, labels[id]])), none: 'None of these answers is correct' }) };

      for (const id of finalists) recheck[id] = { type: 'boolean', instructions: `Is this equation mathematically correct after rounding to ${precision} decimal places: ${normalized} = ${labels[id]}?` };
      const reviewed = await ask('Recheck the closest answers', recheck);
      final = reviewed.answer;
      verification = reviewed[final.choice]?.probability;
    }

    if (final.choice === 'invalid') throw new Error('Jev found an undefined result or a result that is not a real number.');

    if (final.choice === 'none') throw new Error('This one stumped Jev, even after a second look. Try another expression!');
    const probability = final.probabilities[final.choice];
    const uncertain = probability < 0.9 || (verification != null && verification < 0.9);
    emit({ type: 'done', value: compactNumber(values[Number(final.choice.slice(1))]), probability, verification, uncertain, ...stats() });
  } catch (error) {
    emit({ type: 'error', message: signal?.aborted ? 'Calculation stopped.' : error.message, ...stats() });
  }
}
