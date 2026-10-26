import { describe, expect, test } from "bun:test";

import {
  handleImageModalKey,
  imageModalFrame,
  imageModalLayout,
  openImageModalState,
  renderImageModal,
  upgradeImageModal,
  type ImageModalState,
} from "./imagemodal";

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
  test("keeps the picture's shape in the viewer, wide or tall", () => {
    for (const [pixelWidth, pixelHeight] of [[4000, 700], [1170, 6000], [1080, 566], [100, 100], [3000, 400]] as const) {
      const viewer = modal();
      viewer.image = { ...viewer.image, pixelWidth, pixelHeight };
      viewer.frame = { pixelWidth, pixelHeight, enlarge: true };
      const { columns, rows } = imageModalLayout(viewer, 51, 239, 8, 20)!.placement;
      expect(Math.abs((columns * 8) / (rows * 20) / (pixelWidth / pixelHeight) - 1)).toBeLessThan(0.03);
    }
  });

  test("centers the largest aspect-correct placement inside the terminal", () => {
    const layout = imageModalLayout(modal(), 60, 180, 9, 18);
    expect(layout).toMatchObject({
      top: 5,
      left: 3,
      width: 175,
      height: 52,
      // 171x48 cells of 9x18 px: 1539x864, 16:9 to 0.2% (172x49 was 1.3% off).
      placement: { row: 7, col: 5, columns: 171, rows: 48, z: 2 },
    });
    const rendered = renderImageModal(modal(), 60, 180, 9, 18);
    expect(rendered.payload).toContain("desktop.png · 1920×1080");
    expect(rendered.payload).toContain("Enter or Esc to close");
    expect(rendered.placement).toEqual(layout?.placement ?? null);
  });

  test("in an album, l/→ and h/← step to the next and previous photo; the title says which", () => {
    expect(handleImageModalKey({ type: "char", char: "l" })).toEqual({ type: "step", by: 1 });
    expect(handleImageModalKey({ type: "right" })).toEqual({ type: "step", by: 1 });
    expect(handleImageModalKey({ type: "char", char: "h" })).toEqual({ type: "step", by: -1 });
    expect(handleImageModalKey({ type: "left" })).toEqual({ type: "step", by: -1 });
    const viewer = { ...modal(), album: { index: 1, count: 3 } };
    expect(renderImageModal(viewer, 60, 180, 9, 18).payload).toContain("desktop.png · 1920×1080 · 2 / 3");
    expect(renderImageModal(viewer, 60, 180, 9, 18).payload).toContain("h / l");
  });

  test("Enter and Escape close while every other key is consumed", () => {
    expect(handleImageModalKey({ type: "enter" })).toEqual({ type: "close" });
    expect(handleImageModalKey({ type: "escape" })).toEqual({ type: "close" });
    expect(handleImageModalKey({ type: "char", char: "j" })).toEqual({ type: "handled" });
  });

  test("shows the resident preview at the final size while a slow full image loads", async () => {
    const full = modal().image;
    const preview = { ...full, imageId: full.imageId - 1, pixelWidth: 192, pixelHeight: 108 };
    const viewer = openImageModalState({ filename: "desktop.png", width: 1920, height: 1080 }, preview);
    let finish!: (image: typeof full) => void;
    const pending = upgradeImageModal(viewer, () => new Promise((resolve) => { finish = resolve; }), () => true);
    const rendered = renderImageModal(viewer, 60, 180, 9, 18);
    expect(rendered.payload).toContain("Loading full image");
    expect(rendered.payload).toContain("desktop.png · 1920×1080");
    expect(rendered.placement?.image).toBe(preview);
    expect(rendered.placement?.columns).toBe(171);
    finish(full);
    await pending;
    expect(viewer.image).toBe(full);
    expect(viewer.loading).toBe(false);
    expect(viewer.preview).toBe(false);
  });

  // Owner report: "when I open an image it sometimes flickers and resizes".
  // The preview used to fill the viewer, then the full image snapped to its
  // native size. Every shape must keep one geometry from open to upgrade.
  test.each([
    ["tiny, known from unbounded preview", { pixelWidth: 40, pixelHeight: 30, sourcePixelWidth: 40, sourcePixelHeight: 30 }, {}, { pixelWidth: 40, pixelHeight: 30 }],
    ["medium, known from metadata", { pixelWidth: 384, pixelHeight: 256 }, { width: 900, height: 600 }, { pixelWidth: 900, pixelHeight: 600 }],
    ["huge, bounded preview", { pixelWidth: 341, pixelHeight: 256 }, { width: 4000, height: 3000 }, { pixelWidth: 4000, pixelHeight: 3000 }],
    ["portrait", { pixelWidth: 109, pixelHeight: 256 }, { width: 600, height: 1400 }, { pixelWidth: 600, pixelHeight: 1400 }],
    ["landscape", { pixelWidth: 576, pixelHeight: 180 }, { width: 1600, height: 500 }, { pixelWidth: 1600, pixelHeight: 500 }],
    ["gif first frame", { pixelWidth: 300, pixelHeight: 200, sourcePixelWidth: 300, sourcePixelHeight: 200 }, {}, { pixelWidth: 300, pixelHeight: 200 }],
    ["unknown source size", { pixelWidth: 576, pixelHeight: 180 }, {}, { pixelWidth: 1000, pixelHeight: 313 }],
  ] as const)("%s: upgrading the pixels never resizes the viewer", async (_name, previewSize, metadata, fullSize) => {
    const base = modal().image;
    const preview = { ...base, imageId: 0x40000010, ...previewSize };
    const full = { ...base, imageId: 0x40000011, ...fullSize };
    const viewer = openImageModalState({ filename: "x.png", ...metadata }, preview);
    const geometry = () => {
      const layout = imageModalLayout(viewer, 51, 239, 8, 20)!;
      const { row, col, columns, rows, z } = layout.placement;
      return { box: [layout.top, layout.left, layout.width, layout.height], image: { row, col, columns, rows, z } };
    };
    const opened = geometry();
    await upgradeImageModal(viewer, async () => full, () => true);
    expect(viewer.image).toBe(full);
    expect(geometry()).toEqual(opened);
  });

  test("known small images open at native size instead of filling the viewer", () => {
    const tiny = { ...modal().image, pixelWidth: 40, pixelHeight: 30, sourcePixelWidth: 40, sourcePixelHeight: 30 };
    const layout = imageModalLayout(openImageModalState({ filename: "tiny.png" }, tiny), 51, 239, 8, 20);
    // 40x30 px in 8x20 cells: 3x1 keeps its shape (5x2 stretched it 33% taller).
    expect(layout?.placement).toMatchObject({ columns: 3, rows: 1 });
  });

  test("metadata that does not match the decoded preview shape is ignored", () => {
    const preview = { pixelWidth: 192, pixelHeight: 256 };
    // EXIF-rotated photos can report pre-rotation width and height.
    expect(imageModalFrame(preview, { width: 4032, height: 3024 }))
      .toEqual({ pixelWidth: 192, pixelHeight: 256, enlarge: true });
    expect(imageModalFrame(preview, { width: 3024, height: 4032 }))
      .toEqual({ pixelWidth: 3024, pixelHeight: 4032, enlarge: false });
    // A source can never be smaller than its own bounded preview.
    expect(imageModalFrame(preview, { width: 96, height: 128 }).enlarge).toBe(true);
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
