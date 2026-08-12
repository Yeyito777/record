import { describe, expect, test } from "bun:test";

import { H264AnnexBFrameAssembler, buildDiscordVideoRtpExtensionBody, buildPlayoutDelayExtension, buildRtcpSenderReport, isH264Keyframe, packetizeGenericVideoPayload, packetizeH264AccessUnit, packetizeMaybeAnnexBVideoPayload, parseRtcpNackSequences, rewriteH264SpsNalusForWebRtc } from "./stream";

describe("screen streaming", () => {
  test("builds Discord/WebRTC one-byte playout-delay RTP extension", () => {
    // One-byte RTP extension header: id=6, len=2 means three payload bytes.
    // 100ms/200ms is encoded as 10/20 in 10ms units => 00 a0 14.
    expect([...buildPlayoutDelayExtension(10, 20)]).toEqual([0x62, 0x00, 0xa0, 0x14]);
    expect([...buildDiscordVideoRtpExtensionBody(0x1234)]).toEqual([
      0x51, 0x12, 0x34,
      0x62, 0x00, 0x00, 0x0a,
      0x70, 0x01,
      0xb2, 0x31, 0x30, 0x30,
      0x00, 0x00, 0x00,
    ]);
  });

  test("builds minimal RTCP sender reports", () => {
    const sr = buildRtcpSenderReport(0x11223344, 0x55667788, 9, 10, 1_000);
    expect([...sr.subarray(0, 8)]).toEqual([0x80, 200, 0, 6, 0x11, 0x22, 0x33, 0x44]);
    expect(sr.readUInt32BE(8)).toBe(2_208_988_801);
    expect(sr.readUInt32BE(16)).toBe(0x55667788);
    expect(sr.readUInt32BE(20)).toBe(9);
    expect(sr.readUInt32BE(24)).toBe(10);
  });

  test("parses generic RTCP NACK packet ids and bitmasks", () => {
    const nack = Buffer.alloc(20);
    nack[0] = 0x81;
    nack[1] = 205;
    nack.writeUInt16BE(4, 2);
    nack.writeUInt32BE(10, 4);
    nack.writeUInt32BE(20, 8);
    nack.writeUInt16BE(0xffff, 12);
    nack.writeUInt16BE(0b101, 14);
    nack.writeUInt16BE(8, 16);
    nack.writeUInt16BE(0, 18);
    expect(parseRtcpNackSequences(nack, 20)).toEqual([0xffff, 0, 2, 8]);
    expect(parseRtcpNackSequences(nack, 21)).toEqual([]);
  });

  test("assembles Annex-B H264 access units on AUD boundaries", () => {
    const frames: number[][][] = [];
    const assembler = new H264AnnexBFrameAssembler((nalus) => frames.push(nalus.map((nalu) => [...nalu])));
    assembler.push(Buffer.from([0, 0, 1, 0x09, 0x10, 0, 0]));
    assembler.push(Buffer.from([1, 0x67, 1, 2, 3, 0, 0, 1, 0x65, 4, 5]));
    expect(frames).toEqual([]);
    assembler.push(Buffer.from([0, 0, 1, 0x09, 0x10, 0, 0, 1, 0x41, 6, 7, 0, 0, 1, 0x09, 0x10, 0, 0, 1, 0x67]));
    expect(frames).toEqual([
      [[0x09, 0x10], [0x67, 1, 2, 3], [0x65, 4, 5]],
      [[0x09, 0x10], [0x41, 6, 7]],
    ]);
  });

  test("packetizes H264 access units with FU-A fragmentation", () => {
    const small = Buffer.from([0x65, 1, 2]);
    const large = Buffer.from([0x61, 10, 11, 12, 13, 14]);
    const packets = packetizeH264AccessUnit([Buffer.from([0x09, 0x10]), small, large], 4);
    expect(packets.map((packet) => [...packet])).toEqual([
      [0x65, 1, 2],
      [0x7c, 0x81, 10, 11],
      [0x7c, 0x01, 12, 13],
      [0x7c, 0x41, 14],
    ]);
  });

  test("packetizes opaque DAVE video payloads without H264 FU-A parsing", () => {
    const packets = packetizeGenericVideoPayload(Buffer.from([1, 2, 3, 4, 5]), 2);
    expect(packets.map((packet) => [...packet])).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("packetizes DAVE output as H264 when it preserves Annex-B framing", () => {
    const result = packetizeMaybeAnnexBVideoPayload(Buffer.from([0, 0, 1, 0x09, 0x10, 0, 0, 1, 0x65, 1, 2]), 10);
    expect(result.mode).toBe("h264-annexb");
    expect(result.payloads.map((packet) => [...packet])).toEqual([[0x65, 1, 2]]);
  });

  test("packetizes opaque DAVE H264 frames as a single protected NAL with FU-A fragmentation", () => {
    const result = packetizeMaybeAnnexBVideoPayload(Buffer.from([0x61, 10, 11, 12, 13, 14]), 4);
    expect(result.mode).toBe("h264-opaque-fua");
    expect(result.payloads.map((packet) => [...packet])).toEqual([
      [0x7c, 0x81, 10, 11],
      [0x7c, 0x01, 12, 13],
      [0x7c, 0x41, 14],
    ]);
  });

  test("detects H264 IDR keyframes", () => {
    expect(isH264Keyframe([Buffer.from([0x41, 1, 2])])).toBe(false);
    expect(isH264Keyframe([Buffer.from([0x67, 1]), Buffer.from([0x65, 2])])).toBe(true);
  });

  test("rewrites H264 SPS VUI for WebRTC decoder compatibility", () => {
    const sps = Buffer.from("6742c01fda0280bfe5c05a808080a0000003002000000781e30654", "hex");
    const pps = Buffer.from([0x68, 0xce]);
    const [rewritten, passthrough] = rewriteH264SpsNalusForWebRtc([sps, pps]);
    expect(rewritten[0] & 0x1f).toBe(7);
    expect(rewritten.equals(sps)).toBe(false);
    expect(passthrough).toEqual(pps);
  });
});
