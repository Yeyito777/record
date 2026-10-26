/**
 * Message timeline state and rendering helpers.
 */

import { applyDiscordMessagePatch, isCompactSystemMessageType, isPendingLocalMessageEcho, type DiscordGuildMember, type DiscordMessage, type DiscordMessagePatch, type DiscordRole } from "./discord";
import { customEmojiMarker, replaceCustomEmojiTokens } from "./customemoji";
import { fitPictureCells, INLINE_IMAGE_GRID_COLUMNS, inlineImageCellLayout, inlineImageHasShape, inlineImageId, inlineImagePlacementId, inlineImageShape, inlineImageSourcesForMessage, isImageAttachment, isPendingInlineImage, pendingInlineImage, stickerImageAttachment, type InlineChatImageReady, type InlineChatImageState } from "./inlineimage";
import { loadingFrame, loadingLabel } from "./loading";
import { markdownWordWrap } from "./markdown";
import { layoutEmbed } from "./embedlayout";
import { embedGroups, forwardedEmbedOccurrence, isEmbedSourceId, type EmbedGroup } from "./embeds";
import { displayMessageParts, type DisplayMessagePart } from "./messageparts";
import { sliceByWidth, termWidth, truncate } from "./textwidth";
import { ansiTrueColor, dmAuthorColor, theme, toneColor } from "./theme";

export type TimelineView = "channel" | "pinned";

export interface TimelineState {
  channelId: string | null;
  /** Whether the timeline is showing canonical channel history or a pinned-message result set. */
  view: TimelineView;
  messages: DiscordMessage[];
  /** Local-only command output; discarded whenever canonical history reloads. */
  systemMessages: TimelineSystemMessage[];
  /** Contextual empty-state text supplied by the active channel loader. */
  emptyText: string | null;
  scrollOffset: number;
  maxScroll: number;
  loading: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  requestId: number;
  viewerId: string | null;
  accentViewerInDirectMessages: boolean;
  rolesByGuildId: Record<string, DiscordRole[]>;
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>;
  memberRoleCacheVersion: number;
  activeGuildId: string | null;
  /** Per-attachment inline expansion/loading state for the active timeline. */
  inlineImages: Record<string, InlineChatImageState>;
  terminalCellWidthPixels: number;
  terminalCellHeightPixels: number;
  /**
   * Show the "📎 name • size" row above images drawn inline (Ctrl+O). Off,
   * a shown image is its own row; images not drawn keep their name row.
   */
  showImageDetails: boolean;
  /**
   * Pictures near the view load by themselves (`/images show` on a terminal
   * that draws them): one not requested yet already holds its box.
   */
  imageAutoShow: boolean;
  /** Pictures the user collapsed: never given a box until reopened. */
  hiddenImageIds: ReadonlySet<string>;
}

export interface TimelineSystemMessage {
  id: string;
  text: string;
  timestamp: number;
}

export interface TimelineMessageBound {
  messageId: string;
  groupId?: string;
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
}

export interface RenderedTimeline {
  lines: string[];
  allLines: string[];
  lineAnchors: string[];
  lineBackgrounds: string[];
  wrapContinuation: boolean[];
  messageBounds: TimelineMessageBound[];
  inlineImages: TimelineInlineImagePlacement[];
  maxScroll: number;
}

export interface TimelineInlineImagePlacement {
  image: InlineChatImageReady;
  placementId: number;
  /** Absolute line index within allLines. */
  lineIndex: number;
  /** Cells from the row's start (embed pictures); 0 or absent for attachments. */
  columnOffset?: number;
  columns: number;
  rows: number;
}

interface WrappedLine {
  text: string;
  wrapContinuation: boolean;
  visualIndex: number;
}

interface RenderedMessage {
  lines: string[];
  lineAnchors: string[];
  lineBackgrounds: string[];
  wrapContinuation: boolean[];
  /** Message-relative line indexes, made absolute by the content compositor. */
  inlineImages: TimelineInlineImagePlacement[];
}

interface CachedRenderedMessage {
  width: number;
  fingerprint: string;
  rendered: RenderedMessage;
}

interface CachedTimelineContent {
  width: number;
  version: number;
  liveKey: string;
  /** Messages drawn with the spinner frame or clock (loading images, live calls). */
  liveMessageIds: ReadonlySet<string>;
  lines: string[];
  lineAnchors: string[];
  lineBackgrounds: string[];
  wrapContinuation: boolean[];
  messageBounds: TimelineMessageBound[];
  inlineImages: TimelineInlineImagePlacement[];
}

type TimelineRenderEntry =
  | { kind: "message"; timestamp: number; message: DiscordMessage }
  | { kind: "system"; timestamp: number; message: TimelineSystemMessage };

interface TimelineCacheState {
  version: number;
  messageRenderCache: Map<string, CachedRenderedMessage>;
  contentCache: CachedTimelineContent | null;
}

const timelineCaches = new WeakMap<TimelineState, TimelineCacheState>();
const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;
let nextTimelineSystemMessageId = 0;

export function createTimelineState(): TimelineState {
  return {
    channelId: null,
    view: "channel",
    messages: [],
    systemMessages: [],
    emptyText: null,
    scrollOffset: 0,
    maxScroll: 0,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasOlder: false,
    hasNewer: false,
    requestId: 0,
    viewerId: null,
    accentViewerInDirectMessages: false,
    rolesByGuildId: {},
    memberRoleIdsByGuildId: {},
    memberRoleCacheVersion: 0,
    activeGuildId: null,
    inlineImages: {},
    showImageDetails: false,
    imageAutoShow: false,
    hiddenImageIds: new Set(),
    terminalCellWidthPixels: 8,
    terminalCellHeightPixels: 16,
  };
}

export function setTimelineInlineImageState(timeline: TimelineState, image: InlineChatImageState): void {
  timeline.inlineImages = { ...timeline.inlineImages, [image.attachmentId]: image };
  // Message fingerprints include their inline-image states. Preserve every
  // unaffected message render and rebuild only the timeline composition.
  invalidateTimelineContentCache(timeline);
}

export function removeTimelineInlineImageState(timeline: TimelineState, attachmentId: string): boolean {
  if (!timeline.inlineImages[attachmentId]) return false;
  const next = { ...timeline.inlineImages };
  delete next[attachmentId];
  timeline.inlineImages = next;
  invalidateTimelineContentCache(timeline);
  return true;
}

/** Remove several image states with one re-layout. */
export function removeTimelineInlineImageStates(timeline: TimelineState, attachmentIds: readonly string[]): number {
  const present = attachmentIds.filter((attachmentId) => timeline.inlineImages[attachmentId]);
  if (present.length === 0) return 0;
  const next = { ...timeline.inlineImages };
  for (const attachmentId of present) delete next[attachmentId];
  timeline.inlineImages = next;
  invalidateTimelineContentCache(timeline);
  return present.length;
}

export function clearTimelineInlineImageStates(timeline: TimelineState): boolean {
  if (Object.keys(timeline.inlineImages).length === 0) return false;
  timeline.inlineImages = {};
  invalidateTimelineContentCache(timeline);
  return true;
}

export function hasLoadingInlineTimelineImage(timeline: TimelineState): boolean {
  return Object.values(timeline.inlineImages).some((image) => image.phase === "loading");
}

function pruneTimelineInlineImages(timeline: TimelineState): void {
  const attachmentUrls = new Map(timeline.messages.flatMap((message) => (
    inlineImageSourcesForMessage(message).map((attachment) => [attachment.id, attachment.url] as const)
  )));
  const next = Object.fromEntries(
    Object.entries(timeline.inlineImages).filter(([attachmentId, image]) => attachmentUrls.get(attachmentId) === image.sourceUrl),
  );
  if (Object.keys(next).length !== Object.keys(timeline.inlineImages).length) timeline.inlineImages = next;
}

function transferInlineImageStates(
  timeline: TimelineState,
  previous: DiscordMessage | undefined,
  next: DiscordMessage,
): void {
  if (!previous) return;
  const previousAttachments = [...previous.attachments, ...(previous.forwarded?.attachments ?? [])];
  const nextAttachments = [...next.attachments, ...(next.forwarded?.attachments ?? [])];
  let changed = false;
  const states = { ...timeline.inlineImages };
  for (let index = 0; index < Math.min(previousAttachments.length, nextAttachments.length); index++) {
    const oldAttachment = previousAttachments[index];
    const newAttachment = nextAttachments[index];
    if (!oldAttachment || !newAttachment) continue;
    const oldState = states[oldAttachment.id];
    if (!oldState || states[newAttachment.id]) continue;
    delete states[oldAttachment.id];
    states[newAttachment.id] = oldState.phase === "ready"
      ? {
        ...oldState,
        attachmentId: newAttachment.id,
        filename: newAttachment.filename,
        sourceUrl: newAttachment.url,
        imageId: inlineImageId(newAttachment),
      }
      : {
        ...oldState,
        attachmentId: newAttachment.id,
        filename: newAttachment.filename,
        sourceUrl: newAttachment.url,
      };
    changed = true;
  }
  if (changed) timeline.inlineImages = states;
}

export function setTimelineTerminalCellSize(timeline: TimelineState, width: number, height: number): boolean {
  const normalizedWidth = Math.max(1, Math.floor(width));
  const normalizedHeight = Math.max(1, Math.floor(height));
  if (timeline.terminalCellWidthPixels === normalizedWidth && timeline.terminalCellHeightPixels === normalizedHeight) {
    return false;
  }
  timeline.terminalCellWidthPixels = normalizedWidth;
  timeline.terminalCellHeightPixels = normalizedHeight;
  resetTimelineRenderCaches(timeline);
  return true;
}

/** Lay every message out again (something every layout measures changed, such as emoji widths). */
export function invalidateTimelineLayout(timeline: TimelineState): void {
  resetTimelineRenderCaches(timeline);
}

/** Ctrl+O: show or hide the name rows of images drawn inline. Returns whether it changed. */
export function setTimelineImageDetails(timeline: TimelineState, show: boolean): boolean {
  if (timeline.showImageDetails === show) return false;
  timeline.showImageDetails = show;
  resetTimelineRenderCaches(timeline);
  return true;
}

/** Whether pictures near the view load by themselves, and which the user collapsed. Returns whether it changed. */
export function setTimelineImageAutoShow(timeline: TimelineState, autoShow: boolean, hidden: ReadonlySet<string> = timeline.hiddenImageIds): boolean {
  if (timeline.imageAutoShow === autoShow && timeline.hiddenImageIds === hidden) return false;
  timeline.imageAutoShow = autoShow;
  timeline.hiddenImageIds = hidden;
  resetTimelineRenderCaches(timeline);
  return true;
}

export function clearTimeline(timeline: TimelineState): void {
  timeline.channelId = null;
  timeline.view = "channel";
  timeline.messages = [];
  timeline.systemMessages = [];
  timeline.emptyText = null;
  timeline.scrollOffset = 0;
  timeline.maxScroll = 0;
  timeline.loading = false;
  timeline.loadingOlder = false;
  timeline.loadingNewer = false;
  timeline.hasOlder = false;
  timeline.hasNewer = false;
  timeline.inlineImages = {};
  resetTimelineRenderCaches(timeline);
}

