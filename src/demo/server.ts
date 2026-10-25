/**
 * In-process fake Discord for demo mode: REST API, CDN and gateway.
 *
 * Demo mode replaces globalThis.fetch and globalThis.WebSocket with this
 * server, so every Record code path above the HTTP/WebSocket layer runs
 * unchanged. Any request that is not to Discord's API/CDN hosts is refused:
 * demo mode never opens a network connection.
 */

import { appendFileSync } from "node:fs";

import type { DiscordChannelResponse, DiscordEmbedResponse, DiscordMessageResponse } from "../discord";
import {
  buildDemoWorld,
  buildHistory,
  buildIncomingContent,
  buildMessageAuthor,
  DEMO_TOKEN,
  hashString,
  imageAttachment,
  imageVariant,
  IMAGE_VARIANT_COUNT,
  seededRng,
  snowflake,
  type DemoGuild,
  type DemoUser,
  type DemoWorld,
  type Rng,
} from "./data";
import { DEMO_MEDIA_PROXY_HOSTS, demoMediaVariant, demoReleaseEmbed } from "./embeds";
import { hexColor, renderIcon, renderPicture } from "./png";

export const DEMO_API_HOST = "discord.com";
export const DEMO_GATEWAY_URL = "wss://gateway.discord.gg";
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net", ...DEMO_MEDIA_PROXY_HOSTS]);
/** How long after a channel opens its pending link previews unfurl. */
const DEMO_UNFURL_DELAY_MS = 1500;
const API_PREFIX = "/api/v9";

export interface DemoServerOptions {
  anchorMs?: number;
  /** Latency for ordinary REST calls. */
  latencyMs?: number;
  /** Extra latency for older-history pages (`before=`), to exercise loading states. */
  olderPageDelayMs?: number;
  /** Append request lines here (demo dir), or null for no log. */
  logPath?: string | null;
}

export class DemoNetworkBlockedError extends TypeError {
  constructor(readonly target: string) {
    super(`Network access is disabled in Record demo mode (${target}).`);
    this.name = "DemoNetworkBlockedError";
  }
}

interface StoredUpload {
  bytes: Uint8Array;
  contentType: string;
}

export class DemoDiscordServer {
  readonly world: DemoWorld;
  readonly requests: string[] = [];
  readonly blocked: string[] = [];
  private readonly latencyMs: number;
  private readonly olderPageDelayMs: number;
  private readonly logPath: string | null;
  private readonly histories = new Map<string, DiscordMessageResponse[]>();
  private readonly pins = new Map<string, Set<string>>();
  private readonly imageVariantByAttachment = new Map<string, number>();
  private readonly variantBytes = new Map<number, Buffer>();
  private readonly uploads = new Map<string, StoredUpload>();
  private readonly cdnCache = new Map<string, Buffer>();
  /** Message id -> embeds that arrive by MESSAGE_UPDATE once its channel is opened. */
  private readonly lateEmbeds = new Map<string, DiscordEmbedResponse[]>();
  private readonly sockets = new Set<FakeGatewaySocket>();
  private readonly incomingRng: Rng = seededRng(hashString("incoming"));
  private incomingCounter = 0;
  private sequence = 1;
  private incomingTimer: ReturnType<typeof setInterval> | null = null;
  /** The channel the client most recently opened (latest page fetch or op 37 subscription). */
  openChannelId: string | null = null;

  constructor(options: DemoServerOptions = {}) {
    this.world = buildDemoWorld(options.anchorMs);
    this.latencyMs = options.latencyMs ?? 20;
    this.olderPageDelayMs = options.olderPageDelayMs ?? 450;
    this.logPath = options.logPath ?? null;
  }

  // -------------------------------------------------------------------------
  // Global hooks

  /** Drop-in replacement for globalThis.fetch. */
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const signal = init?.signal ?? request?.signal ?? null;
    if (url.protocol !== "https:" || (url.hostname !== DEMO_API_HOST && !CDN_HOSTS.has(url.hostname))) {
      this.blocked.push(`${method} ${url.origin}${url.pathname}`);
      this.log(`BLOCKED ${method} ${url.href}`);
      throw new DemoNetworkBlockedError(url.origin);
    }
    this.requests.push(`${method} ${url.hostname}${url.pathname}${url.search}`);
    this.log(`${method} ${url.hostname}${url.pathname}${url.search}`);
    if (CDN_HOSTS.has(url.hostname)) return this.cdn(url);
    if (!url.pathname.startsWith(API_PREFIX)) return json({ message: "404: Not Found", code: 0 }, 404);

