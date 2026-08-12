import { describe, expect, test } from "bun:test";

import { H264RtpDepacketizer, H264RtpJitterBuffer, packetizeH264AnnexB, splitAnnexBNalus } from "./h264";

describe("H264 RTP media", () => {
  test("round trips single NALs and FU-A fragments", () => {
    const frame = Buffer.concat([
      Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f]),
      Buffer.from([0, 0, 0, 1, 0x65]),
      Buffer.alloc(30, 0x88),
    ]);
    const payloads = packetizeH264AnnexB(frame, 10);
    expect(payloads.length).toBeGreaterThan(2);

    const depacketizer = new H264RtpDepacketizer();
    let decoded: Buffer | null = null;
    payloads.forEach((payload, index) => {
      decoded = depacketizer.push({
        sequence: 100 + index,
        timestamp: 90_000,
        marker: index === payloads.length - 1,
        payload,
      });
    });
    expect(splitAnnexBNalus(decoded ?? Buffer.alloc(0))).toEqual(splitAnnexBNalus(frame));
  });

  test("depacketizes STAP-A and drops sequence gaps", () => {
    const stap = Buffer.concat([
      Buffer.from([0x78, 0, 2, 0x67, 0x42, 0, 2, 0x68, 0xce]),
    ]);
    const depacketizer = new H264RtpDepacketizer();
    const frame = depacketizer.push({ sequence: 7, timestamp: 1, marker: true, payload: stap });
    expect(splitAnnexBNalus(frame ?? Buffer.alloc(0))).toEqual([Buffer.from([0x67, 0x42]), Buffer.from([0x68, 0xce])]);

    expect(depacketizer.push({ sequence: 10, timestamp: 2, marker: false, payload: Buffer.from([0x7c, 0x85, 1, 2]) })).toBeNull();
    expect(depacketizer.push({ sequence: 12, timestamp: 2, marker: true, payload: Buffer.from([0x7c, 0x45, 3, 4]) })).toBeNull();
  });

  test("waits for a late RTX repair before completing a fragmented frame", () => {
    const source = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(3_000, 0x44)]);
    const payloads = packetizeH264AnnexB(source, 500);
    expect(payloads.length).toBeGreaterThan(3);
    const jitter = new H264RtpJitterBuffer();
    const missingIndex = 2;
    let output: ReturnType<H264RtpJitterBuffer["push"]> = [];
    payloads.forEach((payload, index) => {
      if (index === missingIndex) return;
      output = jitter.push({ sequence: 100 + index, timestamp: 90_000, marker: index === payloads.length - 1, payload });
    });
    expect(output).toEqual([]);
    output = jitter.push({ sequence: 100 + missingIndex, timestamp: 90_000, marker: false, payload: payloads[missingIndex]! });
    expect(output).toHaveLength(1);
    expect(splitAnnexBNalus(output[0]!.frame)).toEqual(splitAnnexBNalus(source));
  });
});
