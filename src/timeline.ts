/**
 * Message timeline state and rendering helpers.
 */

import { applyDiscordMessagePatch, type DiscordGuildMember, type DiscordMessage, type DiscordMessagePatch, type DiscordRole } from "./discord";
import { loadingFrame, loadingLabel } from "./loading";
import { markdownWordWrap } from "./markdown";
import { summarizeDisplayMessageParts } from "./messageparts";
import { sliceByWidth, termWidth, truncate } from "./textwidth";
import { ansiTrueColor, dmAuthorColor, theme, toneColor } from "./theme";

export interface TimelineState {
  channelId: string | null;
  messages: DiscordMessage[];
  scrollOffset: number;
  maxScroll: number;
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  requestId: number;
  viewerId: string | null;
  accentViewerInDirectMessages: boolean;
  rolesByGuildId: Record<string, DiscordRole[]>;
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>;
  memberRoleCacheVersion: number;
  activeGuildId: string | null;
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
  wrapContinuation: boolean[];
  messageBounds: TimelineMessageBound[];
  maxScroll: number;
}

interface WrappedLine {
  text: string;
  wrapContinuation: boolean;
  visualIndex: number;
}

interface RenderedMessage {
  lines: string[];
  lineAnchors: string[];
  wrapContinuation: boolean[];
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
  lines: string[];
  lineAnchors: string[];
  wrapContinuation: boolean[];
  messageBounds: TimelineMessageBound[];
}

interface TimelineCacheState {
  version: number;
  messageRenderCache: Map<string, CachedRenderedMessage>;
  contentCache: CachedTimelineContent | null;
}

const timelineCaches = new WeakMap<TimelineState, TimelineCacheState>();
const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

export function createTimelineState(): TimelineState {
  return {
    channelId: null,
    messages: [],
    scrollOffset: 0,
    maxScroll: 0,
    loading: false,
    loadingOlder: false,
    hasOlder: false,
    requestId: 0,
    viewerId: null,
    accentViewerInDirectMessages: false,
    rolesByGuildId: {},
    memberRoleIdsByGuildId: {},
    memberRoleCacheVersion: 0,
    activeGuildId: null,
  };
}

export function clearTimeline(timeline: TimelineState): void {
  timeline.channelId = null;
  timeline.messages = [];
  timeline.scrollOffset = 0;
  timeline.maxScroll = 0;
  timeline.loading = false;
  timeline.loadingOlder = false;
  timeline.hasOlder = false;
  resetTimelineRenderCaches(timeline);
}

export function setTimelineMessages(
  timeline: TimelineState,
  channelId: string,
  messages: DiscordMessage[],
  options: { hasOlder?: boolean } = {},
): void {
  timeline.channelId = channelId;
  timeline.messages = messages;
  timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
  timeline.maxScroll = 0;
  timeline.loading = false;
  timeline.loadingOlder = false;
  timeline.hasOlder = options.hasOlder ?? messages.length > 0;
  resetTimelineRenderCaches(timeline);
}

export function startLoadingOlderMessages(timeline: TimelineState): void {
  if (timeline.loading || timeline.loadingOlder || !timeline.hasOlder || !timeline.channelId) return;
  timeline.loadingOlder = true;
}

export function finishLoadingOlderMessages(timeline: TimelineState, hasOlder = timeline.hasOlder): void {
  timeline.loadingOlder = false;
  timeline.hasOlder = hasOlder;
}

export function appendTimelineMessage(timeline: TimelineState, message: DiscordMessage): void {
  if (timeline.channelId !== message.channelId) return;
  const existingIndex = timeline.messages.findIndex((existing) => existing.id === message.id);
  if (existingIndex >= 0) {
    timeline.messages[existingIndex] = message;
    invalidateTimelineContentCache(timeline);
    return;
  }

  const pendingIndex = findMatchingPendingLocalMessageIndex(timeline, message);
  if (pendingIndex >= 0) {
    timeline.messages[pendingIndex] = message;
  } else {
    timeline.messages.push(message);
  }
  invalidateTimelineContentCache(timeline);
}

function findMatchingPendingLocalMessageIndex(timeline: TimelineState, message: DiscordMessage): number {
  if (message.localStatus) return -1;
  return timeline.messages.findIndex((existing) => existing.localStatus === "pending"
    && existing.channelId === message.channelId
    && existing.author.id === message.author.id
    && (existing.content === message.content || existing.localSendContent === message.content)
    && attachmentsMatchPendingLocalEcho(existing, message));
}