    const path = url.pathname.slice(API_PREFIX.length);
    const isOlderPage = method === "GET" && url.searchParams.has("before") && /\/messages$/.test(path);
    await delay(isOlderPage ? this.olderPageDelayMs : this.latencyMs, signal);
    const body = init?.body ?? (request ? await request.arrayBuffer() : null);
    // Like discord.com: a request that announces JSON must carry valid JSON.
    if (headerValue(init?.headers, "content-type")?.includes("application/json") && !validJsonBody(body)) {
      return json({ message: "The request body contains invalid JSON.", code: 50109 }, 400);
    }
    return this.api(method, path, url.searchParams, body, headerValue(init?.headers, "authorization"));
  }) as typeof fetch;

  /** WebSocket class bound to this server. */
  readonly WebSocket = makeWebSocketClass(this);

  // -------------------------------------------------------------------------
  // Incoming-message controls

  /** Append `count` messages from other people to the open channel. */
  emitIncoming(count = 1, channelId = this.openChannelId): number {
    const target = channelId && this.history(channelId) ? channelId : this.world.defaultChannel.channelId;
    const history = this.history(target)!;
    const guild = this.guildForChannel(target);
    const speakers = this.speakersFor(target);
    for (let i = 0; i < count; i += 1) {
      const author = speakers[Math.floor(this.incomingRng() * speakers.length)]!;
      this.incomingCounter += 1;
      const { content } = buildIncomingContent(this.incomingRng, this.incomingCounter);
      const now = Math.max(Date.now(), snowflakeMs(history.at(-1)?.id) + 1);
      const message: DiscordMessageResponse = {
        id: snowflake(now, this.incomingCounter),
        channel_id: target,
        ...(guild ? { guild_id: guild.id } : {}),
        content,
        timestamp: new Date(now).toISOString(),
        edited_timestamp: null,
        type: 0,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        ...buildMessageAuthor(this.world, guild, author.id),
      };
      if (this.incomingCounter % 7 === 0) {
        const variant = this.incomingCounter % IMAGE_VARIANT_COUNT;
        const shape = imageVariant(variant);
        const attachmentId = snowflake(now, 1000 + this.incomingCounter);
        message.attachments = [imageAttachment(target, attachmentId, `${shape.key}.png`, shape.width, shape.height, this.registerImage(attachmentId, variant))];
      }
      history.push(message);
      this.bumpLastMessage(target, message.id);
      this.dispatch("MESSAGE_CREATE", message);
    }
    return count;
  }

  /** Show someone typing in the open channel. */
  emitTyping(channelId = this.openChannelId): void {
    if (!channelId) return;
    const guild = this.guildForChannel(channelId);
    const speaker = this.speakersFor(channelId)[0]!;
    this.dispatch("TYPING_START", {
      channel_id: channelId,
      ...(guild ? { guild_id: guild.id } : {}),
      user_id: speaker.id,
      timestamp: Math.floor(Date.now() / 1000),
      member: { user: { id: speaker.id, username: speaker.username, global_name: speaker.globalName } },
    });
  }

  startIncomingTimer(intervalMs: number): void {
    this.stopIncomingTimer();
    if (!(intervalMs > 0)) return;
    this.incomingTimer = setInterval(() => this.emitIncoming(1), intervalMs);
    this.incomingTimer.unref?.();
  }

  stopIncomingTimer(): void {
    if (this.incomingTimer) clearInterval(this.incomingTimer);
    this.incomingTimer = null;
  }

  /** Render image variants ahead of use, one per tick, so first opens stay snappy. */
  warmImages(): void {
    let next = 0;
    const step = (): void => {
      if (next >= IMAGE_VARIANT_COUNT) return;
      this.variantPng(next);
      next += 1;
      setTimeout(step, 5).unref?.();
    };
    setTimeout(step, 1500).unref?.();
  }

  shutdown(): void {
    this.stopIncomingTimer();
    for (const socket of [...this.sockets]) socket.close(1000);
  }

  // -------------------------------------------------------------------------
  // Data access

  history(channelId: string): DiscordMessageResponse[] | null {
    const existing = this.histories.get(channelId);
    if (existing) return existing;
    const spec = this.world.histories.get(channelId);
    if (!spec) {
      if (!this.findChannel(channelId)) return null;
      const empty: DiscordMessageResponse[] = [];
      this.histories.set(channelId, empty);
      return empty;
    }
    const built = buildHistory(spec, {
      world: this.world,
      guild: this.guildForChannel(channelId),
      registerImage: (attachmentId, variant) => this.registerImage(attachmentId, variant),
      registerLateEmbeds: (messageId, embeds) => this.lateEmbeds.set(messageId, embeds),
    });
    this.histories.set(channelId, built);
    // A few pinned messages per channel.
    const pinned = new Set<string>();
    for (let i = built.length - 7; i >= 0 && pinned.size < 3; i -= Math.max(1, Math.floor(built.length / 4))) {
      if (built[i]!.type === 0) pinned.add(built[i]!.id);
    }
    this.pins.set(channelId, pinned);
    return built;
  }

  private registerImage(attachmentId: string, variant: number): number {
    this.imageVariantByAttachment.set(attachmentId, variant);
    return this.variantPng(variant).length;
  }

  private variantPng(variant: number): Buffer {
    let bytes = this.variantBytes.get(variant);
    if (!bytes) {
      const shape = imageVariant(variant);
      bytes = renderPicture(shape.width, shape.height, shape.from, shape.to, shape.seed);
      this.variantBytes.set(variant, bytes);
    }
    return bytes;
  }

  findChannel(channelId: string): { channel: DiscordChannelResponse; guild: DemoGuild | null } | null {
    for (const guild of this.world.guilds) {
      const channel = guild.channels.find((candidate) => candidate.id === channelId)
        ?? guild.threads.find((candidate) => candidate.id === channelId);
      if (channel) return { channel, guild };
    }
    const dm = this.world.directMessages.find((candidate) => candidate.id === channelId);
    return dm ? { channel: dm, guild: null } : null;
  }

  private guildForChannel(channelId: string): DemoGuild | null {
    return this.findChannel(channelId)?.guild ?? null;
  }

  private speakersFor(channelId: string): DemoUser[] {
    const found = this.findChannel(channelId);
    const ids = found?.guild
      ? found.guild.memberIds
      : (found?.channel.recipients ?? []).map((recipient) => recipient.id);
    const speakers = ids.map((id) => this.world.users.get(id)).filter((user): user is DemoUser => Boolean(user && user.id !== this.world.self.id && !user.bot));
    return speakers.length > 0 ? speakers : [...this.world.users.values()].filter((user) => user.id !== this.world.self.id);
  }

  private bumpLastMessage(channelId: string, messageId: string): void {
    const found = this.findChannel(channelId);
    if (found) found.channel.last_message_id = messageId;
  }

  private messageById(channelId: string, messageId: string): DiscordMessageResponse | null {
    return this.history(channelId)?.find((message) => message.id === messageId) ?? null;
  }

  // -------------------------------------------------------------------------
  // REST

  private async api(method: string, path: string, query: URLSearchParams, body: unknown, authorization: string | null): Promise<Response> {
    if (path === "/gateway") return json({ url: DEMO_GATEWAY_URL });
    if (authorization !== DEMO_TOKEN) return json({ message: "401: Unauthorized", code: 0 }, 401);
    const world = this.world;
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const route = (pattern: string): boolean => matchRoute(pattern, parts);

    if (method === "GET" && route("users/@me")) {
      return json({ id: world.self.id, username: world.self.username, global_name: world.self.globalName, discriminator: "0", avatar: world.self.avatar, email: "demo@example.invalid", verified: true, premium_type: 2 });
    }
    if (method === "GET" && route("users/@me/settings-proto/1")) return json({ settings: "" });
    if (method === "GET" && route("users/@me/settings")) return json({ status: "online", custom_status: { text: "offline demo mode" } });
    if (method === "GET" && route("users/@me/channels")) return json(world.directMessages);
    if (method === "GET" && route("users/@me/guilds")) {
      return json(world.guilds.map((guild) => ({
        id: guild.id, name: guild.name, icon: guild.icon, owner: guild.ownerId === world.self.id,
        owner_id: guild.ownerId, permissions: guild.roles[0]!.permissions,
      })));
    }
    if (method === "GET" && route("users/@me/guilds/:id/member")) {
      return json({ roles: this.guild(parts[3]!)?.memberRoles[world.self.id] ?? [] });
    }
    if (method === "GET" && route("guilds/:id/channels")) {
      const guild = this.guild(parts[1]!);
      return guild ? json(guild.channels) : notFound();
    }
    if (method === "GET" && route("guilds/:id/roles")) {
      const guild = this.guild(parts[1]!);
      return guild ? json(guild.roles) : notFound();
    }
    if (method === "GET" && route("guilds/:id/application-command-index")) {
      return json({ applications: [], application_commands: [], version: "0" });
    }
    if (method === "GET" && route("channels/:id")) {
      const found = this.findChannel(parts[1]!);
      return found ? json(found.channel) : notFound();
    }
    if (method === "GET" && route("channels/:id/messages/pins")) return this.pinsResponse(parts[1]!);
    if (method === "GET" && route("channels/:id/messages")) return this.messagesPage(parts[1]!, query);
    if (method === "GET" && route("channels/:id/messages/:mid")) {
      const message = this.messageById(parts[1]!, parts[3]!);
      return message ? json(message) : notFound();
    }
    if (method === "POST" && route("channels/:id/messages")) return this.createMessage(parts[1]!, body);
    if (method === "PATCH" && route("channels/:id/messages/:mid")) return this.editMessage(parts[1]!, parts[3]!, body);
    if (method === "DELETE" && route("channels/:id/messages/:mid")) return this.deleteMessage(parts[1]!, parts[3]!);
    if ((method === "PUT" || method === "DELETE") && route("channels/:id/messages/:mid/reactions/:emoji/@me")) {
      return this.react(parts[1]!, parts[3]!, parts[5]!, method === "PUT");
    }
    if (method === "POST" && (route("channels/:id/messages/:mid/ack") || route("read-states/ack-bulk"))) return json({ token: null });
    if (method === "POST" && route("channels/:id/typing")) return empty();
    if (method === "POST" && route("channels/:id/threads")) return this.createThread(parts[1]!, null, body);
    if (method === "POST" && route("channels/:id/messages/:mid/threads")) return this.createThread(parts[1]!, parts[3]!, body);

    if (method === "DELETE" && route("users/@me/guilds/:id")) return this.leaveGuild(parts[3]!);

    // Settings, mutes, membership, moderation: accept and do nothing.
    this.log(`UNHANDLED ${method} ${path}`);
    if (method === "GET") return notFound();
    return method === "PATCH" ? json({}) : empty();
  }

  private leaveGuild(guildId: string): Response {
    if (process.env.RECORD_DEMO_FAIL_LEAVE === "1") {
      return json({ message: "Missing Permissions. This demo server refuses Leave Server because RECORD_DEMO_FAIL_LEAVE=1 is set.", code: 50013 }, 400);
    }
    const index = this.world.guilds.findIndex((guild) => guild.id === guildId);
    if (index < 0) return notFound();
    this.world.guilds.splice(index, 1);
    setTimeout(() => this.dispatch("GUILD_DELETE", { id: guildId, unavailable: false }), 15);
    return empty();
  }

  private guild(id: string): DemoGuild | null {
    return this.world.guilds.find((guild) => guild.id === id) ?? null;
  }

  private messagesPage(channelId: string, query: URLSearchParams): Response {
    const history = this.history(channelId);
    if (!history) return notFound();
    const limit = Math.max(1, Math.min(100, Number(query.get("limit") ?? 50) || 50));
    const before = query.get("before");
    const after = query.get("after");
    const around = query.get("around");
    let page: DiscordMessageResponse[];
    if (before) {
      const end = lowerBound(history, before);
      page = history.slice(Math.max(0, end - limit), end);
    } else if (after) {
      const start = upperBound(history, after);
      page = history.slice(start, start + limit);
    } else if (around) {
      const center = lowerBound(history, around);
      const start = Math.max(0, center - Math.floor(limit / 2));
      page = history.slice(start, start + limit);
    } else {
      this.openChannelId = channelId;
      page = history.slice(-limit);
      this.scheduleUnfurls(channelId, page);
    }
    // Discord returns newest first.
    return json([...page].reverse());
  }

  private pinsResponse(channelId: string): Response {
    this.history(channelId);
    const pinned = [...(this.pins.get(channelId) ?? [])]
      .map((id) => this.messageById(channelId, id))
      .filter((message): message is DiscordMessageResponse => message !== null)
      .reverse();
    return json({ items: pinned.map((message) => ({ pinned_at: message.timestamp, message: { ...message, pinned: true } })), has_more: false });
  }

  private async createMessage(channelId: string, body: unknown): Promise<Response> {
    const history = this.history(channelId);
    if (!history) return notFound();
    const guild = this.guildForChannel(channelId);
    const { payload, files } = await parseMessageBody(body);
    const now = Math.max(Date.now(), snowflakeMs(history.at(-1)?.id) + 1);
    this.incomingCounter += 1;
    const id = snowflake(now, this.incomingCounter);
    const attachments = files.map((file, index) => {
      const attachmentId = snowflake(now, 2000 + index);
      this.uploads.set(attachmentId, { bytes: file.bytes, contentType: file.contentType });
      return {
        id: attachmentId,
        filename: file.name,
        content_type: file.contentType,
        size: file.bytes.length,
        url: `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/${encodeURIComponent(file.name)}`,
      };
    });
    const content = typeof payload.content === "string" ? payload.content : "";
    const reference = isRecord(payload.message_reference) && typeof payload.message_reference.message_id === "string"
      ? payload.message_reference.message_id
      : null;
    const replied = reference ? this.messageById(channelId, reference) : null;
    const message: DiscordMessageResponse = {
      id,
      channel_id: channelId,
      ...(guild ? { guild_id: guild.id } : {}),
      nonce: typeof payload.nonce === "string" || typeof payload.nonce === "number" ? payload.nonce : null,
      content,
      timestamp: new Date(now).toISOString(),
      edited_timestamp: null,
      type: replied ? 19 : 0,
      mentions: [],
      mention_roles: [],
      attachments,
      embeds: [],
      ...buildMessageAuthor(this.world, guild, this.world.self.id),
      ...(replied ? {
        message_reference: { type: 0, message_id: replied.id, channel_id: channelId, ...(guild ? { guild_id: guild.id } : {}) },
        referenced_message: { id: replied.id, content: replied.content, timestamp: replied.timestamp, author: replied.author, attachments: replied.attachments, embeds: replied.embeds },
      } : {}),
    };
    history.push(message);
    this.bumpLastMessage(channelId, id);
    // Like Discord: the REST response and the gateway echo both arrive.
    setTimeout(() => {
      this.dispatch("MESSAGE_CREATE", message);
      this.runChatCommand(channelId, content);
    }, 15);
    return json(message);
  }

  /**
   * Messages starting with `!demo` drive the fake server from Record's own prompt:
   * `!demo more [N]`, `!demo typing`, `!demo every SECONDS` (0 stops).
   */
  private runChatCommand(channelId: string, content: string): void {
    const match = /^!demo\s+(\w+)(?:\s+(\d+(?:\.\d+)?))?/i.exec(content.trim());
    if (!match) return;
    const command = match[1]!.toLowerCase();
    const value = match[2] ? Number(match[2]) : null;
    if (command === "more" || command === "incoming") {
      const count = Math.max(1, Math.min(500, value ?? 1));
      setTimeout(() => this.emitIncoming(count, channelId), 400);
    } else if (command === "typing") {
      this.emitTyping(channelId);
      setTimeout(() => this.emitIncoming(1, channelId), 2500);
    } else if (command === "every") {
      this.startIncomingTimer((value ?? 0) * 1000);
    } else if (command === "unfurl") {
      setTimeout(() => this.emitUnfurlingLink(channelId), 400);
    } else if (command === "suppress") {
      this.suppressNewestEmbeds(channelId);
    }
  }

  /** Like Discord unfurling a link: the embeds come as a partial MESSAGE_UPDATE. */
  private unfurl(channelId: string, messageId: string, embeds: DiscordEmbedResponse[]): void {
    const message = this.messageById(channelId, messageId);
    if (!message) return;
    message.embeds = embeds;
    const guild = this.guildForChannel(channelId);
    this.dispatch("MESSAGE_UPDATE", { id: message.id, channel_id: channelId, ...(guild ? { guild_id: guild.id } : {}), embeds });
  }

  private scheduleUnfurls(channelId: string, page: readonly DiscordMessageResponse[]): void {
    for (const message of page) {
      const embeds = this.lateEmbeds.get(message.id);
      if (!embeds) continue;
      this.lateEmbeds.delete(message.id);
      setTimeout(() => this.unfurl(channelId, message.id, embeds), DEMO_UNFURL_DELAY_MS).unref?.();
    }
  }

  /** `!demo unfurl`: someone posts a link; its preview arrives a moment later. */
  private emitUnfurlingLink(channelId: string): void {
    const history = this.history(channelId);
    if (!history) return;
    const guild = this.guildForChannel(channelId);
    const author = this.speakersFor(channelId)[0]!;
    this.incomingCounter += 1;
    const tag = `v2.${this.incomingCounter}`;
    const url = `https://github.com/example/record/releases/tag/${tag}`;
    const now = Math.max(Date.now(), snowflakeMs(history.at(-1)?.id) + 1);
    const message: DiscordMessageResponse = {
      id: snowflake(now, this.incomingCounter),
      channel_id: channelId,
      ...(guild ? { guild_id: guild.id } : {}),
      content: `new release ${url}`,
      timestamp: new Date(now).toISOString(),
      edited_timestamp: null,
      type: 0,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: [],
      ...buildMessageAuthor(this.world, guild, author.id),
    };
    history.push(message);
    this.bumpLastMessage(channelId, message.id);
    this.dispatch("MESSAGE_CREATE", message);
    setTimeout(() => this.unfurl(channelId, message.id, [demoReleaseEmbed(url, tag)]), DEMO_UNFURL_DELAY_MS).unref?.();
  }

  /** `!demo suppress`: the newest message with embeds loses them (flag 4), as when its author removes the preview. */
  private suppressNewestEmbeds(channelId: string): void {
    const history = this.history(channelId);
    const message = history?.findLast((entry) => (entry.embeds?.length ?? 0) > 0 && !entry.content.startsWith("!demo"));
    if (!message) return;
    message.flags = (message.flags ?? 0) | 4;
    message.embeds = [];
    setTimeout(() => this.dispatch("MESSAGE_UPDATE", message), 15);
  }

  private async editMessage(channelId: string, messageId: string, body: unknown): Promise<Response> {
    const message = this.messageById(channelId, messageId);
    if (!message) return notFound();
    const { payload } = await parseMessageBody(body);
    if (typeof payload.content === "string") message.content = payload.content;
    message.edited_timestamp = new Date().toISOString();
    setTimeout(() => this.dispatch("MESSAGE_UPDATE", message), 15);
    return json(message);
  }

  private deleteMessage(channelId: string, messageId: string): Response {
    const history = this.history(channelId);
    const index = history?.findIndex((message) => message.id === messageId) ?? -1;
    if (!history || index < 0) return notFound();
    history.splice(index, 1);
    const guild = this.guildForChannel(channelId);
    setTimeout(() => this.dispatch("MESSAGE_DELETE", { id: messageId, channel_id: channelId, ...(guild ? { guild_id: guild.id } : {}) }), 15);
    return empty();
  }

  private react(channelId: string, messageId: string, identifier: string, add: boolean): Response {
    const message = this.messageById(channelId, messageId);
    if (!message) return notFound();
    const [name, id] = identifier.includes(":") ? identifier.split(":") as [string, string] : [identifier, null];
    const reactions = message.reactions ?? (message.reactions = []);
    const matches = (reaction: NonNullable<DiscordMessageResponse["reactions"]>[number]): boolean =>
      id ? reaction.emoji?.id === id : !reaction.emoji?.id && reaction.emoji?.name === name;
    let reaction = reactions.find(matches);
    if (add && !reaction?.me) {
      if (!reaction) reactions.push(reaction = { count: 0, me: false, emoji: { id, name } });
      reaction.count = (reaction.count ?? 0) + 1;
      reaction.me = true;
    } else if (!add && reaction?.me) {
      reaction.count = Math.max(0, (reaction.count ?? 1) - 1);
      reaction.me = false;
      if (reaction.count === 0) message.reactions = reactions.filter((candidate) => candidate !== reaction);
    }
    const guild = this.guildForChannel(channelId);
    setTimeout(() => this.dispatch(add ? "MESSAGE_REACTION_ADD" : "MESSAGE_REACTION_REMOVE", {
      user_id: this.world.self.id,
      channel_id: channelId,
      message_id: messageId,
      ...(guild ? { guild_id: guild.id } : {}),
      emoji: { id, name },
    }), 15);
    return empty();
  }

  private async createThread(channelId: string, messageId: string | null, body: unknown): Promise<Response> {
    const found = this.findChannel(channelId);
    if (!found?.guild) return notFound();
    const { payload } = await parseMessageBody(body);
    const now = Date.now();
    const thread: DiscordChannelResponse = {
      id: messageId ?? snowflake(now, 3000),
      guild_id: found.guild.id,
      parent_id: channelId,
      name: typeof payload.name === "string" && payload.name ? payload.name : "new thread",
      type: 11,
      owner_id: this.world.self.id,
      last_message_id: null,
      message_count: 0,
      member_count: 1,
      thread_metadata: { archived: false, locked: false, auto_archive_duration: 4320, create_timestamp: new Date(now).toISOString() },
      member: { join_timestamp: new Date(now).toISOString(), flags: 1, muted: false },
    };
    found.guild.threads.push(thread);
    setTimeout(() => this.dispatch("THREAD_CREATE", thread), 15);
    return json(thread);
  }

  // -------------------------------------------------------------------------
  // CDN

  private cdn(url: URL): Response {
    const cached = this.cdnCache.get(url.pathname);
    if (cached) return png(cached);
    const parts = url.pathname.split("/").filter(Boolean);
    const world = this.world;
    const stem = (parts.at(-1) ?? "").replace(/\.[a-z0-9]+$/i, "");
    let bytes: Buffer | null = null;
    if (parts[0] === "icons" && parts.length === 3) {
      const guild = this.guild(parts[1]!);
      if (guild?.icon && guild.icon === stem) bytes = renderIcon(guild.initials, guild.color);
    } else if ((parts[0] === "avatars" && parts.length === 3) || (parts[0] === "guilds" && parts[2] === "users")) {
      const user = world.users.get(parts[0] === "avatars" ? parts[1]! : parts[3]!);
      if (user?.avatar) bytes = renderIcon(user.initials, user.color, 128, true);
    } else if (DEMO_MEDIA_PROXY_HOSTS.includes(url.hostname)) {
      // Embed pictures (and video posters, `format=jpeg`) through the media proxy.
      const variant = demoMediaVariant(url.pathname);
      if (variant !== null) return png(this.variantPng(variant));
    } else if (parts[0] === "embed" && parts[1] === "avatars") {
      const index = Number(stem) || 0;
      bytes = renderIcon("", hexColor([0x5865f2, 0x757e8a, 0x3ba55c, 0xfaa61a, 0xed4245, 0xeb459e][index % 6]!), 128, true);
    } else if (parts[0] === "emojis" && parts.length === 2) {
      const emoji = world.emojisById.get(stem);
      if (emoji) bytes = renderIcon(emoji.name.slice(0, 2), emoji.color, 64, true);
    } else if (parts[0] === "stickers" && parts.length === 2) {
      bytes = renderIcon("HI", hexColor(0xfee75c), 160, true);
    } else if (parts[0] === "attachments" && parts.length === 4) {
      const upload = this.uploads.get(parts[2]!);
      if (upload) return new Response(upload.bytes as unknown as BodyInit, { headers: { "content-type": upload.contentType, "content-length": String(upload.bytes.length) } });
      const variant = this.imageVariantByAttachment.get(parts[2]!);
      if (variant !== undefined) return png(this.variantPng(variant));
      // Non-image demo files: a small text body.
      const text = Buffer.from(`Record demo file ${parts[3]}\n`);
      return new Response(text as unknown as BodyInit, { headers: { "content-type": "application/octet-stream", "content-length": String(text.length) } });
    }
    if (!bytes) return new Response("not found", { status: 404 });
    this.cdnCache.set(url.pathname, bytes);
    return png(bytes);
  }

  // -------------------------------------------------------------------------
  // Gateway

  attach(socket: FakeGatewaySocket): void {
    this.sockets.add(socket);
  }

  detach(socket: FakeGatewaySocket): void {
    this.sockets.delete(socket);
  }

  /** Broadcast a dispatch event to every identified gateway connection. */
  dispatch(type: string, data: unknown): void {
    for (const socket of this.sockets) {
      if (socket.identified) socket.deliver({ op: 0, t: type, s: this.sequence += 1, d: data });
    }
  }

  handleClientPayload(socket: FakeGatewaySocket, payload: { op?: number; d?: any }): void {
    this.log(`GATEWAY op ${payload.op}${payload.op === 8 ? ` guild ${payload.d?.guild_id} users ${payload.d?.user_ids?.length ?? 0}` : ""}`);
    switch (payload.op) {
      case 1:
        socket.deliver({ op: 11 });
        return;
      case 2:
        if (payload.d?.token !== DEMO_TOKEN) {
          socket.serverClose(4004, "Authentication failed.");
          return;
        }
        socket.identified = true;
        socket.deliver({ op: 0, t: "READY", s: this.sequence += 1, d: this.readyPayload() });
        return;
      case 6:
        socket.identified = true;
        socket.deliver({ op: 0, t: "RESUMED", s: this.sequence += 1, d: {} });
        return;
      case 8:
        this.answerMemberRequest(socket, payload.d);
        return;
      case 37:
        this.answerSubscriptions(socket, payload.d);
        return;
      default:
        // Presence (3), voice state (4) and the rest have no demo side effects.
        return;
    }
  }

  private readyPayload(): unknown {
    const world = this.world;
    const readStates: Array<Record<string, unknown>> = [];
    for (const guild of world.guilds) {
      for (const channel of [...guild.channels, ...guild.threads]) {
        if (!channel.last_message_id) continue;
        readStates.push({ id: channel.id, last_message_id: channel.last_message_id, mention_count: world.mentionCounts.get(channel.id) ?? 0 });
      }
    }
    for (const channel of world.directMessages) {
      const unread = world.unreadDirectMessages.has(channel.id);
      readStates.push({ id: channel.id, last_message_id: unread ? snowflake(world.anchorMs - 30 * 86_400_000) : channel.last_message_id, mention_count: unread ? 1 : 0 });
    }
    return {
      v: 9,
      session_id: "demo-session",
      resume_gateway_url: DEMO_GATEWAY_URL,
      user: { id: world.self.id, username: world.self.username, global_name: world.self.globalName, avatar: world.self.avatar, discriminator: "0", premium_type: 2 },
      guilds: world.guilds.map((guild) => ({
        id: guild.id,
        properties: { id: guild.id, name: guild.name, icon: guild.icon, owner_id: guild.ownerId },
        emojis: guild.emojis.map((emoji) => ({ id: emoji.id, name: emoji.name, animated: emoji.animated, roles: [], available: true })),
        roles: guild.roles,
        channels: guild.channels,
        threads: guild.threads,
        member_count: guild.memberIds.length,
        voice_states: guild.voiceStates.map((state) => this.voiceStatePayload(guild, state)),
      })),
      merged_members: world.guilds.map((guild) => [{ user_id: world.self.id, roles: guild.memberRoles[world.self.id] ?? [] }]),
      private_channels: world.directMessages,
      read_state: { entries: readStates },
      user_guild_settings: {
        entries: world.guilds.filter((guild) => guild.muted).map((guild) => ({ guild_id: guild.id, muted: true, channel_overrides: [] })),
      },
    };
  }

  private voiceStatePayload(guild: DemoGuild, state: DemoGuild["voiceStates"][number]): unknown {
    const user = this.world.users.get(state.userId)!;
    return {
      user_id: user.id,
      channel_id: state.channelId,
      guild_id: guild.id,
      session_id: `demo-${user.id}`,
      self_mute: state.selfMute,
      self_deaf: state.selfDeaf,
      mute: false,
      deaf: false,
      member: { user: this.userPayload(user), roles: guild.memberRoles[user.id] ?? [] },
    };
  }

  private userPayload(user: DemoUser): Record<string, unknown> {
    return { id: user.id, username: user.username, global_name: user.globalName, avatar: user.avatar, ...(user.bot ? { bot: true } : {}) };
  }

  private answerMemberRequest(socket: FakeGatewaySocket, data: any): void {
    const guildIds: string[] = Array.isArray(data?.guild_id) ? data.guild_id : [data?.guild_id];
    const userIds: string[] = Array.isArray(data?.user_ids) ? data.user_ids : [];
    for (const guildId of guildIds) {
      const guild = this.guild(guildId);
      if (!guild) continue;
      const members = (userIds.length > 0 ? userIds : guild.memberIds.slice(0, 100))
        .filter((id) => guild.memberIds.includes(id))
        .map((id) => ({ user: this.userPayload(this.world.users.get(id)!), roles: guild.memberRoles[id] ?? [], nick: null }));
      socket.deliver({ op: 0, t: "GUILD_MEMBERS_CHUNK", s: this.sequence += 1, d: { guild_id: guild.id, members, chunk_index: 0, chunk_count: 1 } });
    }
  }

  private answerSubscriptions(socket: FakeGatewaySocket, data: any): void {
    const subscriptions = isRecord(data?.subscriptions) ? data.subscriptions : {};
    for (const [guildId, subscription] of Object.entries(subscriptions)) {
      const channels = isRecord(subscription) && isRecord(subscription.channels) ? Object.keys(subscription.channels) : [];
      const guild = this.guild(guildId);
      if (!guild || channels.length === 0) continue;
      this.openChannelId = channels[0]!;
      socket.deliver({ op: 0, t: "GUILD_MEMBER_LIST_UPDATE", s: this.sequence += 1, d: this.memberList(guild) });
    }
  }

  private memberList(guild: DemoGuild): unknown {
    const world = this.world;
    const hoisted = guild.roles.filter((role) => role.hoist).sort((a, b) => b.position - a.position);
    const items: unknown[] = [];
    const groups: Array<{ id: string; count: number }> = [];
    const placed = new Set<string>();
    const memberItem = (user: DemoUser): unknown => ({
      member: {
        user: this.userPayload(user),
        roles: guild.memberRoles[user.id] ?? [],
        nick: null,
        presence: { status: user.status === "offline" ? "offline" : user.status, user: { id: user.id } },
      },
    });
    const members = guild.memberIds.map((id) => world.users.get(id)!).sort((a, b) => a.globalName.localeCompare(b.globalName));
    for (const role of hoisted) {
      const inRole = members.filter((user) => user.status !== "offline" && !placed.has(user.id) && (guild.memberRoles[user.id] ?? []).includes(role.id));
      if (inRole.length === 0) continue;
      groups.push({ id: role.id, count: inRole.length });
      items.push({ group: { id: role.id, count: inRole.length } });
      for (const user of inRole) {
        placed.add(user.id);
        items.push(memberItem(user));
      }
    }
    for (const groupId of ["online", "offline"] as const) {
      const rest = members.filter((user) => !placed.has(user.id) && (groupId === "offline") === (user.status === "offline"));
      if (rest.length === 0) continue;
      groups.push({ id: groupId, count: rest.length });
      items.push({ group: { id: groupId, count: rest.length } });
      for (const user of rest) {
        placed.add(user.id);
        items.push(memberItem(user));
      }
    }
    return {
      guild_id: guild.id,
      id: "everyone",
      member_count: members.length,
      online_count: members.filter((user) => user.status !== "offline").length,
      groups,
      ops: [{ op: "SYNC", range: [0, 99], items: items.slice(0, 100) }],
    };
  }

  private log(line: string): void {
    if (!this.logPath) return;
    try {
      appendFileSync(this.logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Logging is best effort.
    }
  }
}

