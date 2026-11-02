/**
 * `--fixtures` for the Discord bridge: record's own made-up Discord
 * (src/demo: fifteen servers, DMs and group DMs, long histories with
 * pictures, embeds, reactions and threads, all from fixed seeds) answers
 * the provider's REST requests, CDN downloads and gateway in-process, so
 * the same provider code runs with no account and no network at all: the
 * demo server refuses every request that is not to Discord's hosts. Its
 * clock is fixed (2026-10-24 21:00 UTC, or DISCORD_FIXTURES_NOW), so every
 * run, screenshot and benchmark sees the same world.
 *
 * Live messages for testing: `discord.fixtures.emit` (a message from
 * someone else, optionally mentioning the user) and, with
 * DISCORD_FIXTURES_INCOMING_SECONDS=N, one in the last opened channel every
 * N seconds.
 */

import type { DiscordMessageResponse } from "../../../discord";
import { buildMessageAuthor, DEMO_TOKEN, snowflake } from "../../../demo/data";
import { DemoDiscordServer } from "../../../demo/server";

export interface Fixtures {
  server: DemoDiscordServer;
  token: string;
  /** A message from someone else in `channelId` (DM or channel), now. */
  emit(channelId: string, text: string, options?: { mention?: boolean; authorId?: string }): string | null;
}

let installed: Fixtures | null = null;

export function installFixtures(): Fixtures {
  if (installed) return installed;
  const anchor = Number(process.env.DISCORD_FIXTURES_NOW);
  const server = new DemoDiscordServer({
    anchorMs: Number.isFinite(anchor) && anchor > 0 ? anchor : undefined,
    latencyMs: 15,
    olderPageDelayMs: 120,
    logPath: null,
  });
  // record's heartbeat is op 40; the demo answers op 1 only. Ack it here, as Discord does.
  const Base = server.WebSocket;
  class FixtureSocket extends Base {
    override send(data: string | ArrayBufferLike | ArrayBufferView): void {
      if (typeof data === "string" && data.startsWith("{\"op\":40")) {
        setTimeout(() => this.deliver({ op: 11 }), 0);
        return;
      }
      super.send(data);
    }
  }
  globalThis.fetch = server.fetch;
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  const seconds = Number(process.env.DISCORD_FIXTURES_INCOMING_SECONDS);
  if (Number.isFinite(seconds) && seconds > 0) server.startIncomingTimer(seconds * 1000);

  let counter = 0;
  installed = {
    server,
    token: DEMO_TOKEN,
    emit(channelId, text, options = {}) {
      const found = server.findChannel(channelId);
      const history = server.history(channelId);
      if (!found || !history) return null;
      const world = server.world;
      const candidates = found.guild
        ? found.guild.memberIds.filter((id) => id !== world.self.id && !world.users.get(id)?.bot)
        : (found.channel.recipients ?? []).map((recipient) => recipient.id);
      const authorId = options.authorId ?? candidates[counter % Math.max(1, candidates.length)] ?? world.self.id;
      counter += 1;
      const last = history.at(-1)?.id;
      const now = Math.max(Date.now(), last ? Number((BigInt(last) >> 22n) + 1_420_070_400_000n) + 1 : 0);
      const self = world.self;
      const message: DiscordMessageResponse = {
        id: snowflake(now, 2000 + counter),
        channel_id: channelId,
        ...(found.guild ? { guild_id: found.guild.id } : {}),
        content: options.mention ? `<@${self.id}> ${text}` : text,
        timestamp: new Date(now).toISOString(),
        edited_timestamp: null,
        type: 0,
        mention_everyone: false,
        mention_roles: [],
        mentions: options.mention ? [{ id: self.id, username: self.username, global_name: self.globalName, avatar: self.avatar }] : [],
        attachments: [],
        embeds: [],
        ...buildMessageAuthor(world, found.guild, authorId),
      };
      history.push(message);
      found.channel.last_message_id = message.id;
      server.dispatch("MESSAGE_CREATE", message);
      return message.id;
    },
  };
  return installed;
}
