/**
 * `Record Lounge / #gifs`: the newest messages are GIFs of every kind Discord
 * sends: Tenor/Giphy links (a gifv embed whose mp4 plays; a message that is
 * only the link shows just the GIF), .gif attachments (one message with
 * three small ones, so six can be in view at once) and an animated (APNG)
 * sticker. Served by the fake CDN and media proxy as generated animations
 * (demo/animations.ts).
 */

import type { DiscordEmbedResponse } from "../discord";
import type { DemoAnimationKind } from "./animations";
import { demoEmbedMedia } from "./embeds";

export interface DemoGifFile {
  filename: string;
  width: number;
  height: number;
  seed: number;
}

export interface DemoGifMessage {
  author: string;
  content: string;
  embeds?: DiscordEmbedResponse[];
  gifs?: DemoGifFile[];
  /** An animated sticker (APNG). */
  sticker?: { name: string; seed: number };
}

/** What the fake CDN serves for an attachment or sticker id. */
export interface DemoAnimationSpec {
  kind: DemoAnimationKind;
  width: number;
  height: number;
  seed: number;
}

/** A Tenor link and its gifv embed; `variant` picks the poster (and the mp4's shape). */
function tenor(slug: string, variant: number, size: { width: number; height: number }): DiscordEmbedResponse {
  const url = `https://tenor.com/view/${slug}`;
  return {
    type: "gifv",
    url,
    provider: { name: "Tenor", url: "https://tenor.co" },
    thumbnail: demoEmbedMedia(variant, `https://media.tenor.com/demo/${slug}.png`, size),
    video: demoEmbedMedia(variant, `https://media.tenor.com/demo/${slug}.mp4`, size),
  };
}

function giphy(slug: string, variant: number, size: { width: number; height: number }): DiscordEmbedResponse {
  const url = `https://giphy.com/gifs/${slug}`;
  return {
    type: "gifv",
    url,
    provider: { name: "GIPHY", url: "https://giphy.com/" },
    thumbnail: demoEmbedMedia(variant, `https://media.giphy.com/media/demo/${slug}/giphy_s.gif`, size),
    video: demoEmbedMedia(variant, `https://media.giphy.com/media/demo/${slug}/giphy.mp4`, size),
  };
}

export function demoGifShowcase(): DemoGifMessage[] {
  const dance = "cat-dance-gif-24680";
  const nod = "nodding-yes-gif-13579";
  return [
    { author: "mira", content: "gif thread 🧵 reply with your best one" },
    { author: "kenji", content: `https://tenor.com/view/${dance}`, embeds: [tenor(dance, 15, { width: 498, height: 374 })] },
    { author: "amara", content: "a .gif straight from my camera roll", gifs: [{ filename: "camera-roll.gif", width: 480, height: 270, seed: 3 }] },
    { author: "tobias", content: `this one 😂 https://tenor.com/view/${nod}`, embeds: [tenor(nod, 10, { width: 498, height: 280 })] },
    { author: "quinn", content: "", sticker: { name: "party", seed: 5 } },
    {
      author: "mira",
      content: "tiny ones",
      gifs: [
        { filename: "tiny-1.gif", width: 200, height: 150, seed: 6 },
        { filename: "tiny-2.gif", width: 200, height: 150, seed: 7 },
        { filename: "tiny-3.gif", width: 200, height: 150, seed: 8 },
      ],
    },
    { author: "kenji", content: "https://giphy.com/gifs/thumbs-up-demo", embeds: [giphy("thumbs-up-demo", 45, { width: 480, height: 360 })] },
    { author: "amara", content: "ok last one, I promise" },
    { author: "tobias", content: `https://tenor.com/view/${dance}-2`, embeds: [tenor(`${dance}-2`, 35, { width: 498, height: 374 })] },
  ];
}
