import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const scryptParameters = { cost: 32_768, blockSize: 8, parallelization: 1, keyLength: 64 } as const;
const maximumMemory = 64 * 1024 * 1024;
const passwordMinimumLength = 12;
const passwordMaximumLength = 128;
const usernamePattern = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function normalizeLocalUsername(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

export function assertLocalUsername(value: string): string {
  const username = normalizeLocalUsername(value);
  if (!usernamePattern.test(username)) {
    throw new LocalAccountInputError(
      '사용자 이름은 영문 소문자 또는 숫자로 시작하며 3~64자의 영문 소문자, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.',
    );
  }
  return username;
}

export function assertLocalPassword(password: string): void {
  if (password.length < passwordMinimumLength || password.length > passwordMaximumLength) {
    throw new LocalAccountInputError('비밀번호는 12~128자로 입력해 주세요.');
  }
}

export async function hashLocalPassword(password: string): Promise<string> {
  assertLocalPassword(password);
  const salt = randomBytes(16);
  const derived = await derive(password, salt, scryptParameters.keyLength, {
    N: scryptParameters.cost,
    r: scryptParameters.blockSize,
    p: scryptParameters.parallelization,
    maxmem: maximumMemory,
  });
  return [
    'scrypt',
    scryptParameters.cost,
    scryptParameters.blockSize,
    scryptParameters.parallelization,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyLocalPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, costText, blockSizeText, parallelizationText, saltText, derivedText, extra] =
    encoded.split('$');
  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  if (
    algorithm !== 'scrypt' ||
    extra !== undefined ||
    !Number.isInteger(cost) ||
    !Number.isInteger(blockSize) ||
    !Number.isInteger(parallelization) ||
    cost < 16_384 ||
    cost > scryptParameters.cost ||
    blockSize !== scryptParameters.blockSize ||
    parallelization < 1 ||
    parallelization > 4 ||
    !saltText ||
    !derivedText
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(derivedText, 'base64url');
    if (salt.byteLength !== 16 || expected.byteLength !== scryptParameters.keyLength) return false;
    const actual = await derive(password, salt, expected.byteLength, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: maximumMemory,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function derive(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export class LocalAccountInputError extends Error {}
