/**
 * GIFs that play by themselves in chat, through st's video (videoprotocol.ts).
 *
 * The GIFs in view are offered every frame; the most visible few play
 * (looping, silent), the rest keep their still first frame. One that leaves
 * the view is paused and, when its slot is wanted, closed. Packets go out
 * paced by the terminal's own acknowledgements (st docs/video.md, flow
 * control): a status query every 32 KiB, no more than a window of bytes past
 * the newest answered one, and no more than two seconds of media ahead of
 * what is playing, so a slow link never fills st's buffers. A loop is the
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
}

/** First video image id; videos take ids apart from pictures (0x40000000..) and icons. */
const VIDEO_ID_BASE = 0x74000000;
const VIDEO_ID_SPAN = 0x00ffffff;
const AHEAD_US = 2_000_000;
/**
 * Bytes written and not yet acknowledged, all GIFs together: 32 KiB plus
 * 300 ms at the rate acknowledgements come back (st docs/video.md: a round
 * trip and a little at the delivery rate). st-play keeps 64 KiB at least;
 * Record keeps less, so on a slow link keys and frames wait behind half a
 * second of GIF at most, not seconds.
 */
const WINDOW_MIN_BYTES = 32 * 1024;
const WINDOW_RATE_SECONDS = 0.3;
const RATE_SPAN_MS = 3000;
/**
 * A link too slow for the GIFs playing keeps the window full: then one GIF
 * fewer plays (down to one), and one more again after a quiet while.
 */
const SLOW_LINK_SPAN_MS = 3000;
const SLOW_LINK_SHARE = 0.5;
const FEWER_AFTER_MS = 5000;
const MORE_AFTER_MS = 10_000;
const QUERY_EVERY_BYTES = 32 * 1024;
const QUERY_EVERY_MS = 250;
const MAX_OUTSTANDING_QUERIES = 4;
const PUMP_MS = 40;
/** A paused GIF out of view this long is closed even if no other wants its slot. */
const CLOSE_PAUSED_AFTER_MS = 60_000;
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
}

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
  /** How many may play now: fewer while the link can't carry them all. */
  private playLimit: number;
  private lastLimitChange = -Infinity;
  /** Pump ticks with GIFs to send: whether the window held them back. */
  private ticks: { at: number; limited: boolean }[] = [];
  /** Acknowledged bytes over time (all GIFs), for the delivery rate. */
  private acked: { at: number; bytes: number }[] = [];
  private ackedTotal = 0;

  constructor(private readonly options: GifPlayerOptions) {
    this.now = options.now ?? (() => performance.now());
    this.maxOpen = options.maxOpen ?? 3;
    this.playLimit = this.maxOpen;
    this.statsSince = this.now();
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
    if (!this.supported) return;
    const now = this.now();
    // Their stills were placed back by the frame just drawn: close them now.
    for (const session of [...this.sessions.values()]) {
      if (session.phase === "closing") this.close(session, true);
    }
    const inView = candidates.filter((candidate) => candidate.visibility > 0 && !((this.failed.get(candidate.key) ?? -Infinity) > now));
    // Most in view first; on a tie, the one already playing keeps playing.
    inView.sort((left, right) => right.visibility - left.visibility
      || Number(this.isPlaying(right.key)) - Number(this.isPlaying(left.key)));
    const wanted = inView.slice(0, this.playLimit);
    const wantedKeys = new Set(wanted.map((candidate) => candidate.key));
    for (const session of this.sessions.values()) {
      if (inView.some((candidate) => candidate.key === session.key)) session.lastVisibleAt = now;
      if (!wantedKeys.has(session.key) && session.phase === "open" && !session.paused) this.pause(session);
      if (session.phase === "open" && session.paused && now - session.lastVisibleAt > CLOSE_PAUSED_AFTER_MS) this.close(session);
    }
    for (const candidate of wanted) {
      const session = this.sessions.get(candidate.key);
      if (session) {
        if (session.phase === "open" && session.paused) this.resume(session);
        continue;
      }
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
      lastVisibleAt: now, openedAt: now,
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
      this.write(videoOpen(id, { width: session.width, height: session.height, prebufferMs: 100, volume: 0, paused: session.paused }));
      this.options.log?.("video.open", { key: session.key, width: stream.width, height: stream.height, packets: stream.packets.length, durationMs: Math.round(stream.durationUs / 1000), remuxed: stream.remuxed });
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

  /** Send what each playing GIF may: within the shared window and its two seconds ahead. */
  pump(): void {
    const now = this.now();
    const window = this.windowBytes(now);
    let inFlight = [...this.sessions.values()].reduce((sum, session) => sum + session.bytesWritten - session.bytesAcked, 0);
    let wanting = false;
    for (const session of this.sessions.values()) {
      if (session.phase !== "open" || !session.stream) continue;
      const { packets, durationUs } = session.stream;
      if (!session.paused) {
        const playing = Math.max(0, session.pos);
        for (;;) {
          const packet = packets[session.index]!;
          const ptsUs = packet.ptsUs + session.loop * durationUs;
          if (ptsUs - playing > AHEAD_US) break;
          if (inFlight >= window) {
            wanting = true;
            break;
          }
          const apc = videoPacket(session.id, ptsUs, packet.keyframe, packet.data);
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
    this.adaptToLink(now, wanting);
    if (now - this.statsSince >= STATS_EVERY_MS) {
      const playing = [...this.sessions.values()].filter((session) => session.phase === "open" && !session.paused).length;
      if (this.statsBytes > 0 || playing > 0) {
        this.options.log?.("video.stats", { playing, open: this.openVideoIds().size, bytesPerSec: Math.round((this.statsBytes * 1000) / (now - this.statsSince)) });
      }
      this.statsBytes = 0;
      this.statsSince = now;
    }
  }

  /** One GIF fewer while the window stays full; one more after a while without. */
  private adaptToLink(now: number, limited: boolean): void {
    const playing = [...this.sessions.values()].filter((session) => session.phase === "open" && !session.paused).length;
    if (playing > 0) this.ticks.push({ at: now, limited });
    while (this.ticks.length && now - this.ticks[0]!.at > MORE_AFTER_MS) this.ticks.shift();
    const recent = this.ticks.filter((tick) => now - tick.at <= SLOW_LINK_SPAN_MS);
    const share = recent.length ? recent.filter((tick) => tick.limited).length / recent.length : 0;
    if (playing > 1 && recent.length >= 10 && share >= SLOW_LINK_SHARE && now - this.lastLimitChange >= FEWER_AFTER_MS) {
      this.playLimit = playing - 1;
      this.lastLimitChange = now;
      this.ticks = [];
      this.options.log?.("video.slow_link", { playing: this.playLimit });
      // The least visible gives way at the next update.
      this.options.onChange();
    } else if (this.playLimit < this.maxOpen && this.ticks.length >= 20 && !this.ticks.some((tick) => tick.limited)
      && now - this.lastLimitChange >= MORE_AFTER_MS) {
      this.playLimit += 1;
      this.lastLimitChange = now;
      this.options.log?.("video.slow_link", { playing: this.playLimit });
    }
  }

  private query(session: Session, now: number): void {
    if (session.queries.length >= MAX_OUTSTANDING_QUERIES) return;
    const seq = ++this.nextSeq;
    this.write(videoQuery(session.id, seq));
    session.queries.push({ seq, bytes: session.bytesWritten, at: now });
    session.lastQueryAt = now;
    session.bytesAtLastQuery = session.bytesWritten;
  }

  private write(data: string): void {
    this.statsBytes += data.length;
    this.options.write(data);
  }
}
