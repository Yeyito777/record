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
  test("changing only the z-index replaces placement without retransmitting pixels", () => {
    const owner = {};
    const ready = image();
    const placement = { image: ready, placementId: 1, row: 2, col: 3, columns: 10, rows: 5 };
    const writes: string[] = [];
    syncInlineTerminalImages(owner, [ready], [placement], (payload) => writes.push(payload));
    syncInlineTerminalImages(owner, [ready], [{ ...placement, z: 2 }], (payload) => writes.push(payload));
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("z=2");
    expect(writes[1]).not.toContain("a=t");
    syncInlineTerminalImages(owner, [ready], [{ ...placement, z: 2 }], (payload) => writes.push(payload));
    expect(writes).toHaveLength(2);
  });

  test("chunks large direct PNG transmissions into Kitty APC frames", () => {
    const sequence = transmitInlinePng(image({ pngBase64: "A".repeat(9000) }));
    expect(sequence).toContain("\x1b_Ga=t,t=d,f=100,i=1073741825,q=2,m=1;");
    expect(sequence).toContain("\x1b_Gm=1,q=2;");
    expect(sequence).toContain("\x1b_Gm=0,q=2;");
    expect(sequence.match(/\x1b_G/g)).toHaveLength(3);
  });

  test("transmits once, moves placements, and retains collapsed images until disposal", () => {
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

    syncInlineTerminalImages(owner, [ready], [{ ...placement, row: 3, selected: true }], (payload) => writes.push(payload));
    expect(writes[2]).toContain("z=1,V=1,q=1");

    syncInlineTerminalImages(owner, [ready], [], (payload) => writes.push(payload));
    expect(writes[3]).toContain(`a=d,d=i,i=${ready.imageId},p=${placement.placementId}`);

    syncInlineTerminalImages(owner, [ready], [placement], (payload) => writes.push(payload));
    expect(writes[4]).not.toContain("a=t,t=d,f=100");
    expect(writes[4]).toContain("a=p");

    syncInlineTerminalImages(owner, [], [], (payload) => writes.push(payload));
    expect(writes[5]).toContain(`a=d,d=i,i=${ready.imageId}`);
    expect(writes[5]).not.toContain("d=I");
    disposeInlineTerminalImages(owner, (payload) => writes.push(payload));
    expect(writes[6]).toContain(`a=d,d=I,i=${ready.imageId}`);
    expect(writes).toHaveLength(7);
  });

  test("switches A → B → A with placement commands only on return", () => {
    const owner = {};
    const a = image();
    const b = image({ imageId: 0x40000002, pngBase64: "b3RoZXI=" });
    const writes: string[] = [];
    const show = (ready: InlineChatImageReady) => syncInlineTerminalImages(owner, [ready], [{
      image: ready, placementId: 1, row: 4, col: 27, columns: 10, rows: 3,
    }], (payload) => writes.push(payload));
    show(a);
    syncInlineTerminalImages(owner, [], [], (payload) => writes.push(payload));
    show(b);
    show(a);
    expect(writes[3]).not.toContain("a=t");
    expect(writes[3]).not.toContain("d=I");
    expect(writes[3]).toContain(`a=p,i=${a.imageId}`);

    // The same protocol ID with new pixels must still be retransmitted.
    show({ ...a, pngBase64: "bmV3" });
    expect(writes[4]).toContain("a=t");
  });

  test("evicts the least recently viewed idle image at the count limit", () => {
    const owner = {};
    let output = "";
    const show = (id: number) => {
      const ready = image({ imageId: id });
      output = "";
      syncInlineTerminalImages(owner, [ready], [{
        image: ready, placementId: 1, row: 1, col: 1, columns: 10, rows: 3,
      }], (payload) => { output += payload; });
    };
    for (let id = 1; id <= 65; id++) show(id);
    show(1); // refresh age
    expect(output).not.toContain("a=t");
    show(66);
    expect(output).toContain("a=d,d=I,i=2,");
    expect(output).not.toContain("a=d,d=I,i=1,");
    show(2);
    expect(output).toContain("a=t");
  });

  test("bounds idle decoded bytes without evicting a visible oversized image", () => {
    const owner = {};
    const ready = image({ pixelWidth: 4096, pixelHeight: 4096 });
    const writes: string[] = [];
    const placement = { image: ready, placementId: 1, row: 1, col: 1, columns: 10, rows: 3 };
    syncInlineTerminalImages(owner, [ready], [placement], (payload) => writes.push(payload));
    expect(writes[0]).not.toContain("d=I");
    syncInlineTerminalImages(owner, [], [], (payload) => writes.push(payload));
    expect(writes[1]).toContain(`a=d,d=I,i=${ready.imageId}`);
    syncInlineTerminalImages(owner, [ready], [placement], (payload) => writes.push(payload));
    expect(writes[2]).toContain("a=t");
  });

  test("closing an oversized modal preserves smaller cached chat previews", () => {
    const owner = {};
    const small = image();
    const large = image({ imageId: 2, pixelWidth: 4096, pixelHeight: 4096 });
    let output = "";
    const show = (ready: InlineChatImageReady) => {
      output = "";
      syncInlineTerminalImages(owner, [ready], [{
        image: ready, placementId: 1, row: 1, col: 1, columns: 10, rows: 3,
      }], (payload) => { output += payload; });
    };
    show(small);
    show(large);
    syncInlineTerminalImages(owner, [], [], () => {});
    show(small);
    expect(output).toContain("a=p");
    expect(output).not.toContain("a=t");
  });

  test("can retain placements while deferring new or moved placements", () => {
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
    const write = (payload: string) => writes.push(payload);

    syncInlineTerminalImages(owner, [ready], [placement], write, { allowPlacementUpdates: false });
    expect(writes[0]).toContain("a=t,t=d,f=100");
    expect(writes[0]).not.toContain("a=p");

    syncInlineTerminalImages(owner, [ready], [placement], write, { allowPlacementUpdates: true });
    expect(writes[1]).not.toContain("a=t,t=d,f=100");
    expect(writes[1]).toContain("a=p");

    syncInlineTerminalImages(owner, [ready], [{ ...placement, row: 3 }], write, { allowPlacementUpdates: false });
    expect(writes).toHaveLength(2);

    syncInlineTerminalImages(owner, [ready], [{ ...placement, row: 3 }], write, { allowPlacementUpdates: true });
    expect(writes[2]).toContain("\x1b[3;27H");
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
