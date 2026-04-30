/**
 * Cerberus theme — cloned from Exocortex TUI.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

export const cerberus: Theme = {
  name: "cerberus",

  reset: `${ESC}0m`,

  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,

  accent: `${ESC}38;2;211;47;47m`,
  text: `${ESC}38;2;224;224;224m`,
  muted: `${ESC}38;2;102;102;102m`,
  error: `${ESC}38;2;244;67;54m`,
  failure: `${ESC}38;2;244;67;54m`,
  warning: `${ESC}38;2;255;167;38m`,
  success: `${ESC}38;2;102;187;106m`,
  prompt: `${ESC}38;2;211;47;47m`,
  tool: `${ESC}38;2;176;100;100m`,
  command: `${ESC}38;2;239;154;154m`,

  vimNormal: `${ESC}38;2;211;47;47m`,
  vimInsert: `${ESC}38;2;255;107;107m`,
  vimVisual: `${ESC}38;2;183;28;28m`,

  topbarBg: `${ESC}48;2;211;47;47m`,
  userBg: `${ESC}48;2;37;37;37m`,
  sidebarBg: `${ESC}48;2;26;26;26m`,
  sidebarSelBg: `${ESC}48;2;51;51;51m`,
  cursorBg: `${ESC}48;2;211;47;47m`,
  historyLineBg: `${ESC}48;2;37;37;37m`,
  messageDeleteFg: `${ESC}38;2;244;67;54m`,
  selectionBg: `${ESC}48;2;74;74;74m`,
  searchBg: `${ESC}48;2;252;224;148m`,
  searchFg: `${ESC}38;2;20;20;20m`,
  notificationBg: `${ESC}48;2;183;28;28m`,
  notificationFg: `${ESC}38;2;255;255;255m`,
  pingBg: `${ESC}48;2;9;13;53m`,
  appBg: `${ESC}48;2;20;20;20m`,
  cursorColor: "#d32f2f",

  borderFocused: `${ESC}38;2;211;47;47m`,
  borderUnfocused: `${ESC}38;2;85;85;85m`,

  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,
};
