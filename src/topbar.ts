/**
 * Top bar renderer.
 */

import { theme } from "./theme";

export function renderTopbar(width: number): string {
  const title = " Record";
  return `${theme.topbarBg}${theme.text}${theme.bold}${title}${theme.boldOff}${" ".repeat(Math.max(0, width - title.length))}${theme.reset}`;
}
