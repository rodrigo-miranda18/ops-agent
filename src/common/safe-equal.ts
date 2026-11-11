import { createHash, timingSafeEqual } from 'node:crypto';

function digest(value: string) {
  return createHash('sha256').update(value).digest();
}

export function safeEqual(received: string | undefined, expected: string) {
  if (received === undefined) return false;
  return timingSafeEqual(digest(received), digest(expected));
}

export function hasBearerToken(
  authorization: string | undefined,
  token: string,
) {
  return safeEqual(authorization, `Bearer ${token}`);
}
