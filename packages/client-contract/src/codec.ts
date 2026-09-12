/** Small dependency-free decoders for JSON crossing a process or storage boundary. */
export type Decoder<T> = (value: unknown, at?: string) => T;
export class ContractError extends Error {
  constructor(
    readonly at: string,
    message: string,
  ) {
    super(`${at}: ${message}`);
    this.name = 'ContractError';
  }
}
export const fail = (at: string, message: string): never => {
  throw new ContractError(at, message);
};
export const text =
  (max = 100_000, min = 0, pattern?: RegExp): Decoder<string> =>
  (value, at = '$') => {
    if (
      typeof value !== 'string' ||
      value.length < min ||
      value.length > max ||
      (pattern && !pattern.test(value))
    )
      return fail(at, 'invalid string');
    return value;
  };
export const integer =
  (min = 0, max = Number.MAX_SAFE_INTEGER): Decoder<number> =>
  (value, at = '$') => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
      return fail(at, 'invalid integer');
    return value;
  };
export const boolean: Decoder<boolean> = (value, at = '$') =>
  typeof value === 'boolean' ? value : fail(at, 'expected boolean');
export const literal =
  <T extends string | number | boolean | null>(expected: T): Decoder<T> =>
  (value, at = '$') =>
    value === expected ? expected : fail(at, 'unexpected literal');
export const choice =
  <const T extends readonly string[]>(values: T): Decoder<T[number]> =>
  (value, at = '$') =>
    typeof value === 'string' && values.includes(value) ? value : fail(at, 'unsupported value');
export const optional =
  <T>(decode: Decoder<T>): Decoder<T | undefined> =>
  (value, at) =>
    value === undefined ? undefined : decode(value, at);
export const list =
  <T>(decode: Decoder<T>, max = 100_000, min = 0): Decoder<T[]> =>
  (value, at = '$') => {
    if (!Array.isArray(value) || value.length < min || value.length > max)
      return fail(at, 'invalid array');
    return Array.from(value, (entry, index) => decode(entry, `${at}[${index}]`));
  };
export const union =
  <T extends readonly Decoder<unknown>[]>(...decoders: T): Decoder<ReturnType<T[number]>> =>
  (value, at = '$') => {
    for (const decode of decoders) {
      try {
        return decode(value, at) as ReturnType<T[number]>;
      } catch (error) {
        if (!(error instanceof ContractError)) throw error;
      }
    }
    return fail(at, 'unsupported object variant');
  };
type Shape = Record<string, Decoder<unknown>>;
type Decoded<S extends Shape> = {
  [K in keyof S as undefined extends ReturnType<S[K]> ? never : K]: ReturnType<S[K]>;
} & {
  [K in keyof S as undefined extends ReturnType<S[K]> ? K : never]?: Exclude<
    ReturnType<S[K]>,
    undefined
  >;
};
export const object =
  <S extends Shape>(shape: S): Decoder<Decoded<S>> =>
  (value, at = '$') => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return fail(at, 'expected JSON object');
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record))
      if (!Object.hasOwn(shape, key)) fail(`${at}.${key}`, 'unknown field');
    const result: Record<string, unknown> = {};
    for (const [key, decode] of Object.entries(shape)) {
      const parsed = decode(Object.hasOwn(record, key) ? record[key] : undefined, `${at}.${key}`);
      if (parsed !== undefined)
        Object.defineProperty(result, key, {
          value: parsed,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    return result as Decoded<S>;
  };
export const refined =
  <T>(decode: Decoder<T>, check: (value: T, at: string) => void): Decoder<T> =>
  (value, at = '$') => {
    const result = decode(value, at);
    check(result, at);
    return result;
  };
export const id = text(128, 1, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const sha256 = text(64, 64, /^[a-f0-9]{64}$/);
export const gitOid = text(64, 40, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const timestamp = refined(
  text(24, 24, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  (value, at) => {
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
      fail(at, 'invalid UTC timestamp');
  },
);
export const sourcePath = refined(text(4096, 1), (value, at) => {
  // Repository paths cannot contain terminal/control characters or Windows separators.
  if (
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f\\]/.test(value) ||
    /^[a-zA-Z]:/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail(at, 'expected repository-relative path');
});
export function unique(values: readonly string[], at: string): void {
  if (new Set(values).size !== values.length) fail(at, 'duplicate identity');
}
