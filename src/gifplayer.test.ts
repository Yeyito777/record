import { describe, expect, test } from "bun:test";

import { GifPlayer, type GifCandidate } from "./gifplayer";
import type { VideoStream } from "./videostream";

/** A one-second, 10 fps stream of 4 KB access units. */
function stream(frames = 10, bytes = 4000): VideoStream {
  return {
    width: 320, height: 180, durationUs: frames * 100_000, remuxed: false,
    packets: Array.from({ length: frames }, (_, index) => ({ ptsUs: index * 100_000, keyframe: index === 0, data: Buffer.alloc(bytes, index) })),
  };
}

interface Command { id: number; k: string; text?: string; ptsUs?: number }

/** The terminal side: every APC Record wrote, decoded. */
function terminal() {
  const commands: Command[] = [];
  let pending = "";
  const write = (data: string) => {
    pending += data;
    for (let end = pending.indexOf("\x1b\\"); end !== -1; end = pending.indexOf("\x1b\\")) {
      const apc = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const separator = apc.indexOf(";");
      const controls = Object.fromEntries((separator === -1 ? apc.slice(3) : apc.slice(3, separator)).split(",").map((field) => field.split("=")));
      if (controls.a === "d") commands.push({ id: Number(controls.i), k: "close" });
      if (controls.a !== "v") continue;
      const payload = separator === -1 ? Buffer.alloc(0) : Buffer.from(apc.slice(separator + 1), "base64");
      commands.push({
        id: Number(controls.i), k: controls.k!,
        ...(controls.k === "d" ? { ptsUs: Number(payload.readBigInt64BE(2)) } : { text: payload.toString() }),
      });
    }
  };
  return { commands, write };
}

