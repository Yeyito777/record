/**
 * One video with sound in the viewer, through st's video (videoprotocol.ts):
 * its packets as ffmpeg makes them (mediastream.ts), paced like the GIFs by
 * st's acknowledgements, three seconds ahead of what plays. Space pauses, a
 * seek flushes and starts again at the keyframe before the target (st shows
 * from the exact time, `start=`), and at the end the last frame stays.
 */

import type { MediaPacket } from "./mediastream";
import { audioPacket, parseVideoReply, videoClose, videoEnd, videoFlush, videoOpen, videoPacket, videoQuery, videoSet } from "./videoprotocol";
/** Viewer videos: ids apart from GIFs (0x74...) and pictures. */
const VIEWER_ID_BASE = 0x75000000;
const AHEAD_US = 3_000_000;
const WINDOW_MIN_BYTES = 32 * 1024;
const WINDOW_RATE_SECONDS = 0.3;
const RATE_SPAN_MS = 3000;
const QUERY_EVERY_BYTES = 32 * 1024;
const QUERY_EVERY_MS = 250;
const MAX_OUTSTANDING_QUERIES = 4;
const QUERY_GIVE_UP_MS = 5000;
const PUMP_MS = 30;

let nextViewerId = 0;

export interface ViewerVideoOptions {
  write: (data: string) => void;
  /** Something the footer shows changed (state, position each second). */
  onChange: () => void;
  now?: () => number;
  autoPump?: boolean;
  /** Bytes written that the terminal has not read yet (terminaloutput.ts). */
  backlog?: () => number;
}

/** The viewer adds no packets while the terminal has more than this left to read: frames go first. */
const VIEWER_BACKLOG_LIMIT_BYTES = 64 * 1024;

export type ViewerVideoState = "buffering" | "playing" | "paused" | "ended" | "error";

/** A media packet (video or audio) as APCs. */
function mediaPacket(id: number, packet: MediaPacket): string {
  return packet.stream === 0 ? videoPacket(id, packet.ptsUs, packet.keyframe, packet.data) : audioPacket(id, packet.ptsUs, packet.data);
}

