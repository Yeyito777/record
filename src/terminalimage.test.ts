import { describe, expect, test } from "bun:test";

import type { InlineChatImageReady } from "./inlineimage";
import {
  disposeInlineTerminalImages,
  handleInlineTerminalImageResponse,
  parseTerminalCellSize,
  queryTerminalCellSize,
  syncInlineTerminalImages,
  transmitInlinePng,
} from "./terminalimage";

function image(overrides: Partial<InlineChatImageReady> = {}): InlineChatImageReady {
  return {
    phase: "ready",
    attachmentId: "attachment-1",
    filename: "cat.png",
    sourceUrl: "https://cdn.example/cat.png",
    requestId: 1,
    imageId: 0x40000001,
    pngBase64: "cG5n",
    pixelWidth: 100,
    pixelHeight: 50,
    ...overrides,
  };
}

describe("inline terminal graphics", () => {
  test("chunks large direct PNG transmissions into Kitty APC frames", () => {
    const sequence = transmitInlinePng(image({ pngBase64: "A".repeat(9000) }));
    expect(sequence).toContain("\x1b_Ga=t,t=d,f=100,i=1073741825,q=2,m=1;");
    expect(sequence).toContain("\x1b_Gm=1,q=2;");
    expect(sequence).toContain("\x1b_Gm=0,q=2;");
    expect(sequence.match(/\x1b_G/g)).toHaveLength(3);
  });

  test("transmits once, moves placements, and reclaims collapsed images", () => {
    const owner = {};
    const writes: string[] = [];
    const ready = image();
    const placement = {
      image: ready,
      placementId: 0x20000001,
      row: 4,
      col: 27,
      columns: 10,
      rows: 3,
    };

    syncInlineTerminalImages(owner, [ready], [placement], (payload) => writes.push(payload));
    expect(writes[0]).toContain("a=t,t=d,f=100");
    expect(writes[0]).toContain("\x1b[4;27H\x1b_Ga=p");
    expect(writes[0]).toContain("c=10,r=3,C=1,z=1,q=1");

    syncInlineTerminalImages(owner, [ready], [placement], (payload) => writes.push(payload));
    expect(writes).toHaveLength(1);

    syncInlineTerminalImages(owner, [ready], [{ ...placement, row: 3 }], (payload) => writes.push(payload));
    expect(writes).toHaveLength(2);
    expect(writes[1]).not.toContain("a=t");
    expect(writes[1]).toContain("\x1b[3;27H");

    syncInlineTerminalImages(owner, [ready], [], (payload) => writes.push(payload));
    expect(writes[2]).toContain(`a=d,d=i,i=${ready.imageId},p=${placement.placementId}`);

    syncInlineTerminalImages(owner, [ready], [placement], (payload) => writes.push(payload));
    expect(writes[3]).not.toContain("a=t,t=d,f=100");
    expect(writes[3]).toContain("a=p");

    syncInlineTerminalImages(owner, [], [], (payload) => writes.push(payload));
    expect(writes[4]).toContain(`a=d,d=I,i=${ready.imageId}`);
    disposeInlineTerminalImages(owner, (payload) => writes.push(payload));
    expect(writes).toHaveLength(5);
  });

  test("retransmits only after the terminal reports real image eviction", () => {
    const owner = {};
    const writes: string[] = [];
    const ready = image();
    const placement = {
      image: ready,
      placementId: 0x20000001,
      row: 4,
      col: 27,
      columns: 10,
      rows: 3,
    };

    syncInlineTerminalImages(owner, [ready], [placement], (payload) => writes.push(payload));
    syncInlineTerminalImages(owner, [ready], [], (payload) => writes.push(payload));
    syncInlineTerminalImages(owner, [ready], [placement], (payload) => writes.push(payload));
    expect(writes[2]).not.toContain("a=t,t=d,f=100");

    expect(handleInlineTerminalImageResponse(
      owner,
      `\x1b_Gi=${ready.imageId},p=${placement.placementId};ENOENT:image not found\x1b\\`,
    )).toBe(true);
    syncInlineTerminalImages(owner, [ready], [placement], (payload) => writes.push(payload));
    expect(writes[3]).toContain("a=t,t=d,f=100");
    expect(writes[3]).toContain("a=p");
    expect(handleInlineTerminalImageResponse(owner, "\x1b_Gi=1;EINVAL:bad placement\x1b\\")).toBe(false);
  });

  test("queries and parses standard cell pixel geometry", () => {
    expect(queryTerminalCellSize()).toBe("\x1b[16t");
    expect(parseTerminalCellSize("\x1b[6;18;9t")).toEqual({ width: 9, height: 18 });
    expect(parseTerminalCellSize("\x1b[4;900;1600t")).toBeNull();
  });
});