export function setTimelineMessages(
  timeline: TimelineState,
  channelId: string,
  messages: DiscordMessage[],
  options: { hasOlder?: boolean; hasNewer?: boolean; preserveScroll?: boolean; emptyText?: string | null; view?: TimelineView } = {},
): void {
  const view = options.view ?? "channel";
  const sameTimeline = timeline.channelId === channelId && timeline.view === view;
  const preserveScroll = options.preserveScroll === true && sameTimeline;
  const previousEmptyText = sameTimeline ? timeline.emptyText : null;
  const previousScrollOffset = timeline.scrollOffset;
  timeline.channelId = channelId;
  timeline.view = view;
  if (!sameTimeline) timeline.inlineImages = {};
  timeline.messages = messages;
  pruneTimelineInlineImages(timeline);
  timeline.systemMessages = [];
  timeline.emptyText = options.emptyText !== undefined ? options.emptyText : previousEmptyText;
  timeline.scrollOffset = preserveScroll ? previousScrollOffset : Number.MAX_SAFE_INTEGER;
  // A preserving refresh keeps the previous maxScroll until the next render
  // measures the new rows: with 0, the renderer took any scrolled-up view
  // with the prompt focused for "following the bottom" and jumped there.
  if (!preserveScroll) timeline.maxScroll = 0;
  timeline.loading = false;
  timeline.loadingOlder = false;
  timeline.loadingNewer = false;
  timeline.hasOlder = options.hasOlder ?? messages.length > 0;
  timeline.hasNewer = options.hasNewer ?? false;
  if (sameTimeline) {
    // A refresh of the open chat (provider history events, REST revalidation)
    // keeps rendered messages: the per-message cache is keyed by id, width and
    // a fingerprint of everything drawn. Re-rendering them all cost ~100 ms
    // per WhatsApp event in a 300-message chat.
    pruneMessageRenderCache(timeline);
    invalidateTimelineContentCache(timeline);
  } else {
    resetTimelineRenderCaches(timeline);
  }
}

function pruneMessageRenderCache(timeline: TimelineState): void {
  const cache = getTimelineCacheState(timeline).messageRenderCache;
  if (cache.size <= timeline.messages.length * 2 + 64) return;
  const live = new Set(timeline.messages.map((message) => message.id));
  for (const key of cache.keys()) {
    if (!live.has(key.slice(0, key.lastIndexOf(":")))) cache.delete(key);
  }
}

export function startLoadingOlderMessages(timeline: TimelineState): void {
  if (timeline.loading || timeline.loadingOlder || timeline.loadingNewer || !timeline.hasOlder || !timeline.channelId) return;
  timeline.loadingOlder = true;
}

export function finishLoadingOlderMessages(timeline: TimelineState, hasOlder = timeline.hasOlder): void {
  timeline.loadingOlder = false;
  timeline.hasOlder = hasOlder;
}

export function startLoadingNewerMessages(timeline: TimelineState): void {
  if (timeline.loading || timeline.loadingOlder || timeline.loadingNewer || !timeline.hasNewer || !timeline.channelId) return;
  timeline.loadingNewer = true;
}

export function finishLoadingNewerMessages(timeline: TimelineState, hasNewer = timeline.hasNewer): void {
  timeline.loadingNewer = false;
  timeline.hasNewer = hasNewer;
}

export function appendTimelineMessage(timeline: TimelineState, message: DiscordMessage): void {
  if (timeline.channelId !== message.channelId) return;
  // Gateway creates and optimistic sends belong to canonical history. Pinned
  // results are a fixed REST snapshot until the user selects one or reloads it.
  if (timeline.view === "pinned") return;
  const existingIndex = timeline.messages.findIndex((existing) => existing.id === message.id);
  if (existingIndex >= 0) {
    timeline.messages[existingIndex] = message;
    pruneTimelineInlineImages(timeline);
    invalidateTimelineContentCache(timeline);
    return;
  }

  const pendingIndex = findMatchingPendingLocalMessageIndex(timeline, message);
  if (pendingIndex >= 0) {
    transferInlineImageStates(timeline, timeline.messages[pendingIndex], message);
    timeline.messages[pendingIndex] = message;
  } else if (timeline.hasNewer && !message.localStatus) {
    // Viewing an older window (jump to a message): a live message belongs
    // after history not loaded yet, not directly after this page.
    return;
  } else {
    timeline.messages.push(message);
  }
  invalidateTimelineContentCache(timeline);
}

/** Append Exocortex-style ephemeral command output to the active chat. */
export function pushTimelineSystemMessage(timeline: TimelineState, text: string): boolean {
  if (!text) return false;
  const timestamp = Date.now();
  timeline.systemMessages.push({
    id: `local-system:${timestamp}:${++nextTimelineSystemMessageId}`,
    text,
    timestamp,
  });
  timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
  invalidateTimelineContentCache(timeline);
  return true;
}

function findMatchingPendingLocalMessageIndex(timeline: TimelineState, message: DiscordMessage): number {
  if (message.localStatus) return -1;
  return timeline.messages.findIndex((existing) => isPendingLocalMessageEcho(existing, message));
}

export function replaceTimelineMessage(timeline: TimelineState, localMessageId: string, message: DiscordMessage): void {
  if (timeline.channelId !== message.channelId) return;
  const localIndex = timeline.messages.findIndex((existing) => existing.id === localMessageId);
  const canonicalIndex = timeline.messages.findIndex((existing) => existing.id === message.id);
  if (localIndex >= 0) {
    transferInlineImageStates(timeline, timeline.messages[localIndex], message);
    timeline.messages[localIndex] = message;
    if (canonicalIndex >= 0 && canonicalIndex !== localIndex) {
      timeline.messages.splice(canonicalIndex, 1);
    }
  } else if (canonicalIndex >= 0) {
    timeline.messages[canonicalIndex] = message;
  } else {
    timeline.messages.push(message);
  }
  pruneTimelineInlineImages(timeline);
  invalidateTimelineContentCache(timeline);
}

export function markTimelineMessageFailed(timeline: TimelineState, localMessageId: string, error: string): DiscordMessage | null {
  const localIndex = timeline.messages.findIndex((existing) => existing.id === localMessageId);
  if (localIndex < 0) return null;
  const message = timeline.messages[localIndex];
  if (!message) return null;
  const failed = { ...message, localStatus: "failed" as const, localError: error };
  timeline.messages[localIndex] = failed;
  invalidateTimelineContentCache(timeline);
  return failed;
}

export function updateTimelineMessage(timeline: TimelineState, message: DiscordMessage): void {
  if (timeline.channelId !== message.channelId) return;
  const existingIndex = timeline.messages.findIndex((existing) => existing.id === message.id);
  if (existingIndex < 0) return;
  timeline.messages[existingIndex] = message;
  pruneTimelineInlineImages(timeline);
  invalidateTimelineContentCache(timeline);
}

export function patchTimelineMessage(timeline: TimelineState, patch: DiscordMessagePatch): void {
  if (timeline.channelId !== patch.channelId) return;
  const existingIndex = timeline.messages.findIndex((existing) => existing.id === patch.id);
  if (existingIndex < 0) return;
  const existing = timeline.messages[existingIndex];
  if (!existing) return;
  // Reaction rows can grow on any message, from local sends or gateway events.
  // Resolve the new bottom on render instead of retaining the old row offset.
  if ((patch.reactionUpdate || patch.reactions !== undefined)
    && timeline.scrollOffset >= timeline.maxScroll) {
    timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
  }
  timeline.messages[existingIndex] = applyDiscordMessagePatch(existing, patch);
  pruneTimelineInlineImages(timeline);
  invalidateTimelineContentCache(timeline);
}

export function markTimelineCallEnded(timeline: TimelineState, channelId: string, endedTimestamp = Date.now()): boolean {
  if (timeline.channelId !== channelId) return false;
  let changed = false;
  timeline.messages = timeline.messages.map((message) => {
    if (!message.call || message.call.endedTimestamp !== null) return message;
    changed = true;
    return { ...message, call: { ...message.call, endedTimestamp } };
  });
  if (changed) invalidateTimelineContentCache(timeline);
  return changed;
}

export function removeTimelineMessage(timeline: TimelineState, messageId: string, channelId?: string): void {
  if (channelId && timeline.channelId !== channelId) return;
  const before = timeline.messages.length;
  timeline.messages = timeline.messages.filter((message) => message.id !== messageId);
  if (timeline.messages.length !== before) {
    pruneTimelineInlineImages(timeline);
    invalidateTimelineContentCache(timeline);
  }
}

export function insertTimelineMessageAt(timeline: TimelineState, message: DiscordMessage, index: number, channelId?: string): void {
  if (channelId && timeline.channelId !== channelId) return;
  if (timeline.channelId !== message.channelId) return;
  const existingIndex = timeline.messages.findIndex((existing) => existing.id === message.id);
  if (existingIndex >= 0) {
    timeline.messages[existingIndex] = message;
  } else {
    timeline.messages.splice(Math.max(0, Math.min(index, timeline.messages.length)), 0, message);
  }
  pruneTimelineInlineImages(timeline);
  invalidateTimelineContentCache(timeline);
}

export function removeTimelineMessages(timeline: TimelineState, messageIds: string[], channelId?: string): void {
  if (channelId && timeline.channelId !== channelId) return;
  const ids = new Set(messageIds);
  const before = timeline.messages.length;
  timeline.messages = timeline.messages.filter((message) => !ids.has(message.id));
  if (timeline.messages.length !== before) {
    pruneTimelineInlineImages(timeline);
    invalidateTimelineContentCache(timeline);
  }
}

export function prependTimelineMessages(
  timeline: TimelineState,
  messages: DiscordMessage[],
  width: number,
  options: { hasOlder: boolean },
): number {
  if (messages.length === 0) {
    finishLoadingOlderMessages(timeline, options.hasOlder);
    return 0;
  }

  const insertedRows = countRenderedInsertedRows(timeline, messages, width, timeline.messages[0] ?? null);
  timeline.messages = [...messages, ...timeline.messages];
  timeline.loading = false;
  timeline.loadingOlder = false;
  timeline.hasOlder = options.hasOlder;
  invalidateTimelineContentCache(timeline);
  return insertedRows;
}

export function appendTimelineMessages(
  timeline: TimelineState,
  messages: DiscordMessage[],
  options: { hasNewer: boolean },
): void {
  if (messages.length === 0) {
    finishLoadingNewerMessages(timeline, options.hasNewer);
    return;
  }

  const existingIds = new Set(timeline.messages.map((message) => message.id));
  const next = messages.filter((message) => !existingIds.has(message.id));
  timeline.messages = [...timeline.messages, ...next];
  timeline.loading = false;
  timeline.loadingNewer = false;
  timeline.hasNewer = options.hasNewer;
  invalidateTimelineContentCache(timeline);
}

