import { all, create } from 'mathjs';
import { validate } from './solver.js';
import { compactNumber } from './numbers.js';

const math = create(all, { number: 'BigNumber', precision: 64, predictable: true });
const operators = new Set(['add', 'subtract', 'multiply', 'divide', 'pow', 'unaryMinus', 'unaryPlus']);

export function checkResult(expression, precision, guess) {
  try {
    validate(expression, precision);
    const tree = math.parse(expression.replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-').replaceAll('**', '^'));
    tree.traverse(node => {
      if (node.isConstantNode || node.isParenthesisNode) return;
      if (node.isOperatorNode && operators.has(node.fn)) return;
      throw new Error('Unsupported expression');
    });
    const value = tree.compile().evaluate();
    const hasGuess = typeof guess === 'string' || Number.isFinite(guess);
    if (!math.isBigNumber(value) || !value.isFinite()) {
      return { status: hasGuess ? 'wrong' : 'undefined', actual: 'Undefined', precision };
    }
    const rounded = value.toDecimalPlaces(precision, 4);
    let status = 'unanswered';
    if (hasGuess) status = rounded.equals(math.bignumber(String(guess))) ? 'correct' : 'wrong';
    return { status, actual: compactNumber(rounded.toString()), precision };
  } catch {
    return { status: 'unavailable', actual: null, precision };
  }
}

if (import.meta.main) {
  const { expression, precision, guess } = JSON.parse(await Bun.stdin.text());
  console.log(JSON.stringify(checkResult(expression, precision, guess)));
}
