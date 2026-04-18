/**
 * Token helpers.
 */

export function normalizeToken(value: string): string {
  return value
    .replace(/\r\n/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
