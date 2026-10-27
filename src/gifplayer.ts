/**
 * GIFs that play by themselves in chat, through st's video (videoprotocol.ts).
 *
 * The GIFs in view are offered every frame; the most visible play (looping,
 * silent) as long as their streams fit one byte budget for all GIFs, the
 * rest keep their still first frame. One that leaves the view is paused,
 * kept open, and closed only when its slot is wanted.
 *
 * Interaction comes first: a write to the terminal blocks Record until the
 * terminal has taken it, and a key's frame waits behind every GIF byte
 * written before it. So while keys, clicks, the wheel or a glide are going
 * (and a moment after), no GIF bytes are written and no GIF opens or closes;
 * the two seconds already buffered in st keep them playing.
 *
 * Otherwise packets go out within the budget and paced by the terminal's
 * acknowledgements (st docs/video.md, flow control): a status query every
 * 32 KiB, no more than a window of bytes past the newest answered one, and
 * no more than two seconds of media ahead of what is playing. A loop is the
 * same packets again with later timestamps: playback never stops to
 * rebuffer.
 */

import {
  isPrimaryDeviceAttributes, parseVideoReply, VIDEO_QUERY_ID, videoCapabilityQuery, videoClose, videoOpen, videoPacket, videoQuery, videoSet,
  type VideoReply,
} from "./videoprotocol";
import type { VideoStream } from "./videostream";

export interface GifCandidate {
  /** The picture it animates (attachment id). */
  key: string;
  /** How much of it is in view (rows); 0 or less: not in view. */
  visibility: number;
  /** Display size: its still's pixels, so the still's crops apply. */
  width: number;
  height: number;
  /** Its stream (from the disk cache, or encoded), null if it can't play. */
  load: () => Promise<VideoStream | null>;
}

export interface GifPlayerOptions {
  write: (data: string) => void;
  /** A GIF began or stopped showing frames: draw again (placements change). */
  onChange: () => void;
  /** The terminal answered whether it plays st video. */
  onSupportChanged?: (supported: boolean) => void;
  now?: () => number;
  /** At most this many open (st has four; one is left for the viewer). */
  maxOpen?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** Tests drive pump() themselves. */
  autoPump?: boolean;
  /** Bytes written that the terminal has not read yet (terminaloutput.ts). */
  backlog?: () => number;
}

/** First video image id; videos take ids apart from pictures (0x40000000..) and icons. */
const VIDEO_ID_BASE = 0x74000000;
const VIDEO_ID_SPAN = 0x00ffffff;
const AHEAD_US = 2_000_000;
/**
 * Bytes written and not yet acknowledged, all GIFs together: 16 KiB plus
 * 300 ms at the rate acknowledgements come back (st docs/video.md: a round
 * trip and a little at the delivery rate), so on a slow link keys and frames
 * wait behind a fraction of a second of GIF at most.
 */
const WINDOW_MIN_BYTES = 16 * 1024;
const WINDOW_RATE_SECONDS = 0.3;
const RATE_SPAN_MS = 3000;
/**
 * Terminal bytes per second for all GIFs together (base64 and framing
 * included), and the most saved up for a burst. A transcoded GIF takes at
 * most about 10 KB/s (videostream.ts), so three fit.
 */
export const GIF_BUDGET_BYTES_PER_SEC = 32 * 1024;
const GIF_BURST_BYTES = 32 * 1024;
/** After the last key, click, wheel step or glide frame, GIF bytes wait this long. */
export const GIF_QUIET_AFTER_INTERACTION_MS = 300;
/** And opening a GIF (or closing one to make room) waits until the user has been still this long. */
export const GIF_OPEN_AFTER_STILL_MS = 600;
/**
 * No GIF bytes are added while the terminal has more than this left to read
 * (an image going through, frames): they would only queue ahead of the next
 * frame.
 */
