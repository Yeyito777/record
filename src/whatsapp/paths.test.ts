import { describe, expect, test } from "bun:test";

import { getRecordWhatsAppPaths } from "./paths";

describe("Record WhatsApp paths", () => {
  test("uses a Record-owned XDG config directory", () => {
    expect(getRecordWhatsAppPaths({
      XDG_CONFIG_HOME: "/tmp/record-xdg",
      HOME: "/home/ignored",
    })).toEqual({
      directory: "/tmp/record-xdg/record/whatsapp",
      authDirectory: "/tmp/record-xdg/record/whatsapp/auth",
    });
  });

  test("falls back to HOME without referring to whatsapp-cli", () => {
    const paths = getRecordWhatsAppPaths({ HOME: "/home/person" });
    expect(paths.authDirectory).toBe("/home/person/.config/record/whatsapp/auth");
    expect(paths.authDirectory).not.toContain("whatsapp-cli");
  });

  test("rejects relative or unavailable config homes", () => {
    expect(() => getRecordWhatsAppPaths({ XDG_CONFIG_HOME: "relative", HOME: "/home/person" }))
      .toThrow("XDG_CONFIG_HOME must be an absolute path");
    expect(() => getRecordWhatsAppPaths({})).toThrow("Could not resolve");
  });
});
