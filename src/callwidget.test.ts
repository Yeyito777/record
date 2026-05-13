import { describe, expect, test } from "bun:test";

import { buildCallWidgetCommand, defaultDiscordAvatarIndex, discordAvatarUrl, isDefaultDiscordAvatarUrl, stabilizeCallWidgetParticipantAvatars } from "./callwidget";

describe("call widget", () => {
  test("builds the external widget command", () => {
    expect(buildCallWidgetCommand("/tmp/widget")).toEqual(["/tmp/widget"]);
  });

  test("builds Discord avatar URLs", () => {
    expect(discordAvatarUrl("123", "hash", "0")).toBe("https://cdn.discordapp.com/avatars/123/hash.png?size=128");
    expect(discordAvatarUrl("123", "a_hash", "0")).toBe("https://cdn.discordapp.com/avatars/123/a_hash.gif?size=128");
  });

  test("falls back to default Discord avatars", () => {
    expect(defaultDiscordAvatarIndex("175928847299117063", "1337")).toBe(2);
    expect(discordAvatarUrl("175928847299117063", null, "1337")).toBe("https://cdn.discordapp.com/embed/avatars/2.png");
    expect(discordAvatarUrl("175928847299117063", null, "0")).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
    expect(isDefaultDiscordAvatarUrl("https://cdn.discordapp.com/embed/avatars/2.png")).toBe(true);
    expect(isDefaultDiscordAvatarUrl("https://cdn.discordapp.com/avatars/123/hash.png?size=128")).toBe(false);
  });

  test("keeps a previously known custom avatar instead of regressing to a default avatar", () => {
    const memory = new Map<string, string>();
    const custom = discordAvatarUrl("123", "hash", null);
    const fallback = discordAvatarUrl("123", null, null);

    const first = stabilizeCallWidgetParticipantAvatars([{ id: "123", name: "Doggy", avatarUrl: custom, speaking: false, self: false }], memory);
    expect(first[0]?.avatarUrl).toBe(custom);

    const second = stabilizeCallWidgetParticipantAvatars([{ id: "123", name: "Doggy", avatarUrl: fallback, speaking: true, self: false }], memory);
    expect(second[0]?.avatarUrl).toBe(custom);
    expect(second[0]?.speaking).toBe(true);
  });
});
