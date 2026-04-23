import { randomBytes } from 'crypto';

export function randomId(len = 6): string {
  return randomBytes(len).toString('hex').slice(0, len);
}
