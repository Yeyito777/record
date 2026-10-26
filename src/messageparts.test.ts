import { describe, expect, test } from "bun:test";

import { isOnlyGifLink, summarizeDisplayMessageParts, summarizeInlineMessageParts } from "./messageparts";

describe("message part summaries", () => {
  test("suppresses unhelpful Tenor provider-only embeds", () => {
    const url = "https://tenor.com/view/teto-latinas-latina-love-kasane-teto-gif-14230423554759109852";
    const embeds = [{
      type: "gifv",
      title: null,
      url,
      description: null,
      providerName: "Tenor",
      authorName: null,
    }];

    expect(summarizeDisplayMessageParts(url, [], embeds)).toEqual([url]);
    expect(summarizeInlineMessageParts(url, [], embeds)).toBe(url);
  });

  test("keeps Tenor embeds with useful labels", () => {
    const url = "https://tenor.com/view/dance-gif-1";
    const embeds = [{
      type: "gifv",
      title: "Dance",
      url,
      description: null,
      providerName: "Tenor",
      authorName: null,
    }];

    expect(summarizeDisplayMessageParts(url, [], embeds)).toEqual([url, "↳ Tenor: Dance"]);
    expect(summarizeInlineMessageParts(url, [], embeds)).toBe(`${url} · ↳ Tenor: Dance`);
  });

  test("a message that is only a GIF's link shows just the GIF; a link with words keeps its line", () => {
    const url = "https://tenor.com/view/dance-gif-1";
    const gifv = [{ type: "gifv", url }];
    expect(isOnlyGifLink(url, gifv)).toBe(true);
    expect(isOnlyGifLink(`  <${url}>\n`, gifv)).toBe(true);
    expect(isOnlyGifLink(`this one ${url}`, gifv)).toBe(false);
    expect(isOnlyGifLink(url, [{ type: "article", url }])).toBe(false);
    expect(isOnlyGifLink(url, [{ type: "gifv", url: "https://tenor.com/view/other-gif-2" }])).toBe(false);
    expect(isOnlyGifLink("https://example.com/cat.gif", [{ type: "image", url: "https://example.com/cat.gif" }])).toBe(true);
    expect(isOnlyGifLink("https://example.com/cat.png", [{ type: "image", url: "https://example.com/cat.png" }])).toBe(false);
  });
});