export const GIF_BACKLOG_LIMIT_BYTES = 16 * 1024;
const QUERY_EVERY_BYTES = 32 * 1024;
const QUERY_EVERY_MS = 250;
const MAX_OUTSTANDING_QUERIES = 4;
const PUMP_MS = 40;
/** A paused GIF out of view this long is closed even if no other wants its slot. */
const CLOSE_PAUSED_AFTER_MS = 120_000;
const STATS_EVERY_MS = 5_000;
/** An unanswered status query is given up after this long (its reply was lost). */
const QUERY_GIVE_UP_MS = 5_000;
/** A GIF refused a slot (another program's video holds it) is tried again after this long. */
const RETRY_NO_SLOT_MS = 30_000;

interface Session {
  key: string;
  id: number;
  width: number;
  height: number;
  stream: VideoStream | null;
  /** closing: its still is placed back this frame; the close goes out with the next update. */
  phase: "loading" | "open" | "closing" | "closed";
  paused: boolean;
  /** Next packet and loop to send. */
  index: number;
  loop: number;
  /** Presentation time st reported playing (-1 before the first frame). */
  pos: number;
  /** Frames st has shown since opening: once any, the video replaces the still. */
  shown: number;
  bytesWritten: number;
  bytesAcked: number;
  queries: { seq: number; bytes: number; at: number }[];
  lastQueryAt: number;
  bytesAtLastQuery: number;
  lastVisibleAt: number;
  openedAt: number;
  /** Terminal bytes per second it takes while playing (its packets as APCs, a loop over its length). */
  bytesPerSec: number;
}

/** What a stream costs on the terminal per second: packets as base64 APCs. */
export function gifBytesPerSecond(stream: Pick<VideoStream, "packets" | "durationUs">): number {
  const bytes = stream.packets.reduce((sum, packet) => sum + Math.ceil((packet.data.length + 10) / 3) * 4 + 32, 0);
  return stream.durationUs > 0 ? (bytes * 1_000_000) / stream.durationUs : bytes;
}

/** Before its stream is known, a GIF is taken to cost what a transcoded one does. */
const ASSUMED_GIF_BYTES_PER_SEC = 10 * 1024;
/** Costs remembered for this many GIFs (beyond their sessions). */
const REMEMBERED_COSTS = 512;

export class GifPlayer {
  private supported: boolean | null = null;
  private detecting = false;
  private readonly sessions = new Map<string, Session>();
  /** GIFs that failed to load or play keep their still (until a time, for a slot st refused). */
  private readonly failed = new Map<string, number>();
  private readonly byId = new Map<number, Session>();
  private nextId = 0;
  private nextSeq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly maxOpen: number;
  private statsBytes = 0;
  private statsSince = 0;
  private statsHeldMs = 0;
  private statsOpens = 0;
  /** No GIF bytes until then (the user is scrolling or typing). */
  private quietUntil = -Infinity;
  /** No GIF opens or closes until then. */
  private stillUntil = -Infinity;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The GIFs the last frame drew, offered again when a quiet spell ends. */
  private lastCandidates: readonly GifCandidate[] = [];
  /**
   * What each GIF really costs, once its stream was loaded, kept after it
   * closes: forgotten, a closed GIF would look cheap again, be opened in place
   * of one that does fit, and the two would swap every frame.
   */
  private readonly costs = new Map<string, number>();
  /** The byte budget's bucket. */
  private tokens = GIF_BURST_BYTES;
  private tokensAt: number;
  private lastPumpAt: number | null = null;
  /** Acknowledged bytes over time (all GIFs), for the delivery rate. */
  private acked: { at: number; bytes: number }[] = [];
  private ackedTotal = 0;

  constructor(private readonly options: GifPlayerOptions) {
    this.now = options.now ?? (() => performance.now());
    this.maxOpen = options.maxOpen ?? 3;
    this.statsSince = this.now();
    this.tokensAt = this.statsSince;
  }

