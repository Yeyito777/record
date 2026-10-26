import { describe, expect, test } from "bun:test";

import {
  isPrimaryDeviceAttributes, parseVideoReply, VIDEO_QUERY_ID, videoCapabilityQuery, videoClose, videoOpen, videoPacket, videoQuery, videoSet,
} from "./videoprotocol";

const text = (apc: string) => Buffer.from(apc.slice(apc.indexOf(";") + 1, -2), "base64").toString();

describe("st video protocol", () => {
  test("asks for video support, then DA1", () => {
    expect(videoCapabilityQuery()).toBe(`\x1b_Ga=v,i=${VIDEO_QUERY_ID},k=c\x1b\\\x1b[c`);
  });

  test("opens a silent H.264 video of a display size, errors only", () => {
    const open = videoOpen(31, { width: 864.4, height: 486, prebufferMs: 100 });
    expect(open).toStartWith("\x1b_Ga=v,i=31,k=o,q=1;");
    expect(text(open)).toBe("video=h264 width=864 height=486 prebuffer=100");
    expect(text(videoOpen(31, { width: 9000, height: 0, paused: true, volume: 0 }))).toBe("video=h264 width=4096 height=1 pause=1 volume=0");
  });

  test("frames an access unit with st's 10-byte header, chunked like st-play", () => {
    const small = videoPacket(31, 1_234_567, true, Buffer.from([0, 0, 0, 1, 0x65]));
    expect(small).toStartWith("\x1b_Ga=v,i=31,k=d,q=2;");
    const payload = Buffer.from(small.slice(small.indexOf(";") + 1, -2), "base64");
    expect([...payload.subarray(0, 2)]).toEqual([0, 1]);
    expect(payload.readBigInt64BE(2)).toBe(1_234_567n);
    expect([...payload.subarray(10)]).toEqual([0, 0, 0, 1, 0x65]);

    const big = videoPacket(31, 0, false, Buffer.alloc(30_000, 7));
    const chunks = big.split("\x1b\\").filter(Boolean);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toStartWith("\x1b_Ga=v,i=31,k=d,q=2,m=1;");
    expect(chunks[1]).toStartWith("\x1b_Gm=1;");
    expect(chunks[2]).toStartWith("\x1b_Gm=0;");
    const joined = Buffer.from(chunks.map((chunk) => chunk.slice(chunk.indexOf(";") + 1)).join(""), "base64");
    expect(joined.length).toBe(30_010);
    expect(joined[1]).toBe(0);
  });

  test("pauses, queries with a sequence number and closes", () => {
    expect(videoSet(31, { paused: true })).toStartWith("\x1b_Ga=v,i=31,k=s,q=1;");
    expect(text(videoSet(31, { paused: false, volume: 0 }))).toBe("pause=0 volume=0");
    expect(videoQuery(31, 7)).toStartWith("\x1b_Ga=v,i=31,k=q;");
    expect(text(videoQuery(31, 7))).toBe("seq=7");
    expect(videoClose(31)).toBe("\x1b_Ga=d,d=I,i=31,q=2\x1b\\");
  });

  test("reads status and capability replies and errors", () => {
    expect(parseVideoReply("\x1b_Gi=31;OK seq=7 state=playing pos=1234567 vbuf=3400000 abuf=-1 shown=36 dropped=0 rx=482113\x1b\\")).toEqual({
      id: 31, ok: true,
      fields: { seq: "7", state: "playing", pos: "1234567", vbuf: "3400000", abuf: "-1", shown: "36", dropped: "0", rx: "482113" },
    });
    expect(parseVideoReply(`\x1b_Gi=${VIDEO_QUERY_ID};OK video=h264 audio=aac max=4096x4096\x1b\\`)?.fields.video).toBe("h264");
    expect(parseVideoReply("\x1b_Gi=31;ENOSPC:too many videos\x1b\\")).toEqual({ id: 31, ok: false, fields: {}, error: "ENOSPC" });
    expect(parseVideoReply("\x1b_Gi=31,p=2;OK\x1b\\")).toBeNull();
    expect(isPrimaryDeviceAttributes("\x1b[?62;22c")).toBe(true);
    expect(isPrimaryDeviceAttributes("\x1b[?2026;2$y")).toBe(false);
  });
});