function attachmentsMatchPendingLocalEcho(pending: DiscordMessage, message: DiscordMessage): boolean {
  if (pending.attachments.length !== message.attachments.length) return false;
  if (pending.attachments.length === 0) return true;

  return pending.attachments.every((attachment, index) => {
    const echoed = message.attachments[index];
    return Boolean(echoed)
      && attachment.filename === echoed.filename
      && attachment.size === echoed.size
      && (attachment.contentType === null || echoed.contentType === null || attachment.contentType === echoed.contentType);
  });
}

export function replaceTimelineMessage(timeline: TimelineState, localMessageId: string, message: DiscordMessage): void {
  if (timeline.channelId !== message.channelId) return;
  const localIndex = timeline.messages.findIndex((existing) => existing.id === localMessageId);
  const canonicalIndex = timeline.messages.findIndex((existing) => existing.id === message.id);
  if (localIndex >= 0) {
    timeline.messages[localIndex] = message;
    if (canonicalIndex >= 0 && canonicalIndex !== localIndex) {
      timeline.messages.splice(canonicalIndex, 1);
    }
  } else if (canonicalIndex >= 0) {
    timeline.messages[canonicalIndex] = message;
  } else {
    timeline.messages.push(message);
  }
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
  invalidateTimelineContentCache(timeline);
}

export function patchTimelineMessage(timeline: TimelineState, patch: DiscordMessagePatch): void {
  if (timeline.channelId !== patch.channelId) return;
  const existingIndex = timeline.messages.findIndex((existing) => existing.id === patch.id);
  if (existingIndex < 0) return;
  const existing = timeline.messages[existingIndex];
  if (!existing) return;
  timeline.messages[existingIndex] = applyDiscordMessagePatch(existing, patch);
  invalidateTimelineContentCache(timeline);
}

export function removeTimelineMessage(timeline: TimelineState, messageId: string, channelId?: string): void {
  if (channelId && timeline.channelId !== channelId) return;
  const before = timeline.messages.length;
  timeline.messages = timeline.messages.filter((message) => message.id !== messageId);
  if (timeline.messages.length !== before) {
    invalidateTimelineContentCache(timeline);
  }
}

