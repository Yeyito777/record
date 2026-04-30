/**
 * Application state for record.
 */

import type { AutocompleteState } from "./autocomplete";
import { createChannelListState, type ChannelListState } from "./channels";
import type { SavedLogins } from "./config";
import type { DiscordGuildMember, DiscordIdentity, DiscordPresenceStatus, DiscordRole } from "./discord";
import type { ChannelMessageCache } from "./messagecache";
import { createEditorState, enterInsertMode, leaveInsertMode, type EditorState } from "./editor";
import { createHistoryCursor, type HistoryCursor } from "./historycursor";
import { createMemberListState, type MemberListState } from "./memberlist";
import { createNotificationState, type NotificationState } from "./notifications";
import { createSidebarState, type SidebarState } from "./sidebar";
import { createTimelineState, type TimelineMessageBound, type TimelineState } from "./timeline";
import { createTypingState, type TypingState } from "./typing";
import { normalizeToken } from "./token";
import type { ClipboardImageAttachment } from "./imageclipboard";
import type { NoticeTone } from "./theme";
import type { VoiceConnectionState } from "./voice";

export type AuthStatus = "idle" | "loading" | "authenticated" | "error";
export type PresenceStatus = DiscordPresenceStatus;
export type PanelFocus = "sidebar" | "memberlist" | "chat";
export type ChatFocus = "prompt" | "history";

export interface Notice {
  tone: NoticeTone;
  text: string;
  loading: boolean;
  /** Whether this notice should be shown in the status line. */
  statusLine?: boolean;
  /** Whether this notice may be shown in the empty chat body when no messages are visible. */
  chat?: boolean;
}

export interface AuthState {
  status: AuthStatus;
  user: DiscordIdentity | null;
  presenceStatus: PresenceStatus | null;
  error: string | null;
  savedToken: string | null;
  savedLogins: SavedLogins;
  lastValidatedAt: number | null;
  activeRequestId: number;
}

export interface ReplyTarget {
  messageId: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorDisplayName: string;
  authorColor: string;
  summary: string;
  mentionRoleIds?: string[];
  mentionUsers?: DiscordGuildMember[];
  timestamp: number | null;
  mention: boolean;
}

export interface EditTarget {
  messageId: string;
  channelId: string;
  authorDisplayName: string;
  authorColor: string;
  summary: string;
  originalContent: string;
  timestamp: number | null;
}

export interface VoiceCallStatus {
  displayName: string;
  state: VoiceConnectionState;
  startedAt: number;
  selfMute: boolean;
  selfDeaf: boolean;
  participantUserIds: string[];
}

export interface AppState {
  cols: number;
  rows: number;
  panelFocus: PanelFocus;
  chatFocus: ChatFocus;
  editor: EditorState;
  historyCursor: HistoryCursor;
  historyVisualAnchor: HistoryCursor;
  historyCursorPendingVisibleBottom: boolean;
  historyLineAnchors: string[];
  historyLines: string[];
  historyLineBackgrounds: string[];
  historyWrapContinuation: boolean[];
  historyMessageBounds: TimelineMessageBound[];
  autocomplete: AutocompleteState | null;
  pendingImages: ClipboardImageAttachment[];
  sidebar: SidebarState;
  memberList: MemberListState;
  channelList: ChannelListState;
  timeline: TimelineState;
  messageCacheByChannelId: ChannelMessageCache;
  typing: TypingState;
  notifications: NotificationState;
  replyTarget: ReplyTarget | null;
  editTarget: EditTarget | null;
  voiceCall: VoiceCallStatus | null;
  roleIdsByGuildId: Record<string, string[]>;
  guildRolesByGuildId: Record<string, DiscordRole[]>;
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>;
  memberRoleCacheVersion: number;
  showHiddenChannels: boolean;
  auth: AuthState;
  notice: Notice;
  loadingFrameIndex: number;
  configPath: string;
}

