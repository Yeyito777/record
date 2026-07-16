import { describe, expect, test } from "bun:test";

import {
  QR_QUIET_ZONE_MODULES,
  measureUnicodeQr,
  renderUnicodeQr,
} from "./qr";

const SGR_RE = /\x1b\[[0-9;]*m/g;

function plainLines(lines: string[]): string[] {
  return lines.map((line) => line.replace(SGR_RE, ""));
}

describe("Unicode WhatsApp QR rendering", () => {
  test("includes the standard four-module quiet zone at deterministic dimensions", () => {
    const minimum = measureUnicodeQr("hello");
    const rendered = renderUnicodeQr("hello", minimum.width, minimum.height);

    expect(QR_QUIET_ZONE_MODULES).toBe(4);
    expect(minimum).toEqual({
      moduleCount: 21,
      scale: 1,
      width: 29,
      height: 15,
      quietZone: 4,
    });
    expect(rendered).not.toBeNull();

    const lines = plainLines(rendered!.lines);
    expect(lines).toHaveLength(15);
    expect(lines.every((line) => line.length === 29)).toBe(true);
    expect(lines.slice(0, 2)).toEqual([" ".repeat(29), " ".repeat(29)]);
    expect(lines.slice(-2)).toEqual([" ".repeat(29), " ".repeat(29)]);
    expect(lines.every((line) => line.startsWith(" ".repeat(4)) && line.endsWith(" ".repeat(4)))).toBe(true);
  });

  test("produces stable half-block output for a fixed raw value", () => {
    const rendered = renderUnicodeQr("hello", 29, 15);
    expect(rendered).not.toBeNull();
    expect(plainLines(rendered!.lines)).toEqual([
      "                             ",
      "                             ",
      "    █▀▀▀▀▀█ ▄█▀   █▀▀▀▀▀█    ",
      "    █ ███ █  ▀▄█▀ █ ███ █    ",
      "    █ ▀▀▀ █ ▀▀  █ █ ▀▀▀ █    ",
      "    ▀▀▀▀▀▀▀ ▀ █▄█ ▀▀▀▀▀▀▀    ",
      "    ▀ █ █▄▀  ▀▄▀  ▄ ▀  █▄    ",
      "    ▄█ ▀▄ ▀ ▀▀▀ ▀ ▄ ▀▀▀█▀    ",
      "     ▀▀ ▀ ▀▀▄▄█▄▀▄▀▄▀ ▄▄▄    ",
      "    █▀▀▀▀▀█   ██▄█▀█▄ ▀▀▀    ",
      "    █ ███ █ ▀▄▀▀ ▀██  ▄█▀    ",
      "    █ ▀▀▀ █ ▀█▀ ▀ ▄ █ ▀▄▀    ",
      "    ▀▀▀▀▀▀▀ ▀▀▀ ▀ ▀▀   ▀▀    ",
      "                             ",
      "                             ",
    ]);
    expect(renderUnicodeQr("hello", 29, 15)).toEqual(rendered);
  });

  test("chooses the largest whole-number scale that fits", () => {
    const rendered = renderUnicodeQr("hello", 87, 44);

    expect(rendered).not.toBeNull();
    expect(rendered!.scale).toBe(3);
    expect(rendered!.width).toBe(87);
    expect(rendered!.height).toBe(44);
    expect(plainLines(rendered!.lines).every((line) => line.length === 87)).toBe(true);
  });

  test("refuses to crop a QR when scale one cannot fit", () => {
    const minimum = measureUnicodeQr("hello");

    expect(renderUnicodeQr("hello", minimum.width - 1, minimum.height)).toBeNull();
    expect(renderUnicodeQr("hello", minimum.width, minimum.height - 1)).toBeNull();
  });
});