export function shouldLoadOlderMessages(timeline: TimelineState): boolean {
  if (timeline.loading || timeline.loadingOlder || timeline.loadingNewer || !timeline.hasOlder || !timeline.channelId || timeline.messages.length === 0) {
    return false;
  }

  if (timeline.maxScroll === 0) {
    return timeline.scrollOffset === 0;
  }

  return timeline.scrollOffset <= Math.floor(timeline.maxScroll / 2);
}

export function shouldLoadNewerMessages(timeline: TimelineState): boolean {
  if (timeline.loading || timeline.loadingOlder || timeline.loadingNewer || !timeline.hasNewer || !timeline.channelId || timeline.messages.length === 0) {
    return false;
  }

  if (timeline.maxScroll === 0) {
    return timeline.scrollOffset === 0;
  }

  return timeline.scrollOffset >= Math.ceil(timeline.maxScroll / 2);
}

export function moveTimelineScroll(timeline: TimelineState, delta: number): void {
  timeline.scrollOffset = Math.max(0, Math.min(timeline.scrollOffset + delta, timeline.maxScroll));
}

export function isTimelineNearBottom(scrollOffset: number, maxScroll: number, thresholdRows = 2): boolean {
  return scrollOffset === Number.MAX_SAFE_INTEGER || scrollOffset >= Math.max(0, maxScroll - thresholdRows);
}

export function hasActiveTimelineCall(timeline: TimelineState): boolean {
  return timeline.messages.some((message) => message.call && message.call.endedTimestamp === null);
}

export function setTimelineRenderContext(
  timeline: TimelineState,
  viewerId: string | null,
  accentViewerInDirectMessages: boolean,
  rolesByGuildId: Record<string, DiscordRole[]> = timeline.rolesByGuildId,
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>> = timeline.memberRoleIdsByGuildId,
  memberRoleCacheVersion = timeline.memberRoleCacheVersion,
  activeGuildId: string | null = timeline.activeGuildId,
): void {
  if (timeline.viewerId === viewerId
    && timeline.accentViewerInDirectMessages === accentViewerInDirectMessages
    && timeline.rolesByGuildId === rolesByGuildId
    && timeline.memberRoleIdsByGuildId === memberRoleIdsByGuildId
    && timeline.memberRoleCacheVersion === memberRoleCacheVersion
    && timeline.activeGuildId === activeGuildId) {
    return;
  }

  timeline.viewerId = viewerId;
  timeline.accentViewerInDirectMessages = accentViewerInDirectMessages;
  timeline.rolesByGuildId = rolesByGuildId;
  timeline.memberRoleIdsByGuildId = memberRoleIdsByGuildId;
  timeline.memberRoleCacheVersion = memberRoleCacheVersion;
  timeline.activeGuildId = activeGuildId;
  resetTimelineRenderCaches(timeline);
}

export function renderTimelineLines(
  timeline: TimelineState,
  width: number,
  height: number,
  notice: { text: string; tone: "muted" | "success" | "warning" | "error"; loading?: boolean; chat?: boolean },
  loadingFrameIndex = 0,
): RenderedTimeline {
  let allLines: string[] = [];
  let lineAnchors: string[] = [];
  let lineBackgrounds: string[] = [];
  let wrapContinuation: boolean[] = [];
  let messageBounds: TimelineMessageBound[] = [];
  let inlineImages: TimelineInlineImagePlacement[] = [];

  const showNoticeInTimeline = notice.chat !== false;

  if (showNoticeInTimeline && notice.text) {
    for (const [index, line] of notice.text.split("\n").entries()) {
      const renderedLine = notice.loading ? loadingLabel(line, loadingFrameIndex) : line;
      allLines.push(`${toneColor(notice.tone)}${truncate(renderedLine, width)}${theme.reset}`);
      lineAnchors.push(`notice:${index}:${notice.loading ? "loading" : "static"}:${line}`);
      lineBackgrounds.push("");
      wrapContinuation.push(false);
    }
    if (allLines.length > 0) {
      allLines.push("");
      lineAnchors.push("notice:gap");
      lineBackgrounds.push("");
      wrapContinuation.push(false);
    }
  }

  if (timeline.loading) {
    allLines.push(`${theme.muted}${truncate(loadingLabel("Loading messages…", loadingFrameIndex), width)}${theme.reset}`);
    lineAnchors.push("timeline:loading");
    lineBackgrounds.push("");
    wrapContinuation.push(false);

    if (timeline.messages.length > 0 || timeline.systemMessages.length > 0) {
      const content = getRenderedTimelineContent(timeline, width, loadingFrameIndex, Date.now());
      appendRenderedTimelineContent(allLines, lineAnchors, lineBackgrounds, wrapContinuation, messageBounds, inlineImages, content);
    }
  } else {
    const content = getRenderedTimelineContent(timeline, width, loadingFrameIndex, Date.now());
    if ((showNoticeInTimeline && notice.text) || timeline.loadingOlder || timeline.loadingNewer) {
      if (timeline.loadingOlder) {
        allLines.push(`${theme.muted}${truncate(loadingLabel("Loading older messages…", loadingFrameIndex), width)}${theme.reset}`);
        lineAnchors.push("timeline:loading-older");
        lineBackgrounds.push("");
        wrapContinuation.push(false);
      }
      const suffixLine = timeline.loadingNewer
        ? `${theme.muted}${truncate(loadingLabel("Loading newer messages…", loadingFrameIndex), width)}${theme.reset}`
        : null;
      const composed = composeTimelineContent(timeline, content, allLines, lineAnchors, lineBackgrounds, wrapContinuation, suffixLine);
      allLines = composed.lines;
      lineAnchors = composed.lineAnchors;
      lineBackgrounds = composed.lineBackgrounds;
      wrapContinuation = composed.wrapContinuation;
      messageBounds = composed.messageBounds;
      inlineImages = composed.inlineImages;
    } else {
      allLines = content.lines;
      lineAnchors = content.lineAnchors;
      lineBackgrounds = content.lineBackgrounds;
      wrapContinuation = content.wrapContinuation;
      messageBounds = content.messageBounds;
      inlineImages = content.inlineImages;
    }
  }

  if (!timeline.loading && timeline.messages.length === 0 && timeline.systemMessages.length === 0 && timeline.emptyText) {
    allLines = [`${theme.muted}${truncate(timeline.emptyText, width)}${theme.reset}`];
    lineAnchors = ["timeline:empty"];
    lineBackgrounds = [""];
    wrapContinuation = [false];
    messageBounds = [];
    inlineImages = [];
  }

  if (!(showNoticeInTimeline && notice.text) && timeline.loading && (timeline.messages.length > 0 || timeline.systemMessages.length > 0)) {
    prependBlankTimelineRows(allLines, lineAnchors, lineBackgrounds, wrapContinuation, messageBounds, inlineImages, Math.max(0, height - allLines.length));
  }

  const maxScroll = Math.max(0, allLines.length - Math.max(0, height));
  const scrollOffset = Math.max(0, Math.min(timeline.scrollOffset, maxScroll));
  timeline.scrollOffset = scrollOffset;
  timeline.maxScroll = maxScroll;

  return {
    lines: allLines.slice(scrollOffset, scrollOffset + Math.max(0, height)),
    allLines,
    lineAnchors,
    lineBackgrounds,
    wrapContinuation,
    messageBounds,
    inlineImages,
    maxScroll,
  };
}

interface ComposedTimelineContent {
  content: CachedTimelineContent;
  key: string;
  lineAnchors: string[];
  lineBackgrounds: string[];
  wrapContinuation: boolean[];
  messageBounds: TimelineMessageBound[];
  inlineImages: TimelineInlineImagePlacement[];
}

const composedTimelineContent = new WeakMap<TimelineState, ComposedTimelineContent>();

/**
 * Content plus banner rows (notice, "Loading older/newer messages…"). Those
 * are shown exactly while scrolling through a long channel; everything but the
 * text rows (whose spinner animates) is reused between frames, so anchors keep
 * their identity and the renderer does not re-index every row.
 */
function composeTimelineContent(
  timeline: TimelineState,
  content: CachedTimelineContent,
  prefixLines: string[],
  prefixAnchors: string[],
  prefixBackgrounds: string[],
  prefixContinuation: boolean[],
  suffixLine: string | null,
): Omit<ComposedTimelineContent, "content" | "key"> & { lines: string[] } {
  const key = `${prefixAnchors.join("\u0000")}\u0001${suffixLine === null ? "" : "newer"}`;
  let composed = composedTimelineContent.get(timeline);
  if (!composed || composed.content !== content || composed.key !== key) {
    const lineAnchors = prefixAnchors.slice();
    const lineBackgrounds = prefixBackgrounds.slice();
    const wrapContinuation = prefixContinuation.slice();
    const messageBounds: TimelineMessageBound[] = [];
    const inlineImages: TimelineInlineImagePlacement[] = [];
    appendRenderedTimelineContent(prefixLines.slice(), lineAnchors, lineBackgrounds, wrapContinuation, messageBounds, inlineImages, content);
    if (suffixLine !== null) {
      lineAnchors.push("timeline:loading-newer");
      lineBackgrounds.push("");
      wrapContinuation.push(false);
    }
    composed = { content, key, lineAnchors, lineBackgrounds, wrapContinuation, messageBounds, inlineImages };
    composedTimelineContent.set(timeline, composed);
  }
  const lines = prefixLines.concat(content.lines);
  if (suffixLine !== null) lines.push(suffixLine);
  return { ...composed, lines };
}

function countRenderedInsertedRows(
  timeline: TimelineState,
  messages: DiscordMessage[],
  width: number,
  firstExistingMessage: DiscordMessage | null,
): number {
  let total = 0;
  const nowMs = Date.now();
  let previousMessage: DiscordMessage | null = null;

  for (const message of messages) {
    const groupedWithPrevious = previousMessage ? shouldGroupMessages(previousMessage, message) : false;
    if (previousMessage && !groupedWithPrevious) total += 1;
    total += renderMessageCached(timeline, message, width, 0, nowMs, groupedWithPrevious).lines.length;
    previousMessage = message;
  }

  if (previousMessage && firstExistingMessage && !shouldGroupMessages(previousMessage, firstExistingMessage)) {
    total += 1;
  }
  return total;
}

function prependBlankTimelineRows(
  allLines: string[],
  lineAnchors: string[],
  lineBackgrounds: string[],
  wrapContinuation: boolean[],
  messageBounds: TimelineMessageBound[],
  inlineImages: TimelineInlineImagePlacement[],
  count: number,
): void {
  if (count <= 0) return;
  allLines.unshift(...Array.from({ length: count }, () => ""));
  lineAnchors.unshift(...Array.from({ length: count }, (_unused, index) => `timeline:loading-pad:${index}`));
  lineBackgrounds.unshift(...Array.from({ length: count }, () => ""));
  wrapContinuation.unshift(...Array.from({ length: count }, () => false));
  for (const bound of messageBounds) {
    bound.start += count;
    bound.end += count;
    bound.contentStart += count;
    bound.contentEnd += count;
  }
  for (const image of inlineImages) image.lineIndex += count;
}