export class ViewerVideo {
  readonly id = VIEWER_ID_BASE + (nextViewerId++ % 0x00ffffff);
  private readonly packets: MediaPacket[] = [];
  /** Where each video keyframe is among the packets, for seeks. */
  private readonly keyframes: { index: number; ptsUs: number }[] = [];
  private finished = false;
  private opened = false;
  private closed = false;
  private index = 0;
  private endSent = false;
  private paused = false;
  /** Where playback is (st's pos; the seek target until st says). */
  private pos = 0;
  private stState: string = "buffering";
  private shownFrames = 0;
  private failure: string | null = null;
  private bytesWritten = 0;
  private bytesAcked = 0;
  private queries: { seq: number; bytes: number; at: number }[] = [];
  private nextSeq = 0;
  private lastQueryAt = 0;
  private bytesAtLastQuery = 0;
  private acked: { at: number; bytes: number }[] = [];
  private lastPositionSecond = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ViewerVideoOptions, readonly durationUs: number) {
    this.now = options.now ?? (() => performance.now());
  }

  /** Open it in st (display size in pixels; audio rate and channels, or none). */
  open(width: number, height: number, audio: { rate: number; channels: number } | null): void {
    if (this.closed || this.opened) return;
    this.opened = true;
    this.write(videoOpen(this.id, { width, height, ...(audio ? { audio } : {}) }));
    this.lastQueryAt = this.now();
    this.arm();
  }

  addPackets(packets: readonly MediaPacket[]): void {
    for (const packet of packets) {
      if (packet.stream === 0 && packet.keyframe) this.keyframes.push({ index: this.packets.length, ptsUs: packet.ptsUs });
      this.packets.push(packet);
    }
  }

  /** ffmpeg is done: no more packets (an error leaves the video as far as it got). */
  finish(error: string | null = null): void {
    this.finished = true;
    if (error && this.packets.length === 0) this.fail(error);
  }

  get state(): ViewerVideoState {
    if (this.failure) return "error";
    if (this.paused) return "paused";
    if (this.stState === "ended") return "ended";
    return this.stState === "playing" ? "playing" : "buffering";
  }

  get error(): string | null {
    return this.failure;
  }

  /** Seconds played, for the footer. */
  get positionUs(): number {
    return Math.max(0, this.pos);
  }

  /** st has shown a frame: the box shows the video. */
  get showing(): boolean {
    return this.shownFrames > 0;
  }

  togglePause(): void {
    if (this.closed || !this.opened) return;
    if (this.state === "ended") {
      this.seekTo(0);
      return;
    }
    this.paused = !this.paused;
    this.write(videoSet(this.id, { paused: this.paused }));
    this.options.onChange();
  }

  /** Seek by this much, within what has arrived. */
  seekBy(deltaUs: number): void {
    this.seekTo(this.positionUs + deltaUs);
  }

  seekTo(targetUs: number): void {
    if (this.closed || !this.opened || this.keyframes.length === 0) return;
    const lastKey = this.keyframes.at(-1)!;
    const limit = this.durationUs > 0 ? Math.max(0, this.durationUs - 500_000) : lastKey.ptsUs;
    const target = Math.max(0, Math.min(targetUs, limit, this.finished ? Infinity : lastKey.ptsUs));
    let key = this.keyframes[0]!;
    for (const candidate of this.keyframes) {
      if (candidate.ptsUs <= target) key = candidate;
      else break;
    }
    this.index = key.index;
    this.endSent = false;
    this.pos = target;
    this.stState = "buffering";
    // A seek goes ahead of what is still in flight to st (st discards it).
    this.write(videoFlush(this.id, target));
    if (this.paused) {
      this.paused = false;
      this.write(videoSet(this.id, { paused: false }));
    }
    this.options.onChange();
    this.pump();
  }

  /** Stop and free it: the command to write. */
  close(): string {
    if (this.closed) return "";
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.opened ? videoClose(this.id) : "";
  }

  handleControlSequence(sequence: string): boolean {
    const reply = parseVideoReply(sequence);
    if (!reply || reply.id !== this.id) return false;
    if (!reply.ok) {
      this.fail(reply.error ?? "error");
      return true;
    }
    const seq = Number(reply.fields.seq);
    if (Number.isFinite(seq)) {
      const at = this.queries.findIndex((query) => query.seq === seq);
      if (at !== -1) {
        if (this.queries[at]!.bytes > this.bytesAcked) {
          this.bytesAcked = this.queries[at]!.bytes;
          this.acked.push({ at: this.now(), bytes: this.bytesAcked });
        }
        this.queries.splice(0, at + 1);
      }
    }
    if (reply.fields.error) {
      this.fail(reply.fields.error);
      return true;
    }
    const before = { state: this.state, second: this.lastPositionSecond, showing: this.showing };
    const pos = Number(reply.fields.pos);
    if (Number.isFinite(pos) && pos >= 0) this.pos = pos;
    if (reply.fields.state) this.stState = reply.fields.state;
    const shown = Number(reply.fields.shown);
    if (Number.isFinite(shown)) this.shownFrames = Math.max(this.shownFrames, shown);
    this.lastPositionSecond = Math.floor(this.positionUs / 1_000_000);
    if (before.state !== this.state || before.second !== this.lastPositionSecond || before.showing !== this.showing) this.options.onChange();
    return true;
  }

  private fail(reason: string): void {
    this.failure = reason;
    this.options.onChange();
  }

  private arm(): void {
    if (this.options.autoPump === false || this.timer || this.closed) return;
    this.timer = setInterval(() => this.pump(), PUMP_MS);
    this.timer.unref?.();
  }

  private windowBytes(now: number): number {
    while (this.acked.length > 1 && now - this.acked[0]!.at > RATE_SPAN_MS) this.acked.shift();
    const first = this.acked[0];
    const last = this.acked.at(-1);
    const seconds = first && last ? (last.at - first.at) / 1000 : 0;
    const rate = seconds > 0.5 ? (last!.bytes - first!.bytes) / seconds : 0;
    return WINDOW_MIN_BYTES + rate * WINDOW_RATE_SECONDS;
  }

  pump(): void {
    if (this.closed || !this.opened || this.failure) return;
    const now = this.now();
    if (!this.paused && (this.options.backlog?.() ?? 0) <= VIEWER_BACKLOG_LIMIT_BYTES) {
      const window = this.windowBytes(now);
      while (this.index < this.packets.length && this.bytesWritten - this.bytesAcked < window) {
        const packet = this.packets[this.index]!;
        if (packet.ptsUs - this.positionUs > AHEAD_US) break;
        const apc = mediaPacket(this.id, packet);
        this.write(apc);
        this.bytesWritten += apc.length;
        this.index += 1;
        if (this.bytesWritten - this.bytesAtLastQuery >= QUERY_EVERY_BYTES) this.query(now);
      }
      if (this.finished && this.index >= this.packets.length && !this.endSent) {
        this.endSent = true;
        this.write(videoEnd(this.id));
      }
    }
    while (this.queries.length && now - this.queries[0]!.at > QUERY_GIVE_UP_MS) this.queries.shift();
    const due = this.shownFrames === 0 && this.queries.length === 0 ? 0 : QUERY_EVERY_MS;
    if (now - this.lastQueryAt >= due) this.query(now);
  }

  private query(now: number): void {
    if (this.queries.length >= MAX_OUTSTANDING_QUERIES) return;
    const seq = ++this.nextSeq;
    this.write(videoQuery(this.id, seq));
    this.queries.push({ seq, bytes: this.bytesWritten, at: now });
    this.lastQueryAt = now;
    this.bytesAtLastQuery = this.bytesWritten;
  }

  private write(data: string): void {
    if (!this.closed) this.options.write(data);
  }
}

/** m:ss (h:mm:ss past an hour). */
export function formatPlayback(us: number): string {
  const total = Math.max(0, Math.floor(us / 1_000_000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
