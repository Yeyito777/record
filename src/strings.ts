/**
 * Small render-time string helpers.
 */

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

export function formatTimestamp(value: number | null): string {
  if (!value) return "—";
  return `${new Date(value).toISOString().slice(0, 19).replace("T", " ")}Z`;
}