  /**
   * A key, click, wheel step or glide frame: hold GIF bytes, opens and
   * closes until the user has been still for a moment.
   */
  noteInteraction(): void {
    const now = this.now();
    const settling = now < this.stillUntil;
    this.quietUntil = now + GIF_QUIET_AFTER_INTERACTION_MS;
    this.stillUntil = now + GIF_OPEN_AFTER_STILL_MS;
    if (settling || this.options.autoPump === false) return;
    // When the user has been still a while, start what the last frame showed (without drawing again).
    const settle = () => {
      this.settleTimer = null;
      const left = this.stillUntil - this.now();
      if (left > 0) {
        this.settleTimer = setTimeout(settle, left);
        this.settleTimer.unref?.();
        return;
      }
      this.update(this.lastCandidates);
    };
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(settle, GIF_OPEN_AFTER_STILL_MS);
    this.settleTimer.unref?.();
  }

  private quiet(now: number): boolean {
    return now < this.quietUntil;
  }

  /** Ask whether the terminal plays st video (its answer, or DA1 without one, decides). */
  detect(): void {
    this.detecting = true;
    this.options.write(videoCapabilityQuery());
  }

  /** The terminal plays st video (null: not known yet). Without it every GIF keeps its still. */
  setSupported(supported: boolean | null): void {
    if (this.supported === supported) return;
    this.supported = supported;
    if (!supported) this.closeAll();
  }

  isSupported(): boolean {
    return this.supported === true;
  }

  /** The video image to place instead of this picture's still, once st shows its frames. */
  videoImageId(key: string): number | null {
    const session = this.sessions.get(key);
    return session && session.phase === "open" && session.shown > 0 ? session.id : null;
  }

  /** Every video image id now open (placements of these are never sent as image data). */
  openVideoIds(): Set<number> {
    return new Set([...this.sessions.values()].filter((session) => session.phase === "open").map((session) => session.id));
  }

  /** The GIFs in view this frame (others pause). */
  update(candidates: readonly GifCandidate[]): void {
    this.lastCandidates = candidates;
    if (!this.supported) return;
    const now = this.now();
    const quiet = now < this.stillUntil;
    // Their stills were placed back by the frame just drawn: close them now.
    for (const session of [...this.sessions.values()]) {
      if (session.phase === "closing") this.close(session, true);
    }
    const inView = candidates.filter((candidate) => candidate.visibility > 0 && !((this.failed.get(candidate.key) ?? -Infinity) > now));
    // Most in view first; on a tie, the one already playing keeps playing.
    inView.sort((left, right) => right.visibility - left.visibility
      || Number(this.isPlaying(right.key)) - Number(this.isPlaying(left.key)));
    // As many as the slots and the byte budget take (at least one).
    const wanted: GifCandidate[] = [];
    let cost = 0;
    for (const candidate of inView) {
      if (wanted.length >= this.maxOpen) break;
      const rate = this.costs.get(candidate.key) ?? ASSUMED_GIF_BYTES_PER_SEC;
      if (wanted.length > 0 && cost + rate > GIF_BUDGET_BYTES_PER_SEC) continue;
      wanted.push(candidate);
      cost += rate;
    }
    const wantedKeys = new Set(wanted.map((candidate) => candidate.key));
    for (const session of this.sessions.values()) {
      if (inView.some((candidate) => candidate.key === session.key)) session.lastVisibleAt = now;
      if (!wantedKeys.has(session.key) && session.phase === "open" && !session.paused) this.pause(session);
      if (!quiet && session.phase === "open" && session.paused && now - session.lastVisibleAt > CLOSE_PAUSED_AFTER_MS) this.close(session);
    }
    for (const candidate of wanted) {
      const session = this.sessions.get(candidate.key);
      if (session) {
        if (session.phase === "open" && session.paused) this.resume(session);
        continue;
      }
      // Opening (and making room) waits until the user is still.
      if (quiet) continue;
      if (!this.makeRoom(wantedKeys)) break;
      this.start(candidate, now);
    }
    this.armPump();
  }

