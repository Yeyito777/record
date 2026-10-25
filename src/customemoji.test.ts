import { describe, expect, test } from "bun:test";

import { CustomEmojiImageRenderer, discordCustomEmojiCdnUrl } from "./customemoji";
import { termWidth } from "./textwidth";
import { theme } from "./theme";
import { VtScreen } from "./vtscreen.testutil";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==",
  "base64",
);

describe("Discord custom emoji images", () => {
  test("once every private-use marker is taken, new emoji show their name instead of a stuck loading glyph", () => {
    const renderer = new CustomEmojiImageRenderer();
    for (let index = 0; index <= 0xf8ff - 0xe000; index++) renderer.markerFor({ id: String(1000 + index), name: `e${index}`, animated: false });
    expect(renderer.markerFor({ id: "1000", name: "e0", animated: false })).toBe("\ue000");
    expect(renderer.markerFor({ id: "999999", name: "late_emoji", animated: false })).toBe(":late_emoji:");
  });

  test("replaces static and animated syntax with atomic two-column markers", () => {
    const renderer = new CustomEmojiImageRenderer();
    const source = "x <:aliencat_stare_2:1478284001298087936> <a:dance:1478284001298087937> y";
    const marked = renderer.replaceTokens(source);

    expect(renderer.decodeMarkers(marked)).toBe(source);
    expect(termWidth(marked)).toBe(termWidth("x xx xx y"));
    expect(marked).not.toContain("aliencat_stare_2");
  });

  test("downloads visible PNGs and emits an aspect-preserving inline placement", async () => {
    const urls: string[] = [];
    let updates = 0;
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const renderer = new CustomEmojiImageRenderer({
      fetch: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      }) as typeof fetch,
      onUpdate: () => {
        updates++;
        if (updates >= 2) resolveReady?.();
      },
    });
    const marker = renderer.replaceTokens("<:aliencat_stare_2:1478284001298087936>");

    renderer.setEnabled(true);
    const loadingBatch = renderer.beginFrame();
    expect(renderer.renderLine(`\x1b[31mA${marker}B`, 5, 4, loadingBatch)).toContain("A◇ B");
    await ready;

    const readyBatch = renderer.beginFrame();
    const line = renderer.renderLine(`\x1b[31mA${marker}B`, 5, 4, readyBatch);
    const frame = renderer.finishFrame(readyBatch);
    expect(line).toBe("\x1b[31mA　B");
    expect(urls).toEqual(["https://cdn.discordapp.com/emojis/1478284001298087936.png?size=32&quality=lossless"]);
    expect(frame.key).toContain("@5,5");
    expect(frame.payload).toContain("\x1b_Ga=t,t=d,f=100");
    expect(frame.payload).toContain("\x1b[5;5H\x1b_Ga=p");
    expect(frame.payload).toContain("c=2,r=1,C=1,z=1478");
    expect(renderer.clipboardImageForMarker(marker)).toMatchObject({
      mediaType: "image/png",
      base64: PNG.toString("base64"),
      sizeBytes: PNG.length,
      filename: "aliencat_stare_2.png",
    });

    const maskedBatch = renderer.beginFrame();
    const maskedLine = renderer.renderLine(marker, 5, 4, maskedBatch, {
      imageBackground: "\x1b[49m",
      restoreBackground: "\x1b[48;2;1;2;3m",
    });
    expect(maskedLine).toBe("\x1b[49m　\x1b[48;2;1;2;3m");

    const selectedBatch = renderer.beginFrame();
    renderer.renderLine(`${theme.selectionBg}${marker}${theme.reset}`, 5, 4, selectedBatch);
    const selectedFrame = renderer.finishFrame(selectedBatch);
    expect(selectedFrame.key).toContain(":1");
    expect(selectedFrame.payload).toContain("z=1478,V=1,q=2");
  });

  test("smooth scrolling: tracked placements change one by one and follow region scrolls", async () => {
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    let updates = 0;
    const renderer = new CustomEmojiImageRenderer({
      fetch: (async (_url: string | URL | Request) => new Response(PNG, { headers: { "content-type": "image/png" } })) as typeof fetch,
      // setEnabled reports once; the download finishing is the second.
      onUpdate: () => { if (++updates >= 2) resolveReady?.(); },
    });
    const marker = renderer.replaceTokens("<:aliencat_stare_2:1478284001298087936>");
    renderer.setEnabled(true);
    renderer.renderLine(marker, 5, 4, renderer.beginFrame());
    await ready;
    const screen = new VtScreen(12, 40);
    const frameAt = (rows: number[], scrolled: { start: number; end: number } | null = null) => {
      const batch = renderer.beginFrame();
      for (const row of rows) renderer.renderLine(`A${marker}`, row, 4, batch);
      const payload = renderer.finishTrackedFrame(batch)(scrolled);
      screen.write(payload);
      return payload;
    };

    const placedIds = (payload: string) => [...payload.matchAll(/a=p,i=\d+,p=(\d+)/g)].map((match) => Number(match[1]));
    const deletedIds = (payload: string) => [...payload.matchAll(/a=d,d=i,i=\d+,p=(\d+)/g)].map((match) => Number(match[1]));

    // The first tracked frame clears anonymous placements once, then places with ids.
    const first = frameAt([5, 7]);
    expect(first.match(/a=d,d=z/g)).toHaveLength(1);
    expect(first).toMatch(new RegExp(`\\x1b\\[5;5H\\x1b_Ga=p,i=${0x72000000},p=\\d+,c=2,r=1,C=1,z=1478,q=2`));
    expect(screen.placements().map((placement) => placement.row).sort((a, b) => a - b)).toEqual([4, 6]);
    const [atFive, atSeven] = placedIds(first);

    // Nothing changed: nothing sent.
    expect(frameAt([5, 7])).toBe("");

    // The region (rows 3..10) scrolled up one row: both moved with it; the
    // emoji are placed at their new rows and the old ids deleted one by one
    // (never by z, which would also erase st's kept copies mid-glide).
    screen.write("\x1b[3;10r\x1b[1S\x1b[r");
    const scrolled = frameAt([4, 6], { start: 3, end: 10 });
    expect(scrolled).not.toContain("d=z");
    expect(deletedIds(scrolled).sort()).toEqual([atFive, atSeven].sort());
    expect(screen.placements().map((placement) => placement.row).sort((a, b) => a - b)).toEqual([3, 5]);
    const [atFour, atSix] = placedIds(scrolled);

    // One leaves the view: only it is deleted.
    const left = frameAt([6]);
    expect(left).toBe(`\x1b_Ga=d,d=i,i=${0x72000000},p=${atFour},q=2\x1b\\`);
    expect(screen.placements().map((placement) => placement.row).sort((a, b) => a - b)).toEqual([5]);
    void atSix;

    // Back to anonymous placements: the full sweep again.
    expect(renderer.finishFrame(renderer.beginFrame()).payload).toContain("a=d,d=z");
  });

  test("smooth scrolling: a row redrawn with other attributes gets new placements; the same row keeps them", async () => {
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    let updates = 0;
    const renderer = new CustomEmojiImageRenderer({
      fetch: (async (_url: string | URL | Request) => new Response(PNG, { headers: { "content-type": "image/png" } })) as typeof fetch,
      onUpdate: () => { if (++updates >= 2) resolveReady?.(); },
    });
    const marker = renderer.replaceTokens("<:aliencat_stare_2:1478284001298087936>");
    renderer.setEnabled(true);
    renderer.renderLine(marker, 5, 4, renderer.beginFrame());
    await ready;
    const frameWith = (line: string, options = {}) => {
      const batch = renderer.beginFrame();
      renderer.renderLine(line, 5, 4, batch, options);
      return renderer.finishTrackedFrame(batch)(null);
    };
    const plain = `\x1b[38;2;255;255;255mA${marker}`;
    expect(frameWith(plain)).toContain("a=p");
    expect(frameWith(plain)).toBe("");
    // The cursor line: highlighted around the image, its cells restored.
    const highlighted = frameWith(`\x1b[48;2;9;13;53m\x1b[38;2;255;255;255mA${marker}`, { imageBackground: "\x1b[48;2;0;5;15m", restoreBackground: "\x1b[48;2;9;13;53m" });
    expect(highlighted).toMatch(/a=d,d=i,.*a=p,/);
    expect(frameWith(plain)).toMatch(/a=d,d=i,.*a=p,/);
  });

  test("always requests a PNG first frame for animated CDN emoji", () => {
    expect(discordCustomEmojiCdnUrl({ id: "1478284001298087937" })).toBe(
      "https://cdn.discordapp.com/emojis/1478284001298087937.png?size=32&quality=lossless",
    );
  });
});
