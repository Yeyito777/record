import { describe, expect, test } from "bun:test";

import { summarizeDisplayMessageParts, summarizeInlineMessageParts } from "./messageparts";

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
});