  /** A reply to one of our `a=v` commands: consumed (true) or not ours. */
  handleControlSequence(sequence: string): boolean {
    if (isPrimaryDeviceAttributes(sequence)) {
      // DA1 after the query: no answer to it by now means no video.
      if (this.detecting) {
        this.detecting = false;
        this.setSupported(false);
        this.options.onSupportChanged?.(false);
      }
      return true;
    }
    const reply = parseVideoReply(sequence);
    if (!reply) return false;
    if (reply.id === VIDEO_QUERY_ID) {
      this.detecting = false;
      const supported = reply.ok && (reply.fields.video ?? "").split(",").includes("h264");
      this.setSupported(supported);
      this.options.onSupportChanged?.(supported);
      return true;
    }
    const session = this.byId.get(reply.id);
    if (!session) return reply.id >= VIDEO_ID_BASE && reply.id <= VIDEO_ID_BASE + VIDEO_ID_SPAN;
    this.handleReply(session, reply);
    return true;
  }

  /** Close every video (Record is quitting): the commands to write. */
  dispose(): string {
    const out = [...this.sessions.values()].filter((session) => session.phase === "open" || session.phase === "closing").map((session) => videoClose(session.id)).join("");
    this.sessions.clear();
    this.byId.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    return out;
  }

  private isPlaying(key: string): boolean {
    const session = this.sessions.get(key);
    return !!session && session.phase === "open" && !session.paused;
  }

  /** A free slot, closing the paused GIF least recently in view if need be. */
  private makeRoom(wanted: ReadonlySet<string>): boolean {
    const open = [...this.sessions.values()].filter((session) => session.phase !== "closed");
    if (open.length < this.maxOpen) return true;
    // One is giving its slot back after this frame: wait for it.
    if (open.some((session) => session.phase === "closing")) return false;
    const victim = open.filter((session) => !wanted.has(session.key))
      .sort((left, right) => left.lastVisibleAt - right.lastVisibleAt)[0];
    if (!victim) return false;
    this.close(victim);
    return true;
  }

  private start(candidate: GifCandidate, now: number): void {
    const id = VIDEO_ID_BASE + (this.nextId++ % VIDEO_ID_SPAN);
    const session: Session = {
      key: candidate.key, id, width: candidate.width, height: candidate.height, stream: null,
      phase: "loading", paused: false, index: 0, loop: 0, pos: -1, shown: 0,
      bytesWritten: 0, bytesAcked: 0, queries: [], lastQueryAt: now, bytesAtLastQuery: 0,
      lastVisibleAt: now, openedAt: now, bytesPerSec: ASSUMED_GIF_BYTES_PER_SEC,
    };
    this.sessions.set(candidate.key, session);
    this.byId.set(id, session);
    candidate.load().then((stream) => {
      if (this.sessions.get(candidate.key) !== session || session.phase !== "loading") return;
      if (!stream || !this.supported) {
        this.fail(session, stream ? "unsupported" : "no stream");
        return;
      }
      session.stream = stream;
      session.phase = "open";
      session.openedAt = this.now();
      session.bytesPerSec = gifBytesPerSecond(stream);
      this.costs.delete(session.key);
      this.costs.set(session.key, session.bytesPerSec);
      if (this.costs.size > REMEMBERED_COSTS) this.costs.delete(this.costs.keys().next().value!);
      this.statsOpens += 1;
      this.write(videoOpen(id, { width: session.width, height: session.height, prebufferMs: 100, volume: 0, paused: session.paused }));
      this.options.log?.("video.open", {
        key: session.key, width: stream.width, height: stream.height, packets: stream.packets.length,
        durationMs: Math.round(stream.durationUs / 1000), remuxed: stream.remuxed, bytesPerSec: Math.round(session.bytesPerSec),
      });
      this.armPump();
    }, (error: unknown) => {
      if (this.sessions.get(candidate.key) === session) this.fail(session, error instanceof Error ? error.message : String(error));
    });
  }

