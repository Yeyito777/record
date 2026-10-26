import { describe, expect, test } from "bun:test";

import { discordAttachmentProxyRequest, proxiedAttachment } from "./discordmedia";

// Signed attachment URLs as the API sends them: the query ends in "&".
const signed = "?ex=6633a421&is=663252a1&hm=9142545f794bff679622e2b8dbcbe71ed09309535f28f3bbfc81367da03badea&";
const attachment = (filename: string, contentType: string | null, width = 4000, height = 3000) => ({
  id: "1235237565918085120",
  filename,
  contentType,
  size: 3_000_000,
  url: `https://cdn.discordapp.com/attachments/989268270618136586/1235237565918085120/${filename}${signed}`,
  proxyUrl: `https://media.discordapp.net/attachments/989268270618136586/1235237565918085120/${filename}${signed}`,
  width,
  height,
});

describe("Discord media proxy", () => {
  test("asks for a scaled copy exactly as the web client does", () => {
    // Real web-client URLs: JPEG and WebP ".../x.jpg?ex=..&is=..&hm=..&=&format=webp&width=293&height=350",
    // PNG "...&=&format=webp&quality=lossless&width=388&height=388".
    expect(discordAttachmentProxyRequest(attachment("dsc03338.jpg", "image/jpeg", 2930, 3500), 586, 350)).toEqual({
      url: `https://media.discordapp.net/attachments/989268270618136586/1235237565918085120/dsc03338.jpg${signed}=&format=webp&width=293&height=350`,
      width: 293,
      height: 350,
    });
    expect(discordAttachmentProxyRequest(attachment("e3c3a911.png", "image/png", 1024, 1024), 576, 388)?.url)
      .toBe(`https://media.discordapp.net/attachments/989268270618136586/1235237565918085120/e3c3a911.png${signed}=&format=webp&quality=lossless&width=388&height=388`);
    expect(discordAttachmentProxyRequest(attachment("photo.webp", "image/webp"), 576, 256)?.url)
      .toEndWith(`photo.webp${signed}=&format=webp&width=341&height=256`);
  });

  test("uses the CDN URL on the proxy's host when the API sent no proxy URL", () => {
    const { proxyUrl: _proxyUrl, ...withoutProxy } = attachment("a.jpg", "image/jpeg");
    expect(discordAttachmentProxyRequest(withoutProxy, 576, 256)?.url)
      .toBe(`https://media.discordapp.net/attachments/989268270618136586/1235237565918085120/a.jpg${signed}=&format=webp&width=341&height=256`);
  });

  test("fetches the original otherwise", () => {
    // Already no larger than its box.
    expect(discordAttachmentProxyRequest(attachment("small.png", "image/png", 300, 200), 576, 256)).toBeNull();
    // Size unknown, not a still picture the proxy scales, or not a Discord attachment.
    expect(discordAttachmentProxyRequest({ ...attachment("a.jpg", "image/jpeg"), width: undefined }, 576, 256)).toBeNull();
    expect(discordAttachmentProxyRequest(attachment("a.gif", "image/gif"), 576, 256)).toBeNull();
    expect(discordAttachmentProxyRequest(attachment("clip.mp4", "video/mp4"), 576, 256)).toBeNull();
    expect(discordAttachmentProxyRequest({
      ...attachment("a.jpg", "image/jpeg"), url: "https://example.com/a.jpg", proxyUrl: undefined,
    }, 576, 256)).toBeNull();
    // Without a content type the name decides.
    expect(discordAttachmentProxyRequest(attachment("a.JPG", null), 576, 256)).not.toBeNull();
  });

  test("the scaled copy has its own cache entry and claims no byte size", () => {
    const original = attachment("dsc03338.jpg", "image/jpeg");
    const request = discordAttachmentProxyRequest(original, 576, 256)!;
    const proxied = proxiedAttachment(original, request);
    expect(proxied).toMatchObject({ url: request.url, filename: "dsc03338.webp", size: 0, width: 341, height: 256 });
    expect(proxied.cacheKey).toBe("1235237565918085120:media-proxy:341x256");
    expect(proxied.id).toBe(original.id);
  });
});