export function removeTimelineMessages(timeline: TimelineState, messageIds: string[], channelId?: string): void {
  if (channelId && timeline.channelId !== channelId) return;
  const ids = new Set(messageIds);
  const before = timeline.messages.length;
  timeline.messages = timeline.messages.filter((message) => !ids.has(message.id));
  if (timeline.messages.length !== before) {
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

export function shouldLoadOlderMessages(timeline: TimelineState): boolean {
  if (timeline.loading || timeline.loadingOlder || !timeline.hasOlder || !timeline.channelId || timeline.messages.length === 0) {
    return false;
  }

  if (timeline.maxScroll === 0) {
    return timeline.scrollOffset === 0;
  }

  return timeline.scrollOffset <= Math.floor(timeline.maxScroll / 2);
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
  let wrapContinuation: boolean[] = [];
  let messageBounds: TimelineMessageBound[] = [];

  const showNoticeInTimeline = notice.chat !== false;

  if (showNoticeInTimeline && notice.text) {
    for (const [index, line] of notice.text.split("\n").entries()) {
      const renderedLine = notice.loading ? loadingLabel(line, loadingFrameIndex) : line;
      allLines.push(`${toneColor(notice.tone)}${truncate(renderedLine, width)}${theme.reset}`);
      lineAnchors.push(`notice:${index}:${notice.loading ? "loading" : "static"}:${line}`);
      wrapContinuation.push(false);
    }
    if (allLines.length > 0) {
      allLines.push("");
      lineAnchors.push("notice:gap");
      wrapContinuation.push(false);
    }
  }

  if (timeline.loading) {
    allLines.push(`${theme.muted}${truncate(loadingLabel("Loading messages…", loadingFrameIndex), width)}${theme.reset}`);
    lineAnchors.push("timeline:loading");
    wrapContinuation.push(false);

    if (timeline.messages.length > 0) {
      const content = getRenderedTimelineContent(timeline, width, loadingFrameIndex, Date.now());
      appendRenderedTimelineContent(allLines, lineAnchors, wrapContinuation, messageBounds, content);
    }
  } else {
    const content = getRenderedTimelineContent(timeline, width, loadingFrameIndex, Date.now());
    if ((showNoticeInTimeline && notice.text) || timeline.loadingOlder) {
      if (timeline.loadingOlder) {
        allLines.push(`${theme.muted}${truncate(loadingLabel("Loading older messages…", loadingFrameIndex), width)}${theme.reset}`);
        lineAnchors.push("timeline:loading-older");
        wrapContinuation.push(false);
      }
      appendRenderedTimelineContent(allLines, lineAnchors, wrapContinuation, messageBounds, content);
    } else {
      allLines = content.lines;
      lineAnchors = content.lineAnchors;
      wrapContinuation = content.wrapContinuation;
      messageBounds = content.messageBounds;
    }
  }

  if (!(showNoticeInTimeline && notice.text) && timeline.loading && timeline.messages.length > 0) {
    prependBlankTimelineRows(allLines, lineAnchors, wrapContinuation, messageBounds, Math.max(0, height - allLines.length));
  }

  const maxScroll = Math.max(0, allLines.length - Math.max(0, height));
  const scrollOffset = Math.max(0, Math.min(timeline.scrollOffset, maxScroll));
  timeline.scrollOffset = scrollOffset;
  timeline.maxScroll = maxScroll;

  return {
    lines: allLines.slice(scrollOffset, scrollOffset + Math.max(0, height)),
    allLines,
    lineAnchors,
    wrapContinuation,
    messageBounds,
    maxScroll,
  };
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
  wrapContinuation: boolean[],
  messageBounds: TimelineMessageBound[],
  count: number,
): void {
  if (count <= 0) return;
  allLines.unshift(...Array.from({ length: count }, () => ""));
  lineAnchors.unshift(...Array.from({ length: count }, (_unused, index) => `timeline:loading-pad:${index}`));
  wrapContinuation.unshift(...Array.from({ length: count }, () => false));
  for (const bound of messageBounds) {
    bound.start += count;
    bound.end += count;
    bound.contentStart += count;
    bound.contentEnd += count;
  }
}

function appendRenderedTimelineContent(
  allLines: string[],
  lineAnchors: string[],
  wrapContinuation: boolean[],
  messageBounds: TimelineMessageBound[],
  content: CachedTimelineContent,
): void {
  const offset = allLines.length;
  allLines.push(...content.lines);
  lineAnchors.push(...content.lineAnchors);
  wrapContinuation.push(...content.wrapContinuation);
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

  const lines: string[] = [];
  const lineAnchors: string[] = [];
  const wrapContinuation: boolean[] = [];
  const messageBounds: TimelineMessageBound[] = [];

  if (!timeline.channelId && timeline.messages.length === 0) {
    // No active channel yet.
  } else if (timeline.messages.length === 0) {
    lines.push(`${theme.muted}No messages yet.${theme.reset}`);
    lineAnchors.push("timeline:empty");
    wrapContinuation.push(false);
  } else {
    let previousMessage: DiscordMessage | null = null;
    let currentMessageGroupId: string | null = null;
    for (const message of timeline.messages) {
      const groupedWithPrevious = previousMessage ? shouldGroupMessages(previousMessage, message) : false;
      if (previousMessage && !groupedWithPrevious) {
        lines.push("");
        lineAnchors.push(`msg:${previousMessage.id}:gap`);
        wrapContinuation.push(false);
      }
      if (!groupedWithPrevious) currentMessageGroupId = message.id;

      const renderedMessage = renderMessageCached(timeline, message, width, loadingFrameIndex, nowMs, groupedWithPrevious);
      const start = lines.length;
      lines.push(...renderedMessage.lines);
      lineAnchors.push(...renderedMessage.lineAnchors);
      wrapContinuation.push(...renderedMessage.wrapContinuation);
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
    lines,
    lineAnchors,
    wrapContinuation,
    messageBounds,
  };
  cacheState.contentCache = content;
  return content;
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
  const fingerprint = messageRenderFingerprint(message, loadingFrameIndex, nowMs, groupedWithPrevious);
  const cacheKey = `${message.id}:${groupedWithPrevious ? "grouped" : "full"}`;
  const cached = cacheState.messageRenderCache.get(cacheKey);
  if (cached && cached.width === width && cached.fingerprint === fingerprint) {
    return cached.rendered;
  }

  const rendered = renderMessage(message, width, timeline.viewerId, timeline.accentViewerInDirectMessages, timeline.rolesByGuildId, timeline.memberRoleIdsByGuildId, timeline.activeGuildId, loadingFrameIndex, nowMs, groupedWithPrevious);
  cacheState.messageRenderCache.set(cacheKey, { width, fingerprint, rendered });
  return rendered;
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
): RenderedMessage {
  const time = new Date(message.timestamp).toISOString().slice(11, 16);
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
  const statusSuffix = message.localStatus === "failed" ? `${theme.error} failed` : "";
  const header = `${theme.bold}${authorColor}${truncate(author, Math.max(1, width - 7))}${theme.boldOff}${theme.muted} ${time}${statusSuffix}${theme.reset}`;
  const replyPreview = wrapReplyPreview(message, width);

  const headerLines = groupedWithPrevious ? [] : [header];
  const headerAnchors = groupedWithPrevious ? [] : [`msg:${message.id}:header`];
  const headerWrapContinuation = groupedWithPrevious ? [] : [false];

  const contentColor = message.localStatus ? theme.muted : theme.text;
  const content = summarizeMessage(
    message,
    viewerId,
    accentViewerInDirectMessages,
    rolesByGuildId,
    memberRoleIdsByGuildId,
    activeGuildId,
    loadingFrameIndex,
    nowMs,
    contentColor,
  );
  if (content === "") {
    return {
      lines: [
        ...replyPreview.map((line) => `${theme.muted}${line.text}${theme.reset}`),
        ...headerLines,
        `${theme.dim}(empty message)${theme.reset}`,
      ],
      lineAnchors: [
        ...replyPreview.map((line) => `msg:${message.id}:reply:${line.visualIndex}`),
        ...headerAnchors,
        `msg:${message.id}:empty`,
      ],
      wrapContinuation: [...replyPreview.map((line) => line.wrapContinuation), ...headerWrapContinuation, false],
    };
  }

  const wrappedContent = wrapMarkdownText(content, width, contentColor);
  const failureLines = wrapFailureMessage(message, width);
  return {
    lines: [
      ...replyPreview.map((line) => `${theme.muted}${line.text}${theme.reset}`),
      ...headerLines,
      ...wrappedContent.map((line) => `${contentColor}${line.text}${theme.reset}`),
      ...failureLines.map((line) => `${theme.failure}${line.text}${theme.reset}`),
    ],
    lineAnchors: [
      ...replyPreview.map((line) => `msg:${message.id}:reply:${line.visualIndex}`),
      ...headerAnchors,
      ...wrappedContent.map((line) => `msg:${message.id}:content:${line.visualIndex}`),
      ...failureLines.map((line) => `msg:${message.id}:failure:${line.visualIndex}`),
    ],
    wrapContinuation: [
      ...replyPreview.map((line) => line.wrapContinuation),
      ...headerWrapContinuation,
      ...wrappedContent.map((line) => line.wrapContinuation),
      ...failureLines.map((line) => line.wrapContinuation),
    ],
  };
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
  if (previous.call || message.call || message.type === 3 || previous.type === 3) return false;
  if (previous.localStatus === "failed" || message.localStatus === "failed") return false;

  const delta = message.timestamp - previous.timestamp;
  return delta >= 0 && delta <= MESSAGE_GROUP_WINDOW_MS;
}

function wrapFailureMessage(message: DiscordMessage, width: number): WrappedLine[] {
  if (message.localStatus !== "failed") return [];
  const error = message.localError?.trim() || "Message failed to send.";
  return wrapPlainText(`✗ ${error}`, width).map((line, visualIndex) => ({
    text: line,
    wrapContinuation: visualIndex > 0,
    visualIndex,
  }));
}

function summarizeMessage(
  message: DiscordMessage,
  viewerId: string | null,
  accentViewerInDirectMessages: boolean,
  rolesByGuildId: Record<string, DiscordRole[]>,
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>,
  activeGuildId: string | null,
  loadingFrameIndex: number,
  nowMs: number,
  contentColor: string,
): string {
  if (message.call || message.type === 3) {
    return summarizeCallMessage(message, viewerId, loadingFrameIndex, nowMs);
  }

  const mentionsRendered = renderUserMentions(
    message.content,
    message,
    viewerId,
    accentViewerInDirectMessages,
    rolesByGuildId,
    memberRoleIdsByGuildId,
    activeGuildId,
    contentColor,
  );
  const content = renderOpenableLinks(mentionsRendered, contentColor);
  return summarizeDisplayMessageParts(
    content,
    message.attachments,
    message.embeds ?? message.embedsCount,
    message.stickerNames,
    { muted: theme.muted, accent: theme.accent, restore: contentColor },
  ).join("\n");
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

  const mentionUsers = new Map((message.mentionUsers ?? []).map((user) => [user.id, user]));
  if (mentionUsers.size === 0) return withBroadcastMentions;

  return withBroadcastMentions.replace(/<@!?(\d+)>/g, (raw, userId: string) => {
    const user = mentionUsers.get(userId);
    if (!user) return raw;
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
  });
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

function wrapReplyPreview(message: DiscordMessage, width: number): WrappedLine[] {
  if (!message.reply || width <= 0) return [];

  const prefix = "↪ ";
  const preview = formatReplyPreview(message.reply);
  if (width <= termWidth(prefix)) {
    return wrapPlainText(`↪ ${preview}`, width).map((line, visualIndex) => ({
      text: line,
      wrapContinuation: visualIndex > 0,
      visualIndex,
    }));
  }

  const continuationPrefix = "  ";
  const bodyWidth = width - termWidth(prefix);
  const lines = wrapPlainText(preview, bodyWidth);

  return lines.map((line, visualIndex) => ({
    text: `${visualIndex === 0 ? prefix : continuationPrefix}${line}`,
    wrapContinuation: visualIndex > 0,
    visualIndex,
  }));
}

function formatReplyPreview(reply: NonNullable<DiscordMessage["reply"]>): string {
  const parts: string[] = [];
  if (reply.authorDisplayName) {
    parts.push(reply.authorDisplayName);
  }
  parts.push(reply.summary);
  return parts.join(" · ");
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
    const [taken, rest] = sliceByWidth(remaining, width);
    if (!taken) {
      lines.push(remaining[0] ?? "");
      remaining = remaining.slice(1);
      continue;
    }
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
  if (!hasActiveTimelineCall(timeline)) return "";
  return `${loadingFrameIndex}:${Math.floor(nowMs / 1000)}`;
}

function callLiveRenderKey(message: DiscordMessage, loadingFrameIndex: number, nowMs: number): string {
  if (!message.call || message.call.endedTimestamp !== null) return "";
  return `${loadingFrameIndex}:${Math.floor(nowMs / 1000)}`;
}

function messageRenderFingerprint(message: DiscordMessage, loadingFrameIndex: number, nowMs: number, groupedWithPrevious = false): string {
  const attachmentKey = message.attachments.map((attachment) => [attachment.filename, attachment.contentType ?? "", String(attachment.size)].join("\u0002")).join("\u0000");
  const mentionKey = (message.mentionUsers ?? [])
    .map((mention) => [mention.id, mention.displayName, mention.roleIds?.join(",") ?? ""].join("\u0002"))
    .join("\u0000");
  const stickerKey = message.stickerNames.join("\u0000");
  const embedKey = (message.embeds ?? [])
    .map((embed) => [embed.type ?? "", embed.providerName ?? "", embed.authorName ?? "", embed.title ?? "", embed.url ?? "", embed.description ?? ""].join("\u0002"))
    .join("\u0000");
  const replyKey = message.reply
    ? [
      message.reply.messageId ?? "",
      message.reply.authorId ?? "",
      message.reply.authorDisplayName ?? "",
      String(message.reply.timestamp ?? ""),
      message.reply.summary,
    ].join("\u0000")
    : "";
  const callKey = message.call
    ? [
      String(message.call.endedTimestamp ?? ""),
      message.call.participantIds.join("\u0000"),
      callLiveRenderKey(message, loadingFrameIndex, nowMs),
    ].join("\u0000")
    : "";
  return [
    String(message.timestamp),
    String(message.editedTimestamp ?? ""),
    message.author.id,
    message.author.displayName,
    message.author.bot ? "1" : "0",
    String(message.type),
    message.content,
    mentionKey,
    replyKey,
    callKey,
    attachmentKey,
    stickerKey,
    String(message.embedsCount),
    embedKey,
    message.localStatus ?? "",
    message.localError ?? "",
    message.localSendContent ?? "",
    groupedWithPrevious ? "grouped" : "full",
  ].join("\u0001");
}