function appendRenderedTimelineContent(
  allLines: string[],
  lineAnchors: string[],
  lineBackgrounds: string[],
  wrapContinuation: boolean[],
  messageBounds: TimelineMessageBound[],
  inlineImages: TimelineInlineImagePlacement[],
  content: CachedTimelineContent,
): void {
  const offset = allLines.length;
  allLines.push(...content.lines);
  lineAnchors.push(...content.lineAnchors);
  lineBackgrounds.push(...content.lineBackgrounds);
  wrapContinuation.push(...content.wrapContinuation);
  inlineImages.push(...content.inlineImages.map((image) => ({ ...image, lineIndex: image.lineIndex + offset })));
  if (offset === 0) {
    messageBounds.push(...content.messageBounds);
    return;
  }
  messageBounds.push(...content.messageBounds.map((bound) => ({
    messageId: bound.messageId,
    groupId: bound.groupId,
    start: bound.start + offset,
    end: bound.end + offset,
    contentStart: bound.contentStart + offset,
    contentEnd: bound.contentEnd + offset,
  })));
}

function getRenderedTimelineContent(
  timeline: TimelineState,
  width: number,
  loadingFrameIndex: number,
  nowMs: number,
): CachedTimelineContent {
  const cacheState = getTimelineCacheState(timeline);
  const liveKey = timelineLiveRenderKey(timeline, loadingFrameIndex, nowMs);
  if (
    cacheState.contentCache
    && cacheState.contentCache.width === width
    && cacheState.contentCache.version === cacheState.version
    && cacheState.contentCache.liveKey === liveKey
  ) {
    return cacheState.contentCache;
  }
  if (
    cacheState.contentCache
    && cacheState.contentCache.width === width
    && cacheState.contentCache.version === cacheState.version
  ) {
    // Only the spinner frame / clock moved: re-render just the live messages.
    const spliced = spliceLiveTimelineMessages(timeline, cacheState.contentCache, liveKey, loadingFrameIndex, nowMs);
    if (spliced) {
      cacheState.contentCache = spliced;
      return spliced;
    }
  }

  const lines: string[] = [];
  const lineAnchors: string[] = [];
  const lineBackgrounds: string[] = [];
  const wrapContinuation: boolean[] = [];
  const messageBounds: TimelineMessageBound[] = [];
  const inlineImages: TimelineInlineImagePlacement[] = [];

  const entries = timelineRenderEntries(timeline);
  if (!timeline.channelId && entries.length === 0) {
    // No active channel yet.
  } else if (entries.length === 0) {
    lines.push(`${theme.muted}No messages yet.${theme.reset}`);
    lineAnchors.push("timeline:empty");
    lineBackgrounds.push("");
    wrapContinuation.push(false);
  } else {
    let previousMessage: DiscordMessage | null = null;
    let currentMessageGroupId: string | null = null;
    for (const entry of entries) {
      if (entry.kind === "system") {
        const wrapped = wrapPlainText(entry.message.text, width);
        const start = lines.length;
        for (const [index, line] of wrapped.entries()) {
          lines.push(`${theme.dim}${line}${theme.reset}`);
          lineAnchors.push(`system:${entry.message.id}:content:${index}`);
          lineBackgrounds.push("");
          wrapContinuation.push(index > 0);
        }
        messageBounds.push({
          messageId: entry.message.id,
          start,
          end: lines.length,
          contentStart: start,
          contentEnd: lines.length,
        });
        previousMessage = null;
        currentMessageGroupId = null;
        continue;
      }

      const message = entry.message;
      const groupedWithPrevious = previousMessage ? shouldGroupMessages(previousMessage, message) : false;
      if (previousMessage && !groupedWithPrevious) {
        lines.push("");
        lineAnchors.push(`msg:${previousMessage.id}:gap`);
        lineBackgrounds.push("");
        wrapContinuation.push(false);
      }
      if (!groupedWithPrevious) currentMessageGroupId = message.id;

      const renderedMessage = renderMessageCached(timeline, message, width, loadingFrameIndex, nowMs, groupedWithPrevious);
      const start = lines.length;
      lines.push(...renderedMessage.lines);
      lineAnchors.push(...renderedMessage.lineAnchors);
      lineBackgrounds.push(...renderedMessage.lineBackgrounds);
      wrapContinuation.push(...renderedMessage.wrapContinuation);
      inlineImages.push(...renderedMessage.inlineImages.map((image) => ({ ...image, lineIndex: image.lineIndex + start })));
      messageBounds.push({
        messageId: message.id,
        groupId: currentMessageGroupId ?? message.id,
        start,
        end: start + renderedMessage.lines.length,
        contentStart: start,
        contentEnd: start + renderedMessage.lines.length,
      });
      previousMessage = message;
    }
  }

  const content = {
    width,
    version: cacheState.version,
    liveKey,
    liveMessageIds: liveTimelineMessageIds(timeline),
    lines,
    lineAnchors,
    lineBackgrounds,
    wrapContinuation,
    messageBounds,
    inlineImages,
  };
  cacheState.contentCache = content;
  return content;
}

function messageIsLive(timeline: TimelineState, message: DiscordMessage): boolean {
  if (message.call && message.call.endedTimestamp === null) return true;
  if (message.attachments.length === 0 && !message.stickers?.length && !message.forwarded && !message.embeds?.length) return false;
  return inlineImageStatesForMessage(message, timeline.inlineImages).some((image) => image.phase === "loading");
}

function liveTimelineMessageIds(timeline: TimelineState): Set<string> {
  const ids = new Set<string>();
  if (!hasLoadingInlineTimelineImage(timeline) && !hasActiveTimelineCall(timeline)) return ids;
  for (const message of timeline.messages) {
    if (messageIsLive(timeline, message)) ids.add(message.id);
  }
  return ids;
}

/**
 * While an image loads or a call is live, the spinner advances every 80 ms.
 * Instead of recomposing every message (100+ ms in a long channel), re-render
 * only the messages drawn with the frame/clock, now or in the previous build
 * (an image that just finished), and splice their rows into the previous
 * content. Returns null when a row count changed: the caller rebuilds.
 */
function spliceLiveTimelineMessages(
  timeline: TimelineState,
  previous: CachedTimelineContent,
  liveKey: string,
  loadingFrameIndex: number,
  nowMs: number,
): CachedTimelineContent | null {
  const liveNow = liveTimelineMessageIds(timeline);
  const ids = new Set([...previous.liveMessageIds, ...liveNow]);
  if (ids.size === 0) return { ...previous, liveKey, liveMessageIds: liveNow };
  const messagesById = new Map<string, DiscordMessage>();
  for (const message of timeline.messages) {
    if (ids.has(message.id)) messagesById.set(message.id, message);
  }
  let lines: string[] | null = null;
  let lineAnchors = previous.lineAnchors;
  let lineBackgrounds = previous.lineBackgrounds;
  let wrapContinuation = previous.wrapContinuation;
  let inlineImages = previous.inlineImages;
  for (const bound of previous.messageBounds) {
    if (!ids.has(bound.messageId)) continue;
    const message = messagesById.get(bound.messageId);
    if (!message) return null;
    const grouped = Boolean(bound.groupId && bound.groupId !== bound.messageId);
    const rendered = renderMessageCached(timeline, message, previous.width, loadingFrameIndex, nowMs, grouped);
    if (rendered.lines.length !== bound.end - bound.start) return null;
    lines ??= previous.lines.slice();
    for (let row = 0; row < rendered.lines.length; row++) {
      const index = bound.start + row;
      lines[index] = rendered.lines[row]!;
      if (lineAnchors[index] !== rendered.lineAnchors[row]) {
        if (lineAnchors === previous.lineAnchors) lineAnchors = lineAnchors.slice();
        lineAnchors[index] = rendered.lineAnchors[row]!;
      }
      if (lineBackgrounds[index] !== rendered.lineBackgrounds[row]) {
        if (lineBackgrounds === previous.lineBackgrounds) lineBackgrounds = lineBackgrounds.slice();
        lineBackgrounds[index] = rendered.lineBackgrounds[row]!;
      }
      if (wrapContinuation[index] !== rendered.wrapContinuation[row]) {
        if (wrapContinuation === previous.wrapContinuation) wrapContinuation = wrapContinuation.slice();
        wrapContinuation[index] = rendered.wrapContinuation[row]!;
      }
    }
    const before = inlineImages.filter((image) => image.lineIndex < bound.start || image.lineIndex >= bound.end);
    if (before.length !== inlineImages.length || rendered.inlineImages.length > 0) {
      inlineImages = [...before, ...rendered.inlineImages.map((image) => ({ ...image, lineIndex: image.lineIndex + bound.start }))]
        .sort((left, right) => left.lineIndex - right.lineIndex);
    }
  }
  return {
    ...previous,
    liveKey,
    liveMessageIds: liveNow,
    lines: lines ?? previous.lines,
    lineAnchors,
    lineBackgrounds,
    wrapContinuation,
    inlineImages,
  };
}

function timelineRenderEntries(timeline: TimelineState): TimelineRenderEntry[] {
  const entries: TimelineRenderEntry[] = [];
  let messageIndex = 0;
  let systemIndex = 0;
  while (messageIndex < timeline.messages.length || systemIndex < timeline.systemMessages.length) {
    const message = timeline.messages[messageIndex];
    const systemMessage = timeline.systemMessages[systemIndex];
    if (!systemMessage || (message && message.timestamp <= systemMessage.timestamp)) {
      entries.push({ kind: "message", timestamp: message!.timestamp, message: message! });
      messageIndex += 1;
    } else {
      entries.push({ kind: "system", timestamp: systemMessage.timestamp, message: systemMessage });
      systemIndex += 1;
    }
  }
  return entries;
}

/**
 * The image states of a message's pictures. With `autoShowHidden` (auto-show
 * on: the pictures the user collapsed), a picture whose shape is known and
 * that will load once near the view counts as loading before it is
 * requested, so it holds its box from its first frame.
 */
function inlineImageStatesForMessage(
  message: DiscordMessage,
  states: Readonly<Record<string, InlineChatImageState>>,
  autoShowHidden: ReadonlySet<string> | null = null,
): InlineChatImageState[] {
  const attachments = inlineImageSourcesForMessage(message);
  const seen = new Set<string>();
  const matched: InlineChatImageState[] = [];
  for (const attachment of attachments) {
    if (seen.has(attachment.id)) continue;
    seen.add(attachment.id);
    const state = states[attachment.id];
    if (!state || state.sourceUrl !== attachment.url) {
      if (autoShowHidden && !state && !autoShowHidden.has(attachment.id) && isImageAttachment(attachment) && inlineImageShape(attachment)) {
        matched.push(pendingInlineImage(attachment));
      }
      continue;
    }
    matched.push(state);
  }
  return matched;
}

