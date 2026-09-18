const $ = id => document.getElementById(id);
let precision = 0, running = false, completed = false;
const expression = $('expression');
const format = value => {
  const text = String(value);
  if (text.includes('e')) return text;
  const [integer, fraction] = text.split('.');
  let result = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (fraction) result += '.' + fraction;
  return result;
};
$('info').onclick = () => $('about').showModal();
$('close-about').onclick = () => $('about').close();
const shake = id => { const el = $(id); el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); };
document.querySelectorAll('[data-precision]').forEach(button => button.onclick = () => {
  precision = Number(button.dataset.precision);
  $('result-check').hidden = true;
  document.querySelectorAll('[data-precision]').forEach(b => { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); });
});
document.querySelectorAll('[data-key]').forEach(button => button.onclick = () => {
  if (running) return;
  $('result-check').hidden = true;
  const key = button.dataset.key;
  if (completed && /[0-9.(]/.test(key)) expression.value = '';
  completed = false;
  const start = expression.selectionStart ?? expression.value.length;
  const end = expression.selectionEnd ?? start;
  expression.setRangeText(key, start, end, 'end');
});
document.querySelector('[data-action="clear"]').onclick = () => { expression.value = ''; $('result-check').hidden = true; $('answer').textContent = '?'; completed = false; };
document.querySelector('[data-action="delete"]').onclick = () => {
  $('result-check').hidden = true;
  const start = expression.selectionStart ?? expression.value.length, end = expression.selectionEnd ?? start;
  expression.setRangeText('', Math.max(0, start - Number(start === end)), end, 'end');
};
expression.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); calculate(); } });
expression.addEventListener('input', () => { completed = false; $('result-check').hidden = true; });
function stats(event) {
  $('steps').textContent = event.steps;
  $('cost').textContent = event.cost === null ? 'Unknown' : '$' + event.cost.toFixed(8);
  $('cost-label').textContent = event.estimated ? 'estimated price' : 'total price';
  $('duration').textContent = event.seconds.toFixed(1) + 's';
  $('tokens').textContent = event.tokens.toLocaleString() + ' input tokens';
}
function showCheck(check) {
  if (!check) return;
  const tags = { correct: '✓ Correct', wrong: '✕ Miss', unanswered: '• No guess', undefined: '• Undefined', unavailable: '• No check' };
  $('result-check').hidden = false;
  $('result-check').dataset.status = check.status;
  if (check.status === 'wrong') shake('result-check');
  $('check-tag').textContent = tags[check.status];
  $('real-answer').textContent = 'Unavailable';
  if (check.actual !== null) {
    $('real-answer').textContent = format(check.actual);
  }
  $('result-check').title = `Real result rounded to ${check.precision} decimal places`;
}
function receive(event) {
  stats(event);
  if (event.type === 'step') {
    $('status').textContent = event.title + '…';
    $('live-label').textContent = 'Step ' + event.steps;
    const li = document.createElement('li'); li.className = 'step';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const title = document.createElement('strong'); title.textContent = `${event.steps}. ${event.title}`;
    const confidence = document.createElement('span'); confidence.textContent = event.groups.length + ' question' + (event.groups.length === 1 ? '' : 's');
    summary.append(title, confidence); details.append(summary);
    for (const group of event.groups) {
      const heading = document.createElement('p'); heading.className = 'question-title'; heading.textContent = group.title;
      details.append(heading);
      for (const choice of group.choices) {
        const row = document.createElement('div'); row.className = 'choice' + (choice.selected ? ' chosen' : '');
        const label = document.createElement('span'); label.textContent = (choice.selected ? '✓ ' : '') + choice.label;
        const p = document.createElement('b'); p.textContent = (choice.probability * 100).toFixed(1) + '%';
        row.append(label, p); details.append(row);
      }
    }
    li.append(details); $('history').append(li); $('history').scrollTop = $('history').scrollHeight;
  }
  if (event.type === 'done') {
    const result = format(event.value); $('answer').textContent = result; $('answer').classList.toggle('long', result.length > 9);
    $('status').textContent = 'Calculation complete'; $('live-label').textContent = 'Complete';
    if (event.uncertain) { $('status').textContent = 'Jev’s best guess'; $('live-label').textContent = 'Best guess'; }
    $('result-label').textContent = 'Final choice probability'; $('probability').textContent = (event.probability * 100).toFixed(1) + '%';
    $('note').textContent = `Jev chose ${result} from ${event.questions} questions in ${event.steps} gateway calls. Tap a step to peek at the choices.`;
    if (event.uncertain) $('note').textContent = `Jev is going with ${result}. That took a second look! ${event.questions} questions in ${event.steps} gateway calls.`;
    completed = true;
  }
  if (event.type === 'error') fail(event.message);
  if (event.check) showCheck(event.check);
}
function fail(message) { $('status').textContent = 'You stumped Jev'; $('live-label').textContent = 'Stumped'; $('answer').textContent = '?'; const note = $('note'); note.textContent = message; note.classList.remove('error', 'shake'); void note.offsetWidth; note.classList.add('error', 'shake'); }
async function calculate() {
  if (running || !expression.value.trim()) return;
  $('result-check').hidden = true;
  running = true; $('led').classList.add('busy');
  document.querySelectorAll('.keypad button, [data-precision]').forEach(b => b.disabled = true); expression.readOnly = true;
  $('history').replaceChildren(); $('note').classList.remove('error'); $('note').textContent = 'Jev is choosing. Open any step to inspect all its options.';
  $('answer').textContent = '…'; $('probability').textContent = ''; $('result-label').textContent = 'Finding the answer'; $('status').textContent = 'Reading magnitude & digits…'; $('live-label').textContent = 'Working';
  stats({ steps: 0, cost: 0, seconds: 0, tokens: 0 });
  let terminal = false;
  try {
    const response = await fetch('/api/calculate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expression: expression.value, precision }) });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not start calculation.');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        receive(event); if (event.type === 'done' || event.type === 'error') terminal = true;
      }
    }
    if (!terminal) throw new Error('Connection lost. Reported cost includes completed steps only.');
  } catch (error) { fail(error.message); }
  finally { running = false; $('led').classList.remove('busy'); expression.readOnly = false; document.querySelectorAll('.keypad button, [data-precision]').forEach(b => b.disabled = false); }
}
$('calculate').onclick = calculate;
expression.setSelectionRange(expression.value.length, expression.value.length);