  private pause(session: Session): void {
    session.paused = true;
    if (session.phase === "open") this.write(videoSet(session.id, { paused: true }));
  }

  private resume(session: Session): void {
    session.paused = false;
    if (session.phase === "open") this.write(videoSet(session.id, { paused: false }));
  }

  /**
   * Close a GIF. One showing frames first gives its place back to its still
   * (the next frame draws it) and is closed on the next update, so its box
   * is never empty in between.
   */
  private close(session: Session, now = false): void {
    if (session.phase === "open" && session.shown > 0 && !now) {
      session.phase = "closing";
      this.options.onChange();
      return;
    }
    if (session.phase === "open" || session.phase === "closing") this.write(videoClose(session.id));
    session.phase = "closed";
    this.sessions.delete(session.key);
    this.byId.delete(session.id);
  }

  private fail(session: Session, reason: string): void {
    this.failed.set(session.key, reason === "ENOSPC" ? this.now() + RETRY_NO_SLOT_MS : Infinity);
    this.options.log?.("video.failed", { key: session.key, reason });
    this.close(session);
  }

  private closeAll(): void {
    const showing = [...this.sessions.values()].some((session) => session.phase === "open" && session.shown > 0);
    for (const session of [...this.sessions.values()]) this.close(session, true);
    if (showing) this.options.onChange();
  }

  private handleReply(session: Session, reply: VideoReply): void {
    if (!reply.ok) {
      // ENOSPC (no slot: another program's video) or ENOENT (closed behind our back): back to the still.
      this.fail(session, reply.error ?? "error");
      return;
    }
    const seq = Number(reply.fields.seq);
    if (Number.isFinite(seq)) {
      const index = session.queries.findIndex((query) => query.seq === seq);
      if (index !== -1) {
        const acknowledged = session.queries[index]!.bytes;
        if (acknowledged > session.bytesAcked) {
          this.ackedTotal += acknowledged - session.bytesAcked;
          session.bytesAcked = acknowledged;
          this.acked.push({ at: this.now(), bytes: this.ackedTotal });
        }
        session.queries.splice(0, index + 1);
      }
    }
    if (reply.fields.error) {
      this.fail(session, reply.fields.error);
      return;
    }
    const pos = Number(reply.fields.pos);
    if (Number.isFinite(pos)) session.pos = pos;
    const shown = Number(reply.fields.shown);
    if (Number.isFinite(shown)) {
      const first = session.shown === 0 && shown > 0;
      session.shown = shown;
      if (first) this.options.onChange();
    }
  }