function renderMessageCached(
  timeline: TimelineState,
  message: DiscordMessage,
  width: number,
  loadingFrameIndex: number,
  nowMs: number,
  groupedWithPrevious = false,
): RenderedMessage {
  const cacheState = getTimelineCacheState(timeline);
  const inlineImages = inlineImageStatesForMessage(message, timeline.inlineImages, timeline.imageAutoShow ? timeline.hiddenImageIds : null);
  const fingerprint = messageRenderFingerprint(message, loadingFrameIndex, nowMs, timeline.rolesByGuildId, timeline.activeGuildId, groupedWithPrevious, inlineImages);
  const cacheKey = `${message.id}:${groupedWithPrevious ? "grouped" : "full"}`;
  const cached = cacheState.messageRenderCache.get(cacheKey);
  if (cached && cached.width === width && cached.fingerprint === fingerprint) {
    return cached.rendered;
  }

  const rendered = renderMessage(
    message,
    width,
    timeline.viewerId,
    timeline.accentViewerInDirectMessages,
    timeline.rolesByGuildId,
    timeline.memberRoleIdsByGuildId,
    timeline.activeGuildId,
    loadingFrameIndex,
    nowMs,
    groupedWithPrevious,
    inlineImages,
    timeline.terminalCellWidthPixels,
    timeline.terminalCellHeightPixels,
    timeline.showImageDetails,
  );
  cacheState.messageRenderCache.set(cacheKey, { width, fingerprint, rendered });
  return rendered;
}

export function formatLocalMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

interface RenderedInlineImageExtras {
  lines: string[];
  lineAnchors: string[];
  wrapContinuation: boolean[];
  inlineImages: TimelineInlineImagePlacement[];
}

function inlineImageErrorText(error: string): string {
  return error
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "unknown image error";
}

/** Sizes of a message's images known before they arrive (provider-reported or assumed), by attachment id. */
function inlineImageDimensions(message: DiscordMessage): Map<string, { width: number; height: number }> {
  const dimensions = new Map<string, { width: number; height: number }>();
  for (const source of inlineImageSourcesForMessage(message)) {
    const shape = inlineImageShape(source);
    if (shape) dimensions.set(source.id, shape);
  }
  return dimensions;
}

/** Row caps of a message's images (Instagram stickers), by attachment id. */
function inlineImageRowCaps(message: DiscordMessage): Map<string, number> {
  const caps = new Map<string, number>();
  for (const source of inlineImageSourcesForMessage(message)) if (source.maxRows && source.maxRows > 0) caps.set(source.id, source.maxRows);
  return caps;
}

const IMAGE_GRID_GAP = 1;
const IMAGE_GRID_MAX_ROWS = 8;

/** Loading, waiting for a connection, or about to load: a picture with a known shape holds its box. */
function holdsImageBox(image: InlineChatImageState, dimensions: ReadonlyMap<string, unknown>): boolean {
  return (image.phase === "loading" || image.phase === "waiting") && dimensions.has(image.attachmentId);
}

function renderInlineImageExtras(
  messageId: string,
  states: readonly InlineChatImageState[],
  width: number,
  loadingFrameIndex: number,
  terminalCellWidthPixels: number,
  terminalCellHeightPixels: number,
  lineOffset: number,
  dimensions: ReadonlyMap<string, { width: number; height: number }> = new Map(),
  rowCaps: ReadonlyMap<string, number> = new Map(),
  grid = false,
): RenderedInlineImageExtras {
  const lines: string[] = [];
  const lineAnchors: string[] = [];
  const wrapContinuation: boolean[] = [];
  const inlineImages: TimelineInlineImagePlacement[] = [];
  const boxRows = (encodedId: string, rows: number, first = ""): void => {
    for (let row = 0; row < rows; row++) {
      lines.push(row === 0 ? first : "");
      lineAnchors.push(`msg:${messageId}:image:${encodedId}:${row}`);
      wrapContinuation.push(false);
    }
  };

  // An album: drawn or box-holding pictures two per row, each cell sized by
  // its known shape (so nothing moves as they land), in the message's order.
  const gridded = grid
    ? states.filter((state) => !isEmbedSourceId(state.attachmentId) && dimensions.has(state.attachmentId)
      && (state.phase === "ready" || holdsImageBox(state, dimensions)))
    : [];
  if (gridded.length > 1) {
    const columnWidth = Math.max(1, Math.floor((Math.min(width, INLINE_IMAGE_GRID_COLUMNS) - IMAGE_GRID_GAP) / 2));
    for (let start = 0; start < gridded.length; start += 2) {
      const pair = gridded.slice(start, start + 2);
      const cells = pair.map((state) => {
        const known = dimensions.get(state.attachmentId)!;
        return fitPictureCells(known.width, known.height, columnWidth, IMAGE_GRID_MAX_ROWS, terminalCellWidthPixels, terminalCellHeightPixels, 1);
      });
      const height = Math.max(...cells.map((cell) => cell.rows));
      const lineIndex = lineOffset + lines.length;
      let offset = 0;
      const statuses: string[] = [];
      pair.forEach((state, index) => {
        const cell = cells[index]!;
        if (state.phase === "ready") {
          const known = dimensions.get(state.attachmentId)!;
          // Its cell, at its own shape inside it if it isn't the known one.
          const drawn = inlineImageHasShape(known, state) ? cell
            : fitPictureCells(state.pixelWidth, state.pixelHeight, cell.columns, cell.rows, terminalCellWidthPixels, terminalCellHeightPixels, Infinity);
          inlineImages.push({
            image: state,
            placementId: inlineImagePlacementId(state.imageId, messageId),
            lineIndex,
            columnOffset: offset,
            columns: drawn.columns,
            rows: drawn.rows,
          });
          statuses.push(" ".repeat(cell.columns));
        } else {
          const status = state.phase === "loading"
            ? loadingLabel(`Loading ${state.filename}…`, isPendingInlineImage(state) ? 0 : loadingFrameIndex)
            : `Waiting for connection to load ${state.filename}…`;
          const label = truncate(status, cell.columns);
          statuses.push(`${theme.muted}${label}${theme.reset}${" ".repeat(Math.max(0, cell.columns - termWidth(label)))}`);
        }
        offset += cell.columns + IMAGE_GRID_GAP;
      });
      // Image rows stay blank (cells under a picture must keep their plain
      // background); the first carries the statuses of cells still loading.
      const statusRow = pair.every((state) => state.phase === "ready") ? "" : statuses.join(" ".repeat(IMAGE_GRID_GAP));
      const encodedId = encodeURIComponent(pair[0]!.attachmentId);
      for (let row = 0; row < height; row++) {
        lines.push(row === 0 ? statusRow : "");
        lineAnchors.push(`msg:${messageId}:image:${encodedId}:${row}`);
        wrapContinuation.push(false);
      }
    }
  }
  const inGrid = new Set(gridded.length > 1 ? gridded : []);

  // In the message's order: each image keeps its place as it loads.
  for (const state of states) {
    // Embed pictures are drawn inside their embed (embedlayout.ts).
    if (isEmbedSourceId(state.attachmentId) || inGrid.has(state)) continue;
    const maxRows = rowCaps.get(state.attachmentId);
    const encodedId = encodeURIComponent(state.attachmentId);
    const known = dimensions.get(state.attachmentId);
    if (state.phase === "ready") {
      // The box it was given while loading, when the picture has that shape.
      const box = known && inlineImageHasShape(known, state) ? { pixelWidth: known.width, pixelHeight: known.height } : state;
      const layout = inlineImageCellLayout(box, width, terminalCellWidthPixels, terminalCellHeightPixels, maxRows);
      inlineImages.push({
        image: state,
        placementId: inlineImagePlacementId(state.imageId, messageId),
        lineIndex: lineOffset + lines.length,
        columns: layout.columns,
        rows: layout.rows,
      });
      boxRows(encodedId, layout.rows);
      continue;
    }
    if (known && holdsImageBox(state, dimensions)) {
      // Its final box, so nothing moves when the picture arrives.
      const layout = inlineImageCellLayout({ pixelWidth: known.width, pixelHeight: known.height }, width, terminalCellWidthPixels, terminalCellHeightPixels, maxRows);
      const status = state.phase === "loading"
        ? loadingLabel(`Loading ${state.filename}…`, isPendingInlineImage(state) ? 0 : loadingFrameIndex)
        : `Waiting for connection to load ${state.filename}…`;
      boxRows(encodedId, layout.rows, `${theme.muted}${truncate(status, Math.max(1, width))}${theme.reset}`);
      continue;
    }
    const label = state.phase === "loading"
      ? loadingLabel(`Loading ${state.filename}…`, loadingFrameIndex)
      : state.phase === "waiting"
        ? `Waiting for connection to load ${state.filename}…`
        : `✗ Could not display ${state.filename}: ${inlineImageErrorText(state.error)}`;
    const color = state.phase === "error" ? theme.error : theme.muted;
    const wrapped = wrapPlainText(label, width);
    wrapped.forEach((line, index) => {
      lines.push(`${color}${line}${theme.reset}`);
      lineAnchors.push(`msg:${messageId}:image-status:${encodedId}:${index}`);
      wrapContinuation.push(index > 0);
    });
  }

  return { lines, lineAnchors, wrapContinuation, inlineImages };
}

