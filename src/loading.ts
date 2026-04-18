/**
 * Shared loading spinner helpers.
 */

export const LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function loadingFrame(frameIndex: number): string {
  return LOADING_FRAMES[((frameIndex % LOADING_FRAMES.length) + LOADING_FRAMES.length) % LOADING_FRAMES.length] ?? LOADING_FRAMES[0];
}

export function loadingLabel(text: string, frameIndex: number): string {
  return `${loadingFrame(frameIndex)} ${text}`;
}
