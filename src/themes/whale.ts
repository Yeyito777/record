/**
 * Whale theme — cloned from Exocortex TUI.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

export const whale: Theme = {
  name: "whale",

  reset: `${ESC}0m`,

  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,

  accent: `${ESC}38;2;29;155;240m`,
  text: `${ESC}38;2;255;255;255m`,
  muted: `${ESC}38;2;100;100;100m`,
  error: `${ESC}31m`,
  failure: `${ESC}31m`,
  warning: `${ESC}33m`,
  success: `${ESC}38;2;80;200;120m`,
  prompt: `${ESC}34m`,
  tool: `${ESC}35m`,
  command: `${ESC}38;2;174;214;254m`,

  vimNormal: `${ESC}38;2;72;202;228m`,
  vimInsert: `${ESC}38;2;46;196;182m`,
  vimVisual: `${ESC}38;2;199;146;234m`,

  topbarBg: `${ESC}48;2;29;155;240m`,
  userBg: `${ESC}48;2;9;13;53m`,
  sidebarBg: `${ESC}48;2;3;8;20m`,
  sidebarSelBg: `${ESC}48;2;15;25;60m`,
  cursorBg: `${ESC}48;2;72;202;228m`,
  historyLineBg: `${ESC}48;2;9;13;53m`,
  messageDeleteFg: `${ESC}31m`,
  selectionBg: `${ESC}48;2;79;82;88m`,
  searchBg: `${ESC}48;2;252;224;148m`,
  searchFg: `${ESC}38;2;0;5;15m`,
  notificationBg: `${ESC}41m`,
  notificationFg: `${ESC}38;2;255;255;255m`,
  pingBg: `${ESC}48;2;9;13;53m`,
  appBg: `${ESC}48;2;0;5;15m`,
  cursorColor: "#48cae4",

  borderFocused: `${ESC}38;2;28;148;229m`,
  borderUnfocused: `${ESC}38;2;85;85;85m`,

  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,
};
