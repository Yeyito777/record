import { describe, expect, test } from "bun:test";

import { handleImageModalKey, imageModalLayout, renderImageModal, upgradeImageModal, type ImageModalState } from "./imagemodal";

function modal(): ImageModalState {
  return {
    filename: "desktop.png",
    image: {
      phase: "ready",
      attachmentId: "modal:a1",
      filename: "desktop.png",
      sourceUrl: "https://cdn.example/desktop.png",
      requestId: 1,
      imageId: 0x40000002,
      pngBase64: "cG5n",
      pixelWidth: 1920,
      pixelHeight: 1080,
    },
  };
}

describe("full-resolution image modal", () => {
  test("centers the largest aspect-correct placement inside the terminal", () => {
    const layout = imageModalLayout(modal(), 60, 180, 9, 18);
    expect(layout).toMatchObject({
      top: 4,
      left: 3,
      width: 176,
      height: 53,
      placement: { row: 6, col: 5, columns: 172, rows: 49, z: 2 },
    });
    const rendered = renderImageModal(modal(), 60, 180, 9, 18);
    expect(rendered.payload).toContain("desktop.png · 1920×1080");
    expect(rendered.payload).toContain("Enter or Esc to close");
    expect(rendered.placement).toEqual(layout?.placement ?? null);
  });

  test("Enter and Escape close while every other key is consumed", () => {
    expect(handleImageModalKey({ type: "enter" })).toEqual({ type: "close" });
    expect(handleImageModalKey({ type: "escape" })).toEqual({ type: "close" });
    expect(handleImageModalKey({ type: "char", char: "j" })).toEqual({ type: "handled" });
  });

  test("shows an enlarged resident preview while a slow full image loads", async () => {
    const viewer = modal();
    const full = viewer.image;
    viewer.image = { ...full, pixelWidth: 192, pixelHeight: 108 };
    viewer.loading = viewer.preview = true;
    const preview = viewer.image;
    let finish!: (image: typeof full) => void;
    const pending = upgradeImageModal(viewer, () => new Promise((resolve) => { finish = resolve; }), () => true);
    const rendered = renderImageModal(viewer, 60, 180, 9, 18);
    expect(rendered.payload).toContain("Loading full image");
    expect(rendered.placement?.image).toBe(preview);
    expect(rendered.placement?.columns).toBe(172);
    finish(full);
    await pending;
    expect(viewer.image).toBe(full);
    expect(viewer.loading).toBe(false);
    expect(viewer.preview).toBe(false);
  });

  test("a dismissed or replaced viewer cannot be upgraded by late work", async () => {
    const viewer = modal();
    const preview = viewer.image;
    let current = true;
    let finish!: (image: typeof preview) => void;
    const pending = upgradeImageModal(viewer, () => new Promise((resolve) => { finish = resolve; }), () => current);
    current = false;
    finish({ ...preview, imageId: preview.imageId + 1 });
    await pending;
    expect(viewer.image).toBe(preview);
  });

  test("conversion failure leaves a usable, closable preview", async () => {
    const viewer = modal();
    viewer.loading = viewer.preview = true;
    const preview = viewer.image;
    await expect(upgradeImageModal(viewer, async () => { throw new Error("offline"); }, () => true)).rejects.toThrow("offline");
    expect(viewer.loading).toBe(false);
    expect(viewer.image).toBe(preview);
    expect(renderImageModal(viewer, 60, 180).payload).toContain("Preview only");
  });
});