  private armPump(): void {
    const active = [...this.sessions.values()].some((session) => session.phase === "open");
    if (this.options.autoPump === false) return;
    if (active && !this.timer) {
      this.timer = setInterval(() => this.pump(), PUMP_MS);
      this.timer.unref?.();
    } else if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The window: 64 KiB plus 300 ms at the rate acknowledgements came back over the last 3 s. */
  private windowBytes(now: number): number {
    while (this.acked.length > 1 && now - this.acked[0]!.at > RATE_SPAN_MS) this.acked.shift();
    const first = this.acked[0];
    const last = this.acked.at(-1);
    const seconds = first && last ? (last.at - first.at) / 1000 : 0;
    const rate = seconds > 0.5 ? (last!.bytes - first!.bytes) / seconds : 0;
    return WINDOW_MIN_BYTES + rate * WINDOW_RATE_SECONDS;
  }

  /**
   * Send what each playing GIF may: nothing while the user interacts; else
   * within the byte budget, the shared window and its two seconds ahead.
   */
  pump(): void {
    const now = this.now();
    this.tokens = Math.min(GIF_BURST_BYTES, this.tokens + ((now - this.tokensAt) * GIF_BUDGET_BYTES_PER_SEC) / 1000);
    this.tokensAt = now;
    const elapsed = this.lastPumpAt === null ? 0 : now - this.lastPumpAt;
    this.lastPumpAt = now;
    if (this.quiet(now) || (this.options.backlog?.() ?? 0) > GIF_BACKLOG_LIMIT_BYTES) {
      this.statsHeldMs += elapsed;
      this.logStats(now);
      return;
    }
    const window = this.windowBytes(now);
    let inFlight = [...this.sessions.values()].reduce((sum, session) => sum + session.bytesWritten - session.bytesAcked, 0);
    // One write a tick: fewer wake-ups of the terminal.
    this.batch = [];
    // The one furthest behind first, so a budget too small for all is shared.
    const sessions = [...this.sessions.values()].filter((session) => session.phase === "open" && session.stream)
      .sort((left, right) => (left.index + left.loop * 1e6) / left.stream!.packets.length - (right.index + right.loop * 1e6) / right.stream!.packets.length);
    for (const session of sessions) {
      const { packets, durationUs } = session.stream!;
      if (!session.paused) {
        const playing = Math.max(0, session.pos);
        for (;;) {
          const packet = packets[session.index]!;
          const ptsUs = packet.ptsUs + session.loop * durationUs;
          if (ptsUs - playing > AHEAD_US) break;
          if (inFlight >= window) break;
          const apc = videoPacket(session.id, ptsUs, packet.keyframe, packet.data);
          // A packet bigger than the burst goes once the bucket is full.
          if (apc.length > this.tokens && this.tokens < GIF_BURST_BYTES) break;
          this.tokens -= apc.length;
          this.write(apc);
          session.bytesWritten += apc.length;
          inFlight += apc.length;
          if (++session.index >= packets.length) {
            session.index = 0;
            session.loop += 1;
          }
          if (session.bytesWritten - session.bytesAtLastQuery >= QUERY_EVERY_BYTES) this.query(session, now);
        }
      }
      // Status while playing, and until the first frame shows: where playback is, when to swap the still out.
      while (session.queries.length && now - session.queries[0]!.at > QUERY_GIVE_UP_MS) session.queries.shift();
      const due = session.shown === 0 ? (session.queries.length === 0 ? 0 : PUMP_MS * 2) : QUERY_EVERY_MS;
      if ((!session.paused || session.shown === 0) && now - session.lastQueryAt >= due) this.query(session, now);
    }
    const batch = this.batch;
    this.batch = null;
    if (batch?.length) this.write(batch.join(""));
    this.logStats(now);
  }

  private logStats(now: number): void {
    if (now - this.statsSince < STATS_EVERY_MS) return;
    const playing = [...this.sessions.values()].filter((session) => session.phase === "open" && !session.paused).length;
    if (this.statsBytes > 0 || playing > 0) {
      this.options.log?.("video.stats", {
        playing, open: this.openVideoIds().size, bytesPerSec: Math.round((this.statsBytes * 1000) / (now - this.statsSince)),
        heldMs: Math.round(this.statsHeldMs), opens: this.statsOpens,
      });
    }
    this.statsBytes = 0;
    this.statsHeldMs = 0;
    this.statsOpens = 0;
    this.statsSince = now;
  }

  private query(session: Session, now: number): void {
    if (session.queries.length >= MAX_OUTSTANDING_QUERIES) return;
    const seq = ++this.nextSeq;
    this.write(videoQuery(session.id, seq));
    session.queries.push({ seq, bytes: session.bytesWritten, at: now });
    session.lastQueryAt = now;
    session.bytesAtLastQuery = session.bytesWritten;
  }

  /** While pumping: what the tick writes, together. */
  private batch: string[] | null = null;

  private write(data: string): void {
    if (this.batch) {
      this.batch.push(data);
      return;
    }
    this.statsBytes += data.length;
    this.options.write(data);
  }
}
