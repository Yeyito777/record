import { describe, expect, test } from "bun:test";

import { CustomEmojiImageRenderer, discordCustomEmojiCdnUrl } from "./customemoji";
import { termWidth } from "./textwidth";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==",
  "base64",
);

describe("Discord custom emoji images", () => {
  test("replaces static and animated syntax with one-cell logical markers", () => {
    const renderer = new CustomEmojiImageRenderer();
    const source = "x <:aliencat_stare_2:1478284001298087936> <a:dance:1478284001298087937> y";
    const marked = renderer.replaceTokens(source);

    expect(renderer.decodeMarkers(marked)).toBe(source);
    expect(termWidth(marked)).toBe(termWidth("x x x y"));
    expect(marked).not.toContain("aliencat_stare_2");
  });

  test("downloads visible PNGs and emits a one-cell inline placement", async () => {
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
    expect(renderer.renderLine(`\x1b[31mA${marker}B`, 5, 4, loadingBatch)).toContain("A◇B");
    await ready;

    const readyBatch = renderer.beginFrame();
    const line = renderer.renderLine(`\x1b[31mA${marker}B`, 5, 4, readyBatch);
    const frame = renderer.finishFrame(readyBatch);
    expect(line).toBe("\x1b[31mA B");
    expect(urls).toEqual(["https://cdn.discordapp.com/emojis/1478284001298087936.png?size=32&quality=lossless"]);
    expect(frame.key).toContain("@5,5");
    expect(frame.payload).toContain("\x1b_Ga=t,t=d,f=100");
    expect(frame.payload).toContain("\x1b[5;5H\x1b_Ga=p");
    expect(frame.payload).toContain("c=1,r=1,C=1,z=1478");
  });

  test("always requests a PNG first frame for animated CDN emoji", () => {
    expect(discordCustomEmojiCdnUrl({ id: "1478284001298087937" })).toBe(
      "https://cdn.discordapp.com/emojis/1478284001298087937.png?size=32&quality=lossless",
    );
  });
});