export function createInitialState(
  initialToken: string | null,
  path: string,
  initialSavedLogins: SavedLogins = {},
  options: { showHiddenChannels?: boolean } = {},
): AppState {
  const savedToken = initialToken ? normalizeToken(initialToken) : null;
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    panelFocus: "chat",
    chatFocus: "prompt",
    editor: createEditorState("", "insert"),
    historyCursor: createHistoryCursor(),
    historyVisualAnchor: createHistoryCursor(),
    historyCursorPendingVisibleBottom: false,
    historyLineAnchors: [],
    historyLines: [],
    historyLineBackgrounds: [],
    historyWrapContinuation: [],
    historyMessageBounds: [],
    autocomplete: null,
    pendingImages: [],
    sidebar: createSidebarState(),
    memberList: createMemberListState(),
    channelList: createChannelListState(),
    timeline: createTimelineState(),
    messageCacheByChannelId: {},
    typing: createTypingState(),
    notifications: createNotificationState(),
    replyTarget: null,
    editTarget: null,
    voiceCall: null,
    roleIdsByGuildId: {},
    guildRolesByGuildId: {},
    memberRoleIdsByGuildId: {},
    memberRoleCacheVersion: 0,
    showHiddenChannels: options.showHiddenChannels ?? false,
    auth: {
      status: "idle",
      user: null,
      presenceStatus: null,
      error: null,
      savedToken,
      savedLogins: { ...initialSavedLogins },
      lastValidatedAt: null,
      activeRequestId: 0,
    },
    notice: { tone: "muted", text: "", loading: false, statusLine: true, chat: true },
    loadingFrameIndex: 0,
    configPath: path,
  };
}

export function setNotice(
  state: AppState,
  text: string,
  tone: NoticeTone = "muted",
  options: { loading?: boolean; statusLine?: boolean; chat?: boolean } = {},
): void {
  state.notice = {
    text,
    tone,
    loading: options.loading ?? false,
    statusLine: options.statusLine ?? true,
    chat: options.chat ?? true,
  };
}

export function setLoadingNotice(state: AppState, text: string, options: { statusLine?: boolean; chat?: boolean } = {}): void {
  setNotice(state, text, "muted", { loading: true, ...options });
}

export function nextAuthRequestId(state: AppState): number {
  state.auth.activeRequestId += 1;
  return state.auth.activeRequestId;
}

export function isCurrentAuthRequest(state: AppState, requestId: number): boolean {
  return state.auth.activeRequestId === requestId;
}

export function focusPrompt(state: AppState, append = false): void {
  state.panelFocus = "chat";
  state.chatFocus = "prompt";
  const targetCursor = append ? state.editor.cursor + 1 : state.editor.cursor;
  enterInsertMode(state.editor, targetCursor);
}

export function focusHistory(state: AppState): void {
  state.panelFocus = "chat";
  state.chatFocus = "history";
  leaveInsertMode(state.editor);
}

export function focusSidebar(state: AppState): void {
  state.panelFocus = "sidebar";
  leaveInsertMode(state.editor);
}

export function focusMemberList(state: AppState): void {
  state.panelFocus = "memberlist";
  leaveInsertMode(state.editor);
}

function focusPanel(state: AppState, panel: PanelFocus): void {
  if (panel === "sidebar") {
    focusSidebar(state);
  } else if (panel === "memberlist") {
    focusMemberList(state);
  } else {
    state.panelFocus = "chat";
  }
}

export function cycleFocus(state: AppState, direction: 1 | -1 = 1): void {
  const order: PanelFocus[] = ["chat"];
  if (state.memberList.open) order.push("memberlist");
  if (state.sidebar.open) order.push("sidebar");

  const currentIndex = order.indexOf(state.panelFocus);
  const startIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (startIndex + direction + order.length) % order.length;
  const next = order[nextIndex] ?? "chat";
  focusPanel(state, next);
}
