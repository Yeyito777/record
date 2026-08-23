import { describe, expect, test } from "bun:test";

import { handleImageModalKey, imageModalLayout, renderImageModal, type ImageModalState } from "./imagemodal";

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
      placement: { row: 6, col: 5, columns: 172, rows: 49 },
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
});
