import { test, expect } from 'bun:test';
import { checkResult } from './result-check.js';

test('compares the real rounded result, with arithmetic precedence and decimal precision', () => {
  for (const [expression, precision, expected] of [
    ['200*123', 0, '24600'], ['47×83', 0, '3901'], ['(12+8)÷3', 2, '6.67'],
    ['0.1+0.2', 2, '0.3'], ['1/3', 4, '0.3333'], ['1.005', 2, '1.01'],
    ['−1.005', 2, '-1.01'], ['-0.001', 2, '0'], ['2^3^2', 0, '512'],
    ['-2^2', 0, '-4'], ['2**8', 0, '256'], ['50%*8', 0, '4'], ['200+10%', 0, '220'],
  ]) {
    expect(checkResult(expression, precision, Number(expected))).toEqual({ status: 'correct', actual: expected, precision });
  }

  expect(checkResult('9007199254740992+1', 0, '9007199254740993').status).toBe('correct');
  expect(checkResult('9007199254740992+1', 0, '9007199254740992').status).toBe('wrong');
  expect(checkResult('47*83', 0, 391)).toEqual({ status: 'wrong', actual: '3901', precision: 0 });
  expect(checkResult('47*83', 0).status).toBe('unanswered');
  expect(checkResult('1/0', 0).status).toBe('undefined');
  expect(checkResult('(-1)^0.5', 2, 1).status).toBe('wrong');

  for (const invalid of ['2+', '8%3', 'process.exit()', '2;3', '2.constructor', '1'.repeat(161)]) {
    expect(checkResult(invalid, 0, 4).status).toBe('unavailable');
  }
});