function setup() {
  let now = 0;
  const changes: number[] = [];
  const tty = terminal();
  const player = new GifPlayer({ write: tty.write, onChange: () => changes.push(now), now: () => now, autoPump: false });
  player.setSupported(true);
  const candidate = (key: string, visibility: number, frames = 10): GifCandidate => ({
    key, visibility, width: 320, height: 180, load: async () => stream(frames),
  });
  return {
    tty, player, changes, candidate,
    advance: (ms: number) => { now += ms; },
    /** st's answer to the last status query of a video. */
    reply: (id: number, fields: string) => {
      const query = tty.commands.filter((command) => command.id === id && command.k === "q").at(-1)!;
      return player.handleControlSequence(`\x1b_Gi=${id};OK ${query.text} ${fields}\x1b\\`);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("GIF player", () => {
  test("plays the three most in view, opened silent at their still's size; the fourth keeps its still", async () => {
    const { tty, player, candidate } = setup();
    player.update([candidate("a", 3), candidate("b", 9), candidate("c", 6), candidate("d", 1)]);
    await flush();
    const opens = tty.commands.filter((command) => command.k === "o");
    expect(opens).toHaveLength(3);
    expect(opens[0]!.text).toBe("video=h264 width=320 height=180 prebuffer=100 volume=0");
    expect(player.openVideoIds().size).toBe(3);
  });

  test("swaps the still out only once st shows a frame", async () => {
    const { player, candidate, reply, changes } = setup();
    player.update([candidate("a", 5)]);
    await flush();
    player.pump();
    const id = [...player.openVideoIds()][0]!;
    expect(player.videoImageId("a")).toBeNull();
    expect(reply(id, "state=buffering pos=-1 shown=0")).toBe(true);
    expect(player.videoImageId("a")).toBeNull();
    reply(id, "state=playing pos=0 shown=1");
    expect(player.videoImageId("a")).toBe(id);
    expect(changes).toHaveLength(1);
  });

  test("sends no more than two seconds ahead of what plays, then loops with later timestamps", async () => {
    const { tty, player, candidate, reply, advance } = setup();
    player.update([candidate("a", 5)]);
    await flush();
    player.pump();
    const id = [...player.openVideoIds()][0]!;
    const sent = () => tty.commands.filter((command) => command.k === "d").map((command) => command.ptsUs!);
    // Nothing played yet: up to 2 s of media, the second loop included.
    expect(sent().at(-1)).toBe(2_000_000);
    expect(sent().slice(9, 12)).toEqual([900_000, 1_000_000, 1_100_000]);
    advance(300);
    reply(id, "state=playing pos=1500000 shown=15");
    player.pump();
    expect(sent().at(-1)).toBe(3_500_000);
    // Keyframes only at each loop's start.
    expect(tty.commands.filter((command) => command.k === "d").length).toBe(36);
  });

  test("keeps the bytes past the newest acknowledgement within its window", async () => {
    const { tty, player, reply, advance } = setup();
    // 100 KB frames: the 256 KiB window holds three.
    player.update([{ key: "a", visibility: 5, width: 320, height: 180, load: async () => stream(10, 100_000) }]);
    await flush();
    player.pump();
    const id = [...player.openVideoIds()][0]!;
    const packets = () => tty.commands.filter((command) => command.k === "d").length;
    expect(packets()).toBe(2);
    advance(100);
    player.pump();
    expect(packets()).toBe(2);
    reply(id, "state=playing pos=0 shown=1");
    player.pump();
    expect(packets()).toBeGreaterThan(2);
  });

  test("pauses a GIF that leaves the view, resumes it on return, closes it when its slot is wanted", async () => {
    const { tty, player, candidate } = setup();
    player.update([candidate("a", 5), candidate("b", 5), candidate("c", 5)]);
    await flush();
    const idOf = (key: string) => tty.commands.find((command) => command.k === "o" && player.openVideoIds().has(command.id) && player["sessions"].get(key)?.id === command.id)!.id;
    const a = idOf("a");
    player.update([candidate("b", 5), candidate("c", 5)]);
    expect(tty.commands.at(-1)).toEqual({ id: a, k: "s", text: "pause=1" });
    player.update([candidate("a", 5), candidate("b", 5), candidate("c", 5)]);
    expect(tty.commands.at(-1)).toEqual({ id: a, k: "s", text: "pause=0" });
    // a leaves; d comes: a (paused) gives up its slot.
    player.update([candidate("b", 5), candidate("c", 5)]);
    player.update([candidate("b", 5), candidate("c", 5), candidate("d", 5)]);
    expect(tty.commands.some((command) => command.id === a && command.k === "close")).toBe(true);
    await flush();
    expect(player.openVideoIds().size).toBe(3);
  });

  test("one showing frames is closed only after its still is back in its place", async () => {
    const { tty, player, candidate, reply, changes } = setup();
    player.update([candidate("a", 5), candidate("b", 5), candidate("c", 5)]);
    await flush();
    player.pump();
    const a = player["sessions"].get("a")!.id;
    reply(a, "state=playing pos=0 shown=1");
    expect(player.videoImageId("a")).toBe(a);
    player.update([candidate("b", 5), candidate("c", 5)]);
    // d wants a's slot: a hands back to its still first (a redraw), no close yet.
    const before = changes.length;
    player.update([candidate("b", 5), candidate("c", 5), candidate("d", 5)]);
    expect(player.videoImageId("a")).toBeNull();
    expect(changes.length).toBe(before + 1);
    expect(tty.commands.some((command) => command.id === a && command.k === "close")).toBe(false);
    // The frame with its still drawn, then: closed, and d gets the slot.
    player.update([candidate("b", 5), candidate("c", 5), candidate("d", 5)]);
    expect(tty.commands.some((command) => command.id === a && command.k === "close")).toBe(true);
    await flush();
    expect(player["sessions"].has("d")).toBe(true);
  });

  test("a terminal without video, a GIF that can't be encoded, or an error keep the still", async () => {
    const { tty, player, candidate, reply } = setup();
    player.setSupported(false);
    player.update([candidate("a", 5)]);
    await flush();
    expect(tty.commands).toEqual([]);
    player.setSupported(true);
    player.update([{ key: "broken", visibility: 5, width: 1, height: 1, load: async () => null }]);
    await flush();
    expect(player.openVideoIds().size).toBe(0);
    player.update([{ key: "broken", visibility: 5, width: 1, height: 1, load: async () => stream() }]);
    await flush();
    expect(player.openVideoIds().size).toBe(0);
    player.update([candidate("bad", 5)]);
    await flush();
    player.pump();
    const id = [...player.openVideoIds()][0]!;
    reply(id, "state=playing pos=0 shown=0 error=EBADMSG");
    expect(player.openVideoIds().size).toBe(0);
    expect(tty.commands.at(-1)).toEqual({ id, k: "close" });
  });

  test("asks the terminal; its OK, or DA1 without an answer, decides", () => {
    const answers: boolean[] = [];
    const written: string[] = [];
    const player = new GifPlayer({ write: (data) => written.push(data), onChange: () => {}, onSupportChanged: (supported) => answers.push(supported), autoPump: false });
    player.detect();
    expect(written[0]).toBe("\x1b_Ga=v,i=1879048189,k=c\x1b\\\x1b[c");
    expect(player.handleControlSequence("\x1b_Gi=1879048189;OK video=h264 audio=aac max=4096x4096\x1b\\")).toBe(true);
    expect(player.handleControlSequence("\x1b[?62;22c")).toBe(true);
    expect(answers).toEqual([true]);
    expect(player.isSupported()).toBe(true);

    const other = new GifPlayer({ write: () => {}, onChange: () => {}, onSupportChanged: (supported) => answers.push(supported), autoPump: false });
    other.detect();
    other.handleControlSequence("\x1b[?62;22c");
    expect(answers).toEqual([true, false]);
    expect(other.isSupported()).toBe(false);
  });

  test("replies for other images are not its own", () => {
    const { player } = setup();
    expect(player.handleControlSequence("\x1b_Gi=1073741825;ENOENT:image not found\x1b\\")).toBe(false);
    expect(player.handleControlSequence("\x1b_Gi=1946157060;OK seq=1\x1b\\")).toBe(true);
  });
});
