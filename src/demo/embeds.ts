/**
 * Demo embeds: one of each kind Discord sends (fxtwitter-style posts, a
 * QuickVids video reply, YouTube, a bot's rich embed, a Tenor gif, an
 * article, a tweet gallery) at the end of `Record Lounge / #embeds`, plus a
 * link whose preview arrives later through MESSAGE_UPDATE.
 *
 * Every picture is served by the fake media proxy (images-ext-1.discordapp.net
 * /external/demo-<variant>/...) as one of the shared generated pictures.
 */

import type { DiscordEmbedMediaResponse, DiscordEmbedResponse } from "../discord";
import { imageVariant } from "./data";

export const DEMO_MEDIA_PROXY_HOSTS = ["images-ext-1.discordapp.net", "images-ext-2.discordapp.net"];

/** A picture the fake proxy serves, as an embed's image/thumbnail/video. */
export function demoEmbedMedia(variant: number, originalUrl: string, size?: { width: number; height: number }): DiscordEmbedMediaResponse {
  const shape = imageVariant(variant);
  const original = new URL(originalUrl);
  return {
    url: originalUrl,
    proxy_url: `https://${DEMO_MEDIA_PROXY_HOSTS[0]}/external/demo-${variant}/https/${original.host}${original.pathname}`,
    width: size?.width ?? shape.width,
    height: size?.height ?? shape.height,
  };
}

/** The proxy path's picture variant, or null when it is not a demo media path. */
export function demoMediaVariant(pathname: string): number | null {
  const match = /^\/external\/demo-(\d+)\//.exec(pathname);
  return match ? Number(match[1]) : null;
}

export interface DemoEmbedMessage {
  /** Username of the author (a demo person or bot). */
  author: string;
  content: string;
  embeds: DiscordEmbedResponse[];
  /** Embeds Discord adds a moment after the channel opens (an unfurl). */
  lateEmbeds?: DiscordEmbedResponse[];
  /** Reply to the message this many places earlier. */
  replyBack?: number;
}

export const QUICKVIDS_BOT: [string, string] = ["quickvids", "QuickVids"];

const TWEET_TIME = "2026-10-24T18:42:00.000Z";