function renderMessage(
  message: DiscordMessage,
  width: number,
  viewerId: string | null,
  accentViewerInDirectMessages: boolean,
  rolesByGuildId: Record<string, DiscordRole[]>,
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>,
  activeGuildId: string | null,
  loadingFrameIndex: number,
  nowMs: number,
  groupedWithPrevious = false,
  inlineImages: readonly InlineChatImageState[] = [],
  terminalCellWidthPixels = 8,
  terminalCellHeightPixels = 16,
  showImageDetails = true,
): RenderedMessage {
  const time = formatLocalMessageTime(message.timestamp);
  const author = message.author.bot
    ? `${message.author.displayName} [bot]`
    : message.author.displayName;
  const authorColor = authorColorForMessage(
    message,
    viewerId,
    accentViewerInDirectMessages,
    rolesByGuildId,
    memberRoleIdsByGuildId,
    activeGuildId,
  );
  const statusSuffix = message.localStatus === "failed" ? `${theme.error} failed`
    : message.localStatus === "unconfirmed" ? `${theme.muted} delivery unconfirmed` : "";
  const header = `${theme.bold}${authorColor}${truncate(author, Math.max(1, width - 7))}${theme.boldOff}${theme.muted} ${time}${statusSuffix}${theme.reset}`;
  const replyPreview = wrapReplyPreview(
    message,
    width,
    viewerId,
    accentViewerInDirectMessages,
    rolesByGuildId,
    memberRoleIdsByGuildId,
    activeGuildId,
  );

  const headerLines = groupedWithPrevious ? [] : [header];
  const headerAnchors = groupedWithPrevious ? [] : [`msg:${message.id}:header`];
  const headerWrapContinuation = groupedWithPrevious ? [] : [false];
  const messageBackground = messagePingsViewer(message, viewerId, memberRoleIdsByGuildId, activeGuildId) ? theme.pingBg : "";

  const contentColor = message.localStatus ? theme.muted : theme.text;
  const summarized = showImageDetails ? message : withoutShownImageNames(message, inlineImages);
  const contentRestoreStyle = `${messageBackground}${contentColor}`;
  const parts = summarizeMessageParts(
    summarized,
    viewerId,
    accentViewerInDirectMessages,
    rolesByGuildId,
    memberRoleIdsByGuildId,
    activeGuildId,
    loadingFrameIndex,
    nowMs,
    contentColor,
  );
  if (isCompactSystemMessageType(message.type)) {
    const systemText = parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n") || "System event";
    const wrappedSystem = wrapMarkdownText(systemText, width, theme.muted);
    const lines = wrappedSystem.map((line) => `${theme.dim}${line.text}${theme.reset}`);
    return {
      lines,
      lineAnchors: wrappedSystem.map((line) => `msg:${message.id}:system:${line.visualIndex}`),
      lineBackgrounds: lines.map(() => ""),
      wrapContinuation: wrappedSystem.map((line) => line.wrapContinuation),
      inlineImages: [],
    };
  }
  const reactionLines = wrapReactionSummary(message, width);
  const firstBodyRow = replyPreview.length + headerLines.length;
  const body = renderMessageBody(message.id, parts, width, contentColor, contentRestoreStyle, firstBodyRow, {
    states: Object.fromEntries(inlineImages.map((state) => [state.attachmentId, state])),
    showDetails: showImageDetails,
    loadingFrameIndex,
    cellWidthPixels: terminalCellWidthPixels,
    cellHeightPixels: terminalCellHeightPixels,
  });
  const bodyEmpty = body.lines.length === 0;
  // Nothing but images drawn below: they are the message, not "(empty message)".
  const emptyLines = bodyEmpty && summarized === message ? [`${theme.dim}(empty message)${theme.reset}`] : [];
  const extras = renderInlineImageExtras(
    message.id,
    inlineImages,
    width,
    loadingFrameIndex,
    terminalCellWidthPixels,
    terminalCellHeightPixels,
    firstBodyRow + emptyLines.length + body.lines.length,
    inlineImageDimensions(message),
    inlineImageRowCaps(message),
    message.imageGrid === true,
  );
  const failureLines = bodyEmpty ? [] : wrapFailureMessage(message, width);
  const lines = [
    ...replyPreview.map((line) => `${theme.muted}${line.text}${theme.reset}`),
    ...headerLines,
    ...emptyLines,
    ...body.lines,
    ...extras.lines,
    ...reactionLines.map((line) => `${theme.muted}${line.text}${theme.reset}`),
    ...failureLines.map((line) => `${theme.failure}${line.text}${theme.reset}`),
  ];
  return {
    lines,
    lineAnchors: [
      ...replyPreview.map((line) => `msg:${message.id}:reply:${line.visualIndex}`),
      ...headerAnchors,
      ...emptyLines.map(() => `msg:${message.id}:empty`),
      ...body.lineAnchors,
      ...extras.lineAnchors,
      ...reactionLines.map((line) => `msg:${message.id}:reactions:${line.visualIndex}`),
      ...failureLines.map((line) => `msg:${message.id}:failure:${line.visualIndex}`),
    ],
    lineBackgrounds: messageLineBackgrounds(lines, messageBackground),
    wrapContinuation: [
      ...replyPreview.map((line) => line.wrapContinuation),
      ...headerWrapContinuation,
      ...emptyLines.map(() => false),
      ...body.wrapContinuation,
      ...extras.wrapContinuation,
      ...reactionLines.map((line) => line.wrapContinuation),
      ...failureLines.map((line) => line.wrapContinuation),
    ],
    inlineImages: [...body.inlineImages, ...extras.inlineImages],
  };
}

type MessageContentPart =
  | { kind: "text"; text: string }
  | {
    kind: "embed";
    group: EmbedGroup;
    occurrence: string;
    /** Drawn right under the line holding its URL. */
    placed: boolean;
    /** Mentions, custom emoji and links in embed text, as in the message's own. */
    formatText: (text: string, restore: string) => string;
  };

interface EmbedRenderContext {
  states: Readonly<Record<string, InlineChatImageState>>;
  showDetails: boolean;
  loadingFrameIndex: number;
  cellWidthPixels: number;
  cellHeightPixels: number;
}

/** Text rows (wrapped markdown) with embeds between them. */
function renderMessageBody(
  messageId: string,
  parts: readonly MessageContentPart[],
  width: number,
  contentColor: string,
  restore: string,
  firstRow: number,
  context: EmbedRenderContext,
): RenderedInlineImageExtras & { lineAnchors: string[] } {
  const body: RenderedInlineImageExtras = { lines: [], lineAnchors: [], wrapContinuation: [], inlineImages: [] };
  // Text rows keep counting across embeds, so a preview arriving later
  // leaves every text row's anchor (and the reading position) where it was.
  let visualBase = 0;
  for (const part of parts) {
    if (part.kind === "text") {
      const wrapped = wrapMarkdownText(part.text, width, restore);
      for (const line of wrapped) {
        body.lines.push(`${contentColor}${line.text}${theme.reset}`);
        body.lineAnchors.push(`msg:${messageId}:content:${visualBase + line.visualIndex}`);
        body.wrapContinuation.push(line.wrapContinuation);
      }
      visualBase += wrapped.length;
      continue;
    }
    const layout = layoutEmbed(part.group, {
      messageId,
      occurrence: part.occurrence,
      width,
      lineOffset: firstRow + body.lines.length,
      states: context.states,
      showDetails: context.showDetails,
      loadingFrameIndex: context.loadingFrameIndex,
      cellWidthPixels: context.cellWidthPixels,
      cellHeightPixels: context.cellHeightPixels,
      restore,
      formatText: part.formatText,
      urlShown: part.placed,
    });
    body.lines.push(...layout.lines.map((line) => `${contentColor}${line}${theme.reset}`));
    body.lineAnchors.push(...layout.lineAnchors);
    body.wrapContinuation.push(...layout.wrapContinuation);
    body.inlineImages.push(...layout.inlineImages);
  }
  return body;
}

/**
 * The message as its text rows show it when image details are off: without
 * the name rows of images drawn inline (attachments and stickers whose
 * preview is ready). The same object when nothing is drawn inline.
 */
function withoutShownImageNames(message: DiscordMessage, images: readonly InlineChatImageState[]): DiscordMessage {
  // Drawn, or loading in its final box (whose first row names it): either
  // way the image has rows of its own, which keep their place as it arrives.
  const dimensions = inlineImageDimensions(message);
  const shown = new Set(images
    .filter((image) => image.phase === "ready" || holdsImageBox(image, dimensions))
    .map((image) => image.attachmentId));
  if (shown.size === 0) return message;
  const attachments = (list: DiscordMessage["attachments"]) => list.filter((attachment) => !shown.has(attachment.id));
  const stickerNames = (names: readonly string[], stickers: DiscordMessage["stickers"]) => {
    const remaining = [...names];
    for (const sticker of stickers ?? []) {
      const source = stickerImageAttachment(sticker, message.id);
      if (!source || !shown.has(source.id)) continue;
      const index = remaining.indexOf(sticker.name);
      if (index >= 0) remaining.splice(index, 1);
    }
    return remaining;
  };
  const forwarded = message.forwarded;
  return {
    ...message,
    attachments: attachments(message.attachments),
    stickerNames: stickerNames(message.stickerNames, message.stickers),
    forwarded: forwarded
      ? { ...forwarded, attachments: attachments(forwarded.attachments), stickerNames: stickerNames(forwarded.stickerNames, forwarded.stickers) }
      : forwarded,
  };
}

function messageLineBackgrounds(lines: readonly string[], background: string): string[] {
  return background ? lines.map(() => background) : lines.map(() => "");
}

function messagePingsViewer(
  message: DiscordMessage,
  viewerId: string | null,
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>,
  activeGuildId: string | null,
): boolean {
  if (!viewerId || message.author.id === viewerId) return false;
  if (message.mentionEveryone) return true;
  if (message.mentionUserIds.includes(viewerId)) return true;
  if (message.content.includes(`<@${viewerId}>`) || message.content.includes(`<@!${viewerId}>`)) return true;
  if (message.reply?.authorId === viewerId) return true;

  const guildId = message.guildId ?? activeGuildId;
  if (!guildId || message.mentionRoleIds.length === 0) return false;
  const viewerRoles = new Set(memberRoleIdsByGuildId[guildId]?.[viewerId] ?? []);
  return message.mentionRoleIds.some((roleId) => viewerRoles.has(roleId));
}

function authorColorForMessage(
  message: DiscordMessage,
  viewerId: string | null,
  accentViewerInDirectMessages: boolean,
  rolesByGuildId: Record<string, DiscordRole[]>,
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>,
  activeGuildId: string | null,
): string {
  if (accentViewerInDirectMessages) {
    return viewerId === message.author.id ? theme.accent : dmAuthorColor(message.author.id);
  }

  const guildId = message.guildId ?? activeGuildId;
  if (!guildId) return "";
  const roleIds = message.author.roleIds ?? memberRoleIdsByGuildId[guildId]?.[message.author.id] ?? [];
  const color = resolvePrimaryRoleColor(rolesByGuildId[guildId] ?? [], roleIds);
  return color ? ansiTrueColor(color) : "";
}

export function resolvePrimaryRoleColor(roles: readonly DiscordRole[], roleIds: readonly string[]): number | null {
  const roleIdsSet = new Set(roleIds);
  let selected: DiscordRole | null = null;
  for (const role of roles) {
    if (!roleIdsSet.has(role.id) || role.color === 0) continue;
    if (!selected || role.position > selected.position) selected = role;
  }
  return selected?.color ?? null;
}

function shouldGroupMessages(previous: DiscordMessage, message: DiscordMessage): boolean {
  if (previous.channelId !== message.channelId) return false;
  if (previous.author.id !== message.author.id) return false;
  if (message.reply) return false;
  // Keep uploads self-contained. Optimistic uploads use the local clock while
  // Discord timestamps the canonical response after the upload completes, so
  // grouping them can cross the five-minute boundary and briefly render only
  // the attachment row before the authored message replaces it.
  if (message.attachments.length > 0) return false;
  if (isCompactSystemMessageType(previous.type) || isCompactSystemMessageType(message.type)) return false;
  if (previous.call || message.call || message.type === 3 || previous.type === 3) return false;
  if (["failed", "unconfirmed"].includes(previous.localStatus ?? "")
    || ["failed", "unconfirmed"].includes(message.localStatus ?? "")) return false;

  const delta = message.timestamp - previous.timestamp;
  return delta >= 0 && delta <= MESSAGE_GROUP_WINDOW_MS;
}

function wrapFailureMessage(message: DiscordMessage, width: number): WrappedLine[] {
  if (message.localStatus !== "failed" && message.localStatus !== "unconfirmed") return [];
  const error = message.localError?.trim() || "Message failed to send.";
  return wrapPlainText(`${message.localStatus === "unconfirmed" ? "?" : "✗"} ${error}`, width).map((line, visualIndex) => ({
    text: line,
    wrapContinuation: visualIndex > 0,
    visualIndex,
  }));
}

