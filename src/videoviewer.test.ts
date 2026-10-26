import { describe, expect, test } from "bun:test";

import type { MediaPacket } from "./mediastream";
import { formatPlayback, ViewerVideo } from "./videoviewer";

interface Command { id: number; k: string; text?: string; stream?: number; ptsUs?: number }

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
      commands.push(controls.k === "d"
        ? { id: Number(controls.i), k: "d", stream: payload[0], ptsUs: Number(payload.readBigInt64BE(2)) }
        : { id: Number(controls.i), k: controls.k!, text: payload.toString() });
    }
  };
  return { commands, write };
}

/** Ten seconds: a keyframe every 2 s at 25 fps, AAC frames between. */
function clip(): MediaPacket[] {
  const packets: MediaPacket[] = [];
  for (let frame = 0; frame < 250; frame++) {
    packets.push({ stream: 0, keyframe: frame % 50 === 0, ptsUs: frame * 40_000, data: Buffer.alloc(200, frame) });
    if (frame % 2 === 0) packets.push({ stream: 1, keyframe: false, ptsUs: frame * 40_000, data: Buffer.alloc(100) });
  }
  return packets;
}

function setup() {
  let now = 0;
  const tty = terminal();
  const changes: number[] = [];
  const video = new ViewerVideo({ write: tty.write, onChange: () => changes.push(now), now: () => now, autoPump: false }, 10_000_000);
  const reply = (fields: string) => {
    const query = tty.commands.filter((command) => command.k === "q").at(-1)!;
    return video.handleControlSequence(`\x1b_Gi=${video.id};OK ${query.text} ${fields}\x1b\\`);
  };
  return { tty, video, changes, reply, advance: (ms: number) => { now += ms; } };
}

describe("video viewer", () => {
  test("opens with its sound, sends three seconds ahead, and swaps in once st shows a frame", () => {
    const { tty, video, reply } = setup();
    video.addPackets(clip());
    video.open(1280, 720, { rate: 48000, channels: 2 });
    video.pump();
    expect(tty.commands[0]).toEqual({ id: video.id, k: "o", text: "video=h264 width=1280 height=720 audio=aac rate=48000 channels=2" });
    const media = tty.commands.filter((command) => command.k === "d");
    expect(media.some((command) => command.stream === 1)).toBe(true);
    expect(Math.max(...media.map((command) => command.ptsUs!))).toBe(3_000_000);
    expect(video.showing).toBe(false);
    reply("state=playing pos=40000 shown=1");
    expect(video.showing).toBe(true);
    expect(video.state).toBe("playing");
  });

  test("Space pauses and resumes; a seek flushes, starts at the keyframe before it and shows from the exact time", () => {
    const { tty, video, reply } = setup();
    video.addPackets(clip());
    video.open(1280, 720, null);
    video.pump();
    reply("state=playing pos=1000000 shown=25");
    video.togglePause();
    expect(tty.commands.at(-1)).toEqual({ id: video.id, k: "s", text: "pause=1" });
    expect(video.state).toBe("paused");
    video.togglePause();
    expect(tty.commands.at(-1)).toEqual({ id: video.id, k: "s", text: "pause=0" });
    const before = tty.commands.length;
    video.seekBy(5_000_000);
    const after = tty.commands.slice(before);
    expect(after[0]).toEqual({ id: video.id, k: "f", text: "start=6000000" });
    // From the keyframe at 6 s (frame 150).
    expect(after.find((command) => command.k === "d")).toEqual({ id: video.id, k: "d", stream: 0, ptsUs: 6_000_000 });
    expect(video.positionUs).toBe(6_000_000);
    video.seekBy(-60_000_000);
    expect(tty.commands.filter((command) => command.k === "f").at(-1)!.text).toBe("start=0");
  });

  test("ends with the last frame; Space plays it again", () => {
    const { tty, video, reply, advance } = setup();
    video.addPackets(clip());
    video.finish();
    video.open(1280, 720, null);
    for (let pos = 0; pos <= 10_000_000; pos += 1_000_000) {
      video.pump();
      advance(300);
      reply(`state=playing pos=${pos} shown=${pos / 40_000 + 1}`);
    }
    video.pump();
    expect(tty.commands.filter((command) => command.k === "e")).toHaveLength(1);
    reply("state=ended pos=9960000 shown=250");
    expect(video.state).toBe("ended");
    video.togglePause();
    expect(tty.commands.filter((command) => command.k === "f").at(-1)!.text).toBe("start=0");
  });

  test("an error reply, or ffmpeg failing before any packet, is an error; closing frees it", () => {
    const { tty, video, reply } = setup();
    video.open(640, 360, null);
    video.pump();
    reply("state=buffering pos=-1 error=EBADMSG");
    expect(video.state).toBe("error");
    expect(video.error).toBe("EBADMSG");
    expect(video.close()).toBe(`\x1b_Ga=d,d=I,i=${video.id},q=2\x1b\\`);
    expect(video.close()).toBe("");
    const other = setup().video;
    other.finish("moov atom not found");
    expect(other.state).toBe("error");
    expect(tty.commands.some((command) => command.k === "close")).toBe(false);
  });

  test("times as m:ss", () => {
    expect(formatPlayback(0)).toBe("0:00");
    expect(formatPlayback(75_400_000)).toBe("1:15");
    expect(formatPlayback(3_725_000_000)).toBe("1:02:05");
  });
});