export function demoEmbedShowcase(): DemoEmbedMessage[] {
  return [
    {
      author: "mira",
      content: "https://fxtwitter.com/mira_okafor/status/1849120000000000001",
      embeds: [{
        type: "rich",
        url: "https://fxtwitter.com/mira_okafor/status/1849120000000000001",
        color: 0x6c7cff,
        author: { name: "Mira Okafor (@mira_okafor)", url: "https://x.com/mira_okafor" },
        description: "finally got smooth scrolling working in my terminal client 🎉\n\nthe trick: let **the terminal** ease the glide (mode 2032) and only send whole rows\n\n💬 12   🔁 48   ❤️ 1.2K",
        provider: { name: "FxTwitter / FixupX", url: "https://github.com/FixTweet/FxTwitter" },
        footer: { text: "FxTwitter" },
        timestamp: TWEET_TIME,
        image: demoEmbedMedia(0, "https://pbs.twimg.com/media/demo-screenshot.jpg"),
      }],
    },
    {
      author: "kenji",
      content: "https://x.com/kenji_w/status/1849120000000000002",
      embeds: [],
    },
    {
      // What the owner sees: QuickVids answers x.com links with a video-only embed.
      author: QUICKVIDS_BOT[0],
      replyBack: 1,
      content: "https://d.xeezz.com/kenji_w/status/1849120000000000002",
      embeds: [{
        type: "video",
        url: "https://d.xeezz.com/kenji_w/status/1849120000000000002",
        video: demoEmbedMedia(16, "https://d.xeezz.com/kenji_w/status/1849120000000000002/video.mp4", { width: 720, height: 1280 }),
      }],
    },
    {
      author: "juno",
      content: "this explains it well https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      embeds: [{
        type: "video",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title: "Smooth scrolling explained in 4 minutes",
        color: 0xff0000,
        author: { name: "Demo Channel", url: "https://www.youtube.com/@demo" },
        provider: { name: "YouTube", url: "https://www.youtube.com" },
        thumbnail: demoEmbedMedia(10, "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg", { width: 1280, height: 720 }),
        video: { url: "https://www.youtube.com/embed/dQw4w9WgXcQ", width: 1280, height: 720 },
      }],
    },
    {
      author: "recordbot",
      content: "",
      embeds: [{
        type: "rich",
        title: "Weekly server stats",
        url: "https://record.example/stats",
        color: 0x57f287,
        description: "Activity in **Record Lounge** for Oct 19 – Oct 25. Ask `/stats` for any week.",
        fields: [
          { name: "Members", value: "1,204", inline: true },
          { name: "Online", value: "312", inline: true },
          { name: "Messages", value: "18,930", inline: true },
          { name: "Most active", value: "#general — 4,210 messages\n#images — 1,033 messages", inline: false },
        ],
        footer: { text: "Record Bot • stats" },
        timestamp: "2026-10-25T09:00:00.000Z",
        thumbnail: demoEmbedMedia(3, "https://record.example/stats/badge.png", { width: 256, height: 256 }),
      }],
    },
    {
      author: "amara",
      content: "https://tenor.com/view/cat-typing-fast-gif-1234567",
      embeds: [{
        type: "gifv",
        url: "https://tenor.com/view/cat-typing-fast-gif-1234567",
        provider: { name: "Tenor", url: "https://tenor.co" },
        thumbnail: demoEmbedMedia(25, "https://media.tenor.com/demo/cat-typing.png", { width: 498, height: 374 }),
        video: demoEmbedMedia(25, "https://media.tenor.com/demo/cat-typing.mp4", { width: 498, height: 374 }),
      }],
    },
    {
      author: "tobias",
      content: "worth a read https://news.example.org/2026/10/terminals",
      embeds: [{
        type: "article",
        url: "https://news.example.org/2026/10/terminals",
        title: "Why terminals are having a moment",
        description: "Smooth scrolling, inline images and proper Unicode: a decade of small protocol extensions has turned the terminal into a surprisingly good place to chat, read and watch.",
        provider: { name: "Example News", url: "https://news.example.org" },
        thumbnail: demoEmbedMedia(7, "https://news.example.org/images/terminals.jpg"),
      }],
    },
    {
      author: "noor",
      content: "https://twitter.com/noor_haddad/status/1849120000000000007",
      embeds: [
        {
          type: "rich",
          url: "https://twitter.com/noor_haddad/status/1849120000000000007",
          color: 0x1da1f2,
          author: { name: "Noor Haddad (@noor_haddad)", url: "https://twitter.com/noor_haddad" },
          description: "three sunsets in a row from the same window",
          footer: { text: "Twitter" },
          timestamp: TWEET_TIME,
          image: demoEmbedMedia(5, "https://pbs.twimg.com/media/demo-sunset-1.jpg"),
        },
        { url: "https://twitter.com/noor_haddad/status/1849120000000000007", image: demoEmbedMedia(15, "https://pbs.twimg.com/media/demo-sunset-2.jpg") },
        { url: "https://twitter.com/noor_haddad/status/1849120000000000007", image: demoEmbedMedia(35, "https://pbs.twimg.com/media/demo-sunset-3.jpg") },
      ],
    },
    {
      author: "felix",
      content: "release notes are up https://github.com/example/record/releases/tag/v2.0",
      embeds: [],
      lateEmbeds: [demoReleaseEmbed("https://github.com/example/record/releases/tag/v2.0", "v2.0")],
    },
  ];
}

export function demoReleaseEmbed(url: string, tag: string): DiscordEmbedResponse {
  return {
    type: "article",
    url,
    title: `Release ${tag} · example/record`,
    description: "Link previews and bot embeds now draw like Discord: colour bar, fields, thumbnails, images and video posters.",
    provider: { name: "GitHub", url: "https://github.com" },
    color: 0x24292f,
    thumbnail: demoEmbedMedia(13, `https://opengraph.githubassets.com/demo/example/record/${tag}`, { width: 600, height: 600 }),
  };
}