function wrapReactionSummary(message: DiscordMessage, width: number): WrappedLine[] {
  const reactions = message.reactions?.filter((reaction) => reaction.count > 0) ?? [];
  if (reactions.length === 0) return [];
  const summary = `╰─ ${reactions.map(formatReactionChip).join("  ")}`;
  return wrapPlainText(summary, width).map((line, visualIndex) => ({
    text: line,
    wrapContinuation: visualIndex > 0,
    visualIndex,
  }));
}

function formatReactionChip(reaction: NonNullable<DiscordMessage["reactions"]>[number]): string {
  const emoji = reaction.emoji.id
    ? customEmojiMarker({
      id: reaction.emoji.id,
      name: reaction.emoji.name,
      animated: reaction.emoji.animated,
    })
    : reaction.emoji.name;
  return `${emoji} ${reaction.count}`;
}

function summarizeMessageParts(
  message: DiscordMessage,
  viewerId: string | null,
  accentViewerInDirectMessages: boolean,
  rolesByGuildId: Record<string, DiscordRole[]>,
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>,
  activeGuildId: string | null,
  loadingFrameIndex: number,
  nowMs: number,
  contentColor: string,
): MessageContentPart[] {
  if (message.call || message.type === 3) {
    return [{ kind: "text", text: summarizeCallMessage(message, viewerId, loadingFrameIndex, nowMs) }];
  }

  const forwarded = message.forwarded;
  // A forward shows the original's text and embeds; mentions resolve against it.
  const context: DiscordMessage = forwarded
    ? {
      ...message,
      content: forwarded.content,
      mentionEveryone: forwarded.mentionEveryone,
      mentionRoleIds: forwarded.mentionRoleIds,
      mentionUserIds: forwarded.mentionUsers.map((user) => user.id),
      mentionUsers: forwarded.mentionUsers,
      attachments: forwarded.attachments,
      stickerNames: forwarded.stickerNames,
      stickers: forwarded.stickers,
      embedsCount: forwarded.embedsCount,
      embeds: forwarded.embeds,
      forwarded: null,
    }
    : message;
  const formatText = (text: string, restore: string): string => renderOpenableLinks(renderUserMentions(
    replaceCustomEmojiTokens(text),
    context,
    viewerId,
    accentViewerInDirectMessages,
    rolesByGuildId,
    memberRoleIdsByGuildId,
    activeGuildId,
    restore,
  ), restore);
  const linkedContent = formatText(context.content, contentColor);
  const forwardedLabel = `${theme.muted}[Forwarded]${contentColor}`;
  const content = forwarded
    ? linkedContent.trim() ? `${forwardedLabel}: ${linkedContent}` : forwardedLabel
    : linkedContent;
  const occurrence = forwarded ? forwardedEmbedOccurrence(message.id) : message.id;
  const groups = embedGroups(context.embeds ?? [], occurrence).map((group) => ({ url: group.embed.url, group }));
  const parts: DisplayMessagePart<(typeof groups)[number]>[] = displayMessageParts(
    content,
    context.attachments,
    groups,
    context.stickerNames,
    { muted: theme.muted, accent: theme.accent, restore: contentColor },
  );
  return parts.map((part) => part.kind === "text"
    ? part
    : { kind: "embed", group: part.embed.group, occurrence, placed: part.placed, formatText });
}

function summarizeCallMessage(
  message: DiscordMessage,
  viewerId: string | null,
  loadingFrameIndex: number,
  nowMs: number,
): string {
  const call = message.call;
  if (!call) return "☎ Call";

  const viewerJoined = viewerId ? call.participantIds.includes(viewerId) : false;
  const otherParticipantCount = viewerId
    ? call.participantIds.filter((participantId) => participantId !== viewerId).length
    : call.participantIds.length;
  const participants = formatParticipantCount(call.participantIds.length);

  if (call.endedTimestamp !== null) {
    const duration = formatCallDuration(call.endedTimestamp - message.timestamp);
    if (viewerId && !viewerJoined && message.author.id !== viewerId) {
      return `✕ ☎ Missed call · ${duration}`;
    }
    return `✓ ☎ Call ended · ${duration} · ${participants}`;
  }

  const duration = formatCallDuration(nowMs - message.timestamp);
  const frame = loadingFrame(loadingFrameIndex);
  if (viewerId && !viewerJoined && message.author.id !== viewerId) {
    return `${frame} ☎ Incoming call · ${duration}`;
  }

  if (viewerId && message.author.id === viewerId && otherParticipantCount === 0) {
    return `${frame} ☎ Calling… · ${duration}`;
  }

  return `${frame} ☎ Call in progress · ${duration} · ${participants}`;
}

function formatParticipantCount(count: number): string {
  if (count === 1) return "1 participant";
  return `${count} participants`;
}

function formatCallDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const two = (value: number) => value.toString().padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${two(minutes)}:${two(seconds)}`;
  }
  return `${minutes}:${two(seconds)}`;
}

function renderUserMentions(
  content: string,
  message: DiscordMessage,
  viewerId: string | null,
  accentViewerInDirectMessages: boolean,
  rolesByGuildId: Record<string, DiscordRole[]>,
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>,
  activeGuildId: string | null,
  restoreColor: string,
): string {
  const withBroadcastMentions = content.replace(/(^|[^\w@])@(everyone|here)\b/g, (_raw, prefix: string, mention: string) => (
    `${prefix}${theme.accent}@${mention}${restoreColor}`
  ));
  const withRoleMentions = renderRoleMentions(withBroadcastMentions, message, rolesByGuildId, activeGuildId, restoreColor);

  const mentionUsers = new Map([...(message.mentionUsers ?? []), ...(message.localMentionUsers ?? [])].map((user) => [user.id, user]));
  if (mentionUsers.size === 0) return withRoleMentions;

  const withCanonicalMentions = withRoleMentions.replace(/<@!?(\d+)>/g, (raw, userId: string) => {
    const user = mentionUsers.get(userId);
    if (!user) return raw;
    return renderMentionLabel(message, user, viewerId, accentViewerInDirectMessages, rolesByGuildId, memberRoleIdsByGuildId, activeGuildId, restoreColor);
  });

  return [...mentionUsers.values()].reduce((text, user) => {
    const label = `@${user.displayName}`;
    if (!text.includes(label)) return text;
    return text.replaceAll(label, renderMentionLabel(
      message,
      user,
      viewerId,
      accentViewerInDirectMessages,
      rolesByGuildId,
      memberRoleIdsByGuildId,
      activeGuildId,
      restoreColor,
    ));
  }, withCanonicalMentions);
}

function renderRoleMentions(
  content: string,
  message: DiscordMessage,
  rolesByGuildId: Record<string, DiscordRole[]>,
  activeGuildId: string | null,
  restoreColor: string,
): string {
  const guildId = message.guildId ?? activeGuildId;
  if (!guildId || message.mentionRoleIds.length === 0) return content;

  const roles = rolesByGuildId[guildId] ?? [];
  if (roles.length === 0) return content;
  const rolesById = new Map(roles.map((role) => [role.id, role]));

  return content.replace(/<@&([^>]+)>/g, (raw, roleId: string) => {
    const role = rolesById.get(roleId);
    if (!role) return raw;
    const label = `@${role.name?.trim() || role.id}`;
    const color = role.color > 0 ? ansiTrueColor(role.color) : theme.accent;
    return `${color}${label}${restoreColor}`;
  });
}

function renderMentionLabel(
  message: DiscordMessage,
  user: DiscordGuildMember,
  viewerId: string | null,
  accentViewerInDirectMessages: boolean,
  rolesByGuildId: Record<string, DiscordRole[]>,
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>,
  activeGuildId: string | null,
  restoreColor: string,
): string {
  const label = `@${user.displayName}`;
  const mentionColor = mentionColorForUser(
    message,
    user,
    viewerId,
    accentViewerInDirectMessages,
    rolesByGuildId,
    memberRoleIdsByGuildId,
    activeGuildId,
  );
  return mentionColor ? `${mentionColor}${label}${restoreColor}` : label;
}

function renderOpenableLinks(content: string, restoreColor: string): string {
  return content.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, (raw) => {
    const trailing = raw.match(/[),.;:!?\]}]+$/)?.[0] ?? "";
    const target = trailing ? raw.slice(0, -trailing.length) : raw;
    if (!target) return raw;
    return `${theme.accent}${target}${restoreColor}${trailing}`;
  });
}

function mentionColorForUser(
  message: DiscordMessage,
  user: DiscordGuildMember,
  viewerId: string | null,
  accentViewerInDirectMessages: boolean,
  rolesByGuildId: Record<string, DiscordRole[]>,
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>,
  activeGuildId: string | null,
): string {
  if (accentViewerInDirectMessages) {
    return viewerId === user.id ? theme.accent : dmAuthorColor(user.id);
  }

  const guildId = message.guildId ?? activeGuildId;
  if (!guildId) return "";
  const roleIds = user.roleIds ?? memberRoleIdsByGuildId[guildId]?.[user.id] ?? [];
  const color = resolvePrimaryRoleColor(rolesByGuildId[guildId] ?? [], roleIds);
  return color ? ansiTrueColor(color) : "";
}

function wrapReplyPreview(
  message: DiscordMessage,
  width: number,
  viewerId: string | null,
  accentViewerInDirectMessages: boolean,
  rolesByGuildId: Record<string, DiscordRole[]>,
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>,
  activeGuildId: string | null,
): WrappedLine[] {
  if (!message.reply || width <= 0) return [];

  const prefix = "↪ ";
  // Like Discord, the quoted message is a one-row teaser: newlines collapse to
  // spaces and anything past the row is ellipsized.
  const preview = formatReplyPreview(message.reply, rolesByGuildId, message.guildId ?? activeGuildId)
    .replace(/\s+/g, " ")
    .trim();
  const colorize = (line: string) => colorizeReplyPreviewMentions(
    line,
    message,
    viewerId,
    accentViewerInDirectMessages,
    rolesByGuildId,
    memberRoleIdsByGuildId,
    activeGuildId,
  );
  const text = width <= termWidth(prefix)
    ? colorize(truncate(`${prefix}${preview}`, width))
    : `${prefix}${colorize(truncate(preview, width - termWidth(prefix)))}`;
  return [{ text, wrapContinuation: false, visualIndex: 0 }];
}

function formatReplyPreview(
  reply: NonNullable<DiscordMessage["reply"]>,
  rolesByGuildId: Record<string, DiscordRole[]>,
  guildId: string | null,
): string {
  const parts: string[] = [];
  if (reply.authorDisplayName) {
    parts.push(reply.authorDisplayName);
  }
  parts.push(formatReplySummaryMentions({
    ...reply,
    summary: formatReplySummaryRoleMentions(reply, rolesByGuildId, guildId),
  }));
  return replaceCustomEmojiTokens(parts.join(" · "));
}

function formatReplySummaryMentions(reply: NonNullable<DiscordMessage["reply"]>): string {
  const mentionUsers = new Map((reply.mentionUsers ?? []).map((user) => [user.id, user]));
  if (mentionUsers.size === 0) return reply.summary;

  return reply.summary.replace(/<@!?(\d+)>/g, (raw, userId: string) => {
    const user = mentionUsers.get(userId);
    return user ? `@${user.displayName}` : raw;
  });
}

function formatReplySummaryRoleMentions(
  reply: NonNullable<DiscordMessage["reply"]>,
  rolesByGuildId: Record<string, DiscordRole[]>,
  guildId: string | null,
): string {
  if (!guildId || !reply.mentionRoleIds || reply.mentionRoleIds.length === 0) return reply.summary;
  const rolesById = new Map((rolesByGuildId[guildId] ?? []).map((role) => [role.id, role]));
  return reply.summary.replace(/<@&([^>]+)>/g, (raw, roleId: string) => {
    const role = rolesById.get(roleId);
    return role ? `@${role.name?.trim() || role.id}` : raw;
  });
}

function colorizeReplyPreviewMentions(
  line: string,
  message: DiscordMessage,
  viewerId: string | null,
  accentViewerInDirectMessages: boolean,
  rolesByGuildId: Record<string, DiscordRole[]>,
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>,
  activeGuildId: string | null,
): string {
  let colorized = colorizeReplyPreviewRoleMentions(line, message, rolesByGuildId, activeGuildId);
  const mentionUsers = new Map((message.reply?.mentionUsers ?? []).map((user) => [user.id, user]));
  if (mentionUsers.size === 0) return colorized;

  for (const user of mentionUsers.values()) {
    const label = `@${user.displayName}`;
    const mentionColor = mentionColorForUser(
      message,
      user,
      viewerId,
      accentViewerInDirectMessages,
      rolesByGuildId,
      memberRoleIdsByGuildId,
      activeGuildId,
    );
    if (!mentionColor) continue;
    colorized = colorized.replaceAll(label, `${mentionColor}${label}${theme.muted}`);
  }
  return colorized;
}

function colorizeReplyPreviewRoleMentions(
  line: string,
  message: DiscordMessage,
  rolesByGuildId: Record<string, DiscordRole[]>,
  activeGuildId: string | null,
): string {
  const reply = message.reply;
  const guildId = message.guildId ?? activeGuildId;
  if (!reply || !guildId || !reply.mentionRoleIds || reply.mentionRoleIds.length === 0) return line;

  const rolesById = new Map((rolesByGuildId[guildId] ?? []).map((role) => [role.id, role]));
  let colorized = line;
  for (const roleId of reply.mentionRoleIds) {
    const role = rolesById.get(roleId);
    if (!role) continue;
    const label = `@${role.name?.trim() || role.id}`;
    const color = role.color > 0 ? ansiTrueColor(role.color) : theme.accent;
    colorized = colorized.replaceAll(label, `${color}${label}${theme.muted}`);
  }
  return colorized;
}

function wrapPlainText(text: string, width: number): string[] {
  if (width <= 0) return [];

  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      if (!current) {
        current = wrapFirstWord(word, width, lines);
        continue;
      }

      const candidate = `${current} ${word}`;
      if (termWidth(candidate) <= width) {
        current = candidate;
        continue;
      }

      lines.push(current);
      current = wrapFirstWord(word, width, lines);
    }

    if (current) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : [""];
}

function wrapFirstWord(word: string, width: number, lines: string[]): string {
  let remaining = word;
  while (termWidth(remaining) > width) {
    let [taken, rest] = sliceByWidth(remaining, width);
    // A character wider than the line gets a line of its own, whole.
    if (!taken) [taken, rest] = sliceByWidth(remaining, 2);
    lines.push(taken);
    remaining = rest;
  }
  return remaining;
}

function wrapMarkdownText(text: string, width: number, bgRestore = theme.text): WrappedLine[] {
  if (width <= 0) return [];

  const wrapped = markdownWordWrap(text, width, bgRestore);
  return wrapped.lines.map((line, visualIndex) => ({
    text: line,
    wrapContinuation: wrapped.cont[visualIndex] ?? false,
    visualIndex,
  }));
}

function getTimelineCacheState(timeline: TimelineState): TimelineCacheState {
  let cacheState = timelineCaches.get(timeline);
  if (cacheState) return cacheState;

  cacheState = {
    version: 0,
    messageRenderCache: new Map(),
    contentCache: null,
  };
  timelineCaches.set(timeline, cacheState);
  return cacheState;
}

/** Changes whenever the timeline's messages or render inputs change. */
export function timelineContentVersion(timeline: TimelineState): number {
  return getTimelineCacheState(timeline).version;
}

function invalidateTimelineContentCache(timeline: TimelineState): void {
  const cacheState = getTimelineCacheState(timeline);
  cacheState.version += 1;
  cacheState.contentCache = null;
}

function resetTimelineRenderCaches(timeline: TimelineState): void {
  const cacheState = getTimelineCacheState(timeline);
  cacheState.version += 1;
  cacheState.messageRenderCache.clear();
  cacheState.contentCache = null;
}

function timelineLiveRenderKey(timeline: TimelineState, loadingFrameIndex: number, nowMs: number): string {
  const loadingImage = hasLoadingInlineTimelineImage(timeline);
  const activeCall = hasActiveTimelineCall(timeline);
  if (!activeCall && !loadingImage) return "";
  return `${loadingFrameIndex}:${activeCall ? Math.floor(nowMs / 1000) : ""}`;
}

function callLiveRenderKey(message: DiscordMessage, loadingFrameIndex: number, nowMs: number): string {
  if (!message.call || message.call.endedTimestamp !== null) return "";
  return `${loadingFrameIndex}:${Math.floor(nowMs / 1000)}`;
}

/** Role lists are replaced, never mutated, when roles change. */
const roleListFingerprints = new WeakMap<readonly DiscordRole[], string>();

function rolesByGuildFingerprint(
  rolesByGuildId: Record<string, DiscordRole[]>,
  messageGuildId: string | null | undefined,
  activeGuildId: string | null,
): string {
  const guildId = messageGuildId ?? activeGuildId;
  if (!guildId) return "";
  const roles = rolesByGuildId[guildId];
  if (!roles) return "";
  let fingerprint = roleListFingerprints.get(roles);
  if (fingerprint === undefined) {
    // Joined once per role list instead of once per message per rebuild
    // (57% of appending a message to a long channel in a 200-role server).
    fingerprint = roles.map((role) => [role.id, role.name ?? "", String(role.color)].join("\u0002")).join("\u0000");
    roleListFingerprints.set(roles, fingerprint);
  }
  return fingerprint;
}

function messageRenderFingerprint(
  message: DiscordMessage,
  loadingFrameIndex: number,
  nowMs: number,
  rolesByGuildId: Record<string, DiscordRole[]>,
  activeGuildId: string | null,
  groupedWithPrevious = false,
  inlineImages: readonly InlineChatImageState[] = [],
): string {
  const attachmentKey = message.attachments.map((attachment) => [attachment.filename, attachment.contentType ?? "", String(attachment.size)].join("\u0002")).join("\u0000");
  const mentionKey = (message.mentionUsers ?? [])
    .map((mention) => [mention.id, mention.displayName, mention.roleIds?.join(",") ?? ""].join("\u0002"))
    .join("\u0000");
  const stickerKey = (message.stickers ?? []).map((sticker) => (
    [sticker.id, sticker.name, String(sticker.formatType ?? "")].join("\u0002")
  )).join("\u0000") || message.stickerNames.join("\u0000");
  // Every embed field is drawn now; embeds are small.
  const embedKey = message.embeds?.length ? JSON.stringify(message.embeds) : "";
  const reactionKey = (message.reactions ?? [])
    .map((reaction) => [reaction.emoji.id ?? "", reaction.emoji.name, reaction.emoji.animated ? "1" : "0", String(reaction.count), reaction.me ? "1" : "0"].join("\u0002"))
    .join("\u0000");
  const forwarded = message.forwarded;
  const forwardedKey = forwarded
    ? [
      forwarded.content,
      forwarded.mentionEveryone ? "1" : "0",
      forwarded.mentionRoleIds.join(","),
      forwarded.mentionUsers.map((mention) => [mention.id, mention.displayName, mention.roleIds?.join(",") ?? ""].join("\u0002")).join("\u0000"),
      forwarded.attachments.map((attachment) => [attachment.filename, attachment.contentType ?? "", String(attachment.size)].join("\u0002")).join("\u0000"),
      (forwarded.stickers ?? []).map((sticker) => [sticker.id, sticker.name, String(sticker.formatType ?? "")].join("\u0002")).join("\u0000")
        || forwarded.stickerNames.join("\u0000"),
      String(forwarded.embedsCount),
      forwarded.embeds.length ? JSON.stringify(forwarded.embeds) : "",
    ].join("\u0001")
    : "";
  const replyKey = message.reply
    ? [
      message.reply.messageId ?? "",
      message.reply.authorId ?? "",
      message.reply.authorDisplayName ?? "",
      String(message.reply.timestamp ?? ""),
      message.reply.summary,
      (message.reply.mentionRoleIds ?? []).join(","),
      (message.reply.mentionUsers ?? []).map((mention) => [mention.id, mention.displayName, mention.roleIds?.join(",") ?? ""].join("\u0002")).join("\u0000"),
    ].join("\u0000")
    : "";
  const callKey = message.call
    ? [
      String(message.call.endedTimestamp ?? ""),
      message.call.participantIds.join("\u0000"),
      callLiveRenderKey(message, loadingFrameIndex, nowMs),
    ].join("\u0000")
    : "";
  const inlineImageKey = inlineImages.map((image) => image.phase === "ready"
    ? [image.attachmentId, image.phase, String(image.imageId), String(image.pixelWidth), String(image.pixelHeight)].join("\u0002")
    : image.phase === "loading"
      ? [image.attachmentId, image.phase, String(image.requestId), isPendingInlineImage(image) ? "" : String(loadingFrameIndex)].join("\u0002")
      : [image.attachmentId, image.phase, String(image.requestId), image.phase === "error" ? image.error : ""].join("\u0002"))
    .join("\u0000");
  return [
    String(message.timestamp),
    String(message.editedTimestamp ?? ""),
    message.author.id,
    message.author.displayName,
    message.author.bot ? "1" : "0",
    String(message.type),
    message.content,
    message.mentionEveryone ? "1" : "0",
    message.mentionUserIds.join(","),
    message.mentionRoleIds.join(","),
    mentionKey,
    replyKey,
    callKey,
    attachmentKey,
    stickerKey,
    String(message.embedsCount),
    embedKey,
    forwardedKey,
    inlineImageKey,
    reactionKey,
    message.localStatus ?? "",
    message.localError ?? "",
    message.localSendContent ?? "",
    (message.localMentionUsers ?? []).map((mention) => [mention.id, mention.displayName, mention.roleIds?.join(",") ?? ""].join("\u0002")).join("\u0000"),
    rolesByGuildFingerprint(rolesByGuildId, message.guildId, activeGuildId),
    groupedWithPrevious ? "grouped" : "full",
  ].join("\u0001");
}
