export const CODE_REGEX = /HY-[0-9A-HJKMNP-TV-Z]{6}/i;

export function extractRefCode(text: string | undefined | null): string | null {
  if (!text) {
    return null;
  }
  const match = text.match(CODE_REGEX);
  return match ? match[0].toUpperCase() : null;
}

export function extractCtwaClid(msg: { ctwaClid?: string }): string | null {
  return msg.ctwaClid ?? null;
}
