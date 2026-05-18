/**
 * Terminal lifecycle and ANSI helpers.
 */

const ESC = "\x1b[";

export const enterAlt = `${ESC}?1049h`;
export const leaveAlt = `${ESC}?1049l`;
export const hideCursor = `${ESC}?25l`;
export const showCursor = `${ESC}?25h`;
export const enableBracketedPaste = `${ESC}?2004h`;
export const disableBracketedPaste = `${ESC}?2004l`;
// Push kitty keyboard mode: disambiguate + report event types + all keys + associated text.
// The event-type flag is what lets hold-to-talk see space releases.
export const enableKittyKeyboard = `${ESC}>27u`;
export const disableKittyKeyboard = `${ESC}<u`;
export const clearLine = `${ESC}2K`;
export const cursorBlock = `${ESC}2 q`;
export const cursorUnderline = `${ESC}4 q`;
export const cursorBar = `${ESC}6 q`;
export const eraseToEol = `${ESC}K`;
export const setCursorColor = (hex: string) => `\x1b]12;${hex}\x1b\\`;
export const resetCursorColor = `\x1b]112\x1b\\`;

export const moveTo = (row: number, col: number) => `${ESC}${row};${col}H`;

const RESET = `${ESC}0m`;

export function applyLineBg(line: string, bg: string): string {
  const patched = line.replaceAll(RESET, `${RESET}${bg}`);
  return `${bg}${eraseToEol}${patched}${RESET}`;
}
