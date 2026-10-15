/** Shared boundary validation. Adapters must never trust model or webhook input. */
export class TowerError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TowerError';
    this.code = code;
    this.status = status;
  }
}

export function ensure(condition, code, message, status) {
  if (!condition) throw new TowerError(code, message, status);
}

export function text(value, label, max = 65536) {
  ensure(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max,
    'INVALID_INPUT', `${label} must be a nonempty string of at most ${max} bytes`);
  return value;
}

export function identifier(value, label = 'id') {
  text(value, label, 200);
  ensure(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/.test(value), 'INVALID_INPUT', `${label} has invalid characters`);
  return value;
}

export function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  ensure(Number.isSafeInteger(value) && value >= min && value <= max,
    'INVALID_INPUT', `${label} must be an integer from ${min} to ${max}`);
  return value;
}

export function oneOf(value, values, label) {
  ensure(values.includes(value), 'INVALID_INPUT', `${label} must be one of ${values.join(', ')}`);
  return value;
}
