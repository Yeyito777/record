#!/usr/bin/env bun
/**
 * Regenerate the sidebar's provider root icons (Direct Messages, WhatsApp,
 * Instagram) from the Simple Icons glyphs in source/ (CC0, simple-icons 16.35.0).
 *
 *   bun assets/sidebar/generate.ts
 *
 * Each glyph is drawn white on its brand background in the same rounded tile
 * (22% corner radius) as server icons, then rendered to a PNG with ImageMagick
 * (librsvg). The PNGs are committed; Record never runs this at runtime.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dir;
/** Matches SIDEBAR_ICON_PIXELS: server icons are 64 px too. */
const SIZE = 64;
const RADIUS = SIZE * 0.22;
/** The 24-unit glyph fills this share of the tile. */
const GLYPH = 0.6;

const ICONS: Array<{ name: string; out: string; background: string }> = [
  { name: "discord", out: "direct-messages.png", background: `<rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="#5865F2"/>` },
  { name: "whatsapp", out: "whatsapp.png", background: `<rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="#25D366"/>` },
  {
    name: "instagram",
    out: "instagram.png",
    // Instagram's app-icon gradient: warm yellow at the bottom left to violet at the top right.
    background: `<defs><radialGradient id="ig" cx="0.3" cy="1.07" r="1.5">
      <stop offset="0" stop-color="#FDF497"/><stop offset="0.05" stop-color="#FDF497"/>
      <stop offset="0.45" stop-color="#FD5949"/><stop offset="0.6" stop-color="#D6249F"/>
      <stop offset="0.9" stop-color="#285AEB"/></radialGradient></defs>
      <rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="url(#ig)"/>`,
  },
];

const work = mkdtempSync(join(tmpdir(), "record-sidebar-icons-"));
try {
  for (const icon of ICONS) {
    const source = readFileSync(join(HERE, "source", `${icon.name}.svg`), "utf8");
    const path = /<path d="([^"]+)"/.exec(source)?.[1];
    if (!path) throw new Error(`${icon.name}.svg has no path`);
    const scale = (SIZE * GLYPH) / 24;
    const offset = (SIZE - 24 * scale) / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
${icon.background}
<path transform="translate(${offset} ${offset}) scale(${scale})" fill="#FFFFFF" d="${path}"/>
</svg>`;
    const tile = join(work, `${icon.name}.svg`);
    writeFileSync(tile, svg);
    const out = join(HERE, icon.out);
    const result = spawnSync("magick", ["-background", "none", `rsvg:${tile}`, "-strip", "-define", "png:color-type=6", `PNG32:${out}`], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`magick failed for ${icon.name}`);
    console.log(out);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