// ---------------------------------------------------------------------------
// Fake WebSocket

type GatewayPayload = { op: number; t?: string; s?: number; d?: unknown };

export interface FakeGatewaySocket extends EventTarget {
  identified: boolean;
  readonly readyState: number;
  deliver(payload: GatewayPayload): void;
  serverClose(code: number, reason: string): void;
  close(code?: number, reason?: string): void;
}

function makeWebSocketClass(server: DemoDiscordServer) {
  return class DemoWebSocket extends EventTarget implements FakeGatewaySocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly url: string;
    readonly protocol = "";
    readonly extensions = "";
    binaryType: "arraybuffer" | "blob" | "nodebuffer" = "nodebuffer";
    bufferedAmount = 0;
    identified = false;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private state = 0;

    constructor(url: string | URL, _protocols?: unknown) {
      super();
      this.url = String(url);
      const parsed = new URL(this.url);
      if (`${parsed.protocol}//${parsed.host}` !== DEMO_GATEWAY_URL) {
        // Voice/stream media servers and anything else: fail without connecting.
        setTimeout(() => {
          this.emit("error", new Event("error"));
          this.serverClose(1006, "Network access is disabled in Record demo mode.");
        }, 0);
        return;
      }
      server.attach(this);
      setTimeout(() => {
        if (this.state !== 0) return;
        this.state = 1;
        this.emit("open", new Event("open"));
        this.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
      }, 5);
    }

    get readyState(): number {
      return this.state;
    }

    send(data: string | ArrayBufferLike | ArrayBufferView): void {
      if (this.state !== 1) return;
      const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
      let payload: { op?: number; d?: unknown };
      try {
        payload = JSON.parse(text);
      } catch {
        return;
      }
      queueMicrotask(() => server.handleClientPayload(this, payload as { op?: number; d?: any }));
    }

    deliver(payload: GatewayPayload): void {
      if (this.state !== 1) return;
      const data = JSON.stringify(payload);
      setTimeout(() => {
        if (this.state === 1) this.emit("message", new MessageEvent("message", { data }));
      }, 0);
    }

    serverClose(code: number, reason: string): void {
      if (this.state === 3) return;
      this.state = 3;
      server.detach(this);
      const event = new Event("close") as Event & { code: number; reason: string; wasClean: boolean };
      Object.assign(event, { code, reason, wasClean: code === 1000 });
      this.emit("close", event);
    }

    close(code = 1000, reason = ""): void {
      if (this.state === 2 || this.state === 3) return;
      this.state = 2;
      setTimeout(() => this.serverClose(code, reason), 0);
    }

    ping(): void {}
    pong(): void {}
    terminate(): void {
      this.serverClose(1006, "terminated");
    }

    private emit(type: "open" | "message" | "close" | "error", event: Event): void {
      const handler = this[`on${type}` as const] as ((event: Event) => void) | null;
      handler?.call(this, event);
      this.dispatchEvent(event);
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers

function matchRoute(pattern: string, parts: string[]): boolean {
  const expected = pattern.split("/");
  if (expected.length !== parts.length) return false;
  return expected.every((segment, index) => segment.startsWith(":") || segment === parts[index]);
}

function lowerBound(history: DiscordMessageResponse[], id: string): number {
  const target = BigInt(id);
  let lo = 0;
  let hi = history.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (BigInt(history[mid]!.id) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(history: DiscordMessageResponse[], id: string): number {
  const target = BigInt(id);
  let lo = 0;
  let hi = history.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (BigInt(history[mid]!.id) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function snowflakeMs(id: string | undefined): number {
  return id ? Number((BigInt(id) >> 22n) + 1420070400000n) : 0;
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

interface ParsedFile {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

async function parseMessageBody(body: unknown): Promise<{ payload: Record<string, any>; files: ParsedFile[] }> {
  if (body instanceof FormData) {
    const json = body.get("payload_json");
    const payload = typeof json === "string" ? safeJson(json) : {};
    const files: ParsedFile[] = [];
    for (const [key, value] of body.entries()) {
      if (!key.startsWith("files[") || typeof value === "string") continue;
      const file = value as unknown as File;
      files.push({ name: file.name || "upload.bin", contentType: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    return { payload, files };
  }
  if (typeof body === "string") return { payload: safeJson(body), files: [] };
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return { payload: safeJson(new TextDecoder().decode(body as ArrayBuffer)), files: [] };
  }
  return { payload: {}, files: [] };
}

function safeJson(text: string): Record<string, any> {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validJsonBody(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function empty(): Response {
  return new Response(null, { status: 204 });
}

function notFound(): Response {
  return json({ message: "Unknown Resource", code: 10003 }, 404);
}

function png(bytes: Buffer): Response {
  return new Response(bytes as unknown as BodyInit, { headers: { "content-type": "image/png", "content-length": String(bytes.length) } });
}

function delay(ms: number, signal: AbortSignal | null): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    }, { once: true });
  });
}
