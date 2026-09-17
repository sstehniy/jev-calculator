export function decimalString(value, precision) {
  let digits = value.toString().padStart(precision + 1, '0');
  if (precision) digits = `${digits.slice(0, -precision)}.${digits.slice(-precision)}`.replace(/\.?0+$/, '');
  return digits;
}

export function compactNumber(value) {
  const text = String(value);
  const match = text.match(/^(-?)(\d{19,})(?:\.(\d+))?$/);
  if (!match) return text;
  const digits = (match[2] + (match[3] || '')).replace(/0+$/, '');
  let mantissa = digits[0];
  if (digits.length > 1) mantissa += '.' + digits.slice(1);
  return `${match[1]}${mantissa}e+${match[2].length - 1}`;
}
