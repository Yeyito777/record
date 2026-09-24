import { describe, expect, test } from "bun:test";
import { firstAnimatedWebpFrame } from "./webp";

// Two 16x16 lossless frames (red, blue), generated with img2webp.
const animated = Buffer.from("UklGRoQAAABXRUJQVlA4WAoAAAACAAAADwAADwAAQU5JTQYAAAD/////AABBTk1GKAAAAAAAAAAAAA8AAA8AAGQAAAJWUDhMDwAAAC8PwAMABxD1j/4HIqL/AQBBTk1GKAAAAAAAAAAAAA8AAA8AAGQAAABWUDhMDwAAAC8PwAMABxDR//4HIqL/AQA=", "base64");
const still = Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvD8ADAAcQ9Y/+ByKi/wEA", "base64");

describe("animated WebP first frame", () => {
  test("leaves static WebP and other formats alone", () => {
    expect(firstAnimatedWebpFrame(still)).toBeNull();
    expect(firstAnimatedWebpFrame(Buffer.from("not a WebP"))).toBeNull();
  });

  test("extracts a standalone image without animation headers", () => {
    expect(firstAnimatedWebpFrame(animated)).toEqual({
      data: still, width: 16, height: 16, x: 0, y: 0,
    });
  });

  test("retains the canvas and subframe position", () => {
    const partial = Buffer.from(animated);
    partial.writeUIntLE(19, 24, 3);
    partial.writeUIntLE(19, 27, 3);
    partial.writeUIntLE(1, 52, 3);
    partial.writeUIntLE(1, 55, 3);
    expect(firstAnimatedWebpFrame(partial)).toEqual({
      data: still, width: 20, height: 20, x: 2, y: 2,
    });
  });

  test("rejects truncated, oversized and out-of-canvas frames", () => {
    expect(() => firstAnimatedWebpFrame(animated.subarray(0, -1))).toThrow("Truncated");
    const huge = Buffer.from(animated);
    huge.writeUIntLE(8192, 24, 3);
    expect(() => firstAnimatedWebpFrame(huge)).toThrow("limit");
    const outside = Buffer.from(animated);
    outside.writeUIntLE(1, 52, 3);
    expect(() => firstAnimatedWebpFrame(outside)).toThrow("canvas");
    const invalidChunk = Buffer.from(animated);
    invalidChunk.writeUInt32LE(0xffffffff, 72);
    expect(() => firstAnimatedWebpFrame(invalidChunk)).toThrow("Truncated");
  });
});
