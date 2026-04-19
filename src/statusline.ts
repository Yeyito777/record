/**
 * Status line layout engine.
 *
 * Composes status blocks side-by-side below the input prompt.
 * Blocks are built by individual builders in statusblocks/.
 * When the terminal is too narrow, lower-priority blocks are dropped.
 */

import type { AppState } from "./state";
import { theme } from "./theme";

import { accountBlock } from "./statusblocks/account";
import { presenceBlock } from "./statusblocks/presence";

export interface StatusBlock {
  id: string;
  priority: number;
  width: number;
  height: number;
  rows: string[];
}

type BlockBuilder = (state: AppState) => StatusBlock | null;

const BLOCK_BUILDERS: BlockBuilder[] = [
  accountBlock,
  presenceBlock,
];

const DELIMITER_WIDTH = 3; // " │ "

function layoutBlocks(state: AppState, cols: number): StatusBlock[] {
  const candidates: { block: StatusBlock; position: number }[] = [];
  for (let i = 0; i < BLOCK_BUILDERS.length; i++) {
    const block = BLOCK_BUILDERS[i](state);
    if (block) candidates.push({ block, position: i });
  }

  const byPriority = [...candidates].sort((a, b) => b.block.priority - a.block.priority);

  const selectedPositions = new Set<number>();
  let used = 0;
  for (const { block, position } of byPriority) {
    const need = selectedPositions.size === 0 ? block.width : DELIMITER_WIDTH + block.width;
    if (used + need <= cols) {
      selectedPositions.add(position);
      used += need;
    }
  }

  return candidates
    .filter((candidate) => selectedPositions.has(candidate.position))
    .map((candidate) => candidate.block);
}

function composeRow(blocks: StatusBlock[], rowIndex: number, cols: number): string {
  let out = "";
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) out += `${theme.accent} │ `;
    const block = blocks[i];
    out += rowIndex < block.height ? block.rows[rowIndex] : " ".repeat(block.width);
  }

  let usedCols = 0;
  for (let i = 0; i < blocks.length; i++) {
    usedCols += blocks[i].width;
    if (i > 0) usedCols += DELIMITER_WIDTH;
  }
  const remaining = cols - usedCols;
  if (remaining > 0) out += " ".repeat(remaining);
  out += theme.reset;
  return out;
}

export interface StatusLineResult {
  height: number;
  lines: string[];
}

export function renderStatusLine(state: AppState, cols: number): StatusLineResult {
  const blocks = layoutBlocks(state, cols);
  if (blocks.length === 0) return { height: 0, lines: [] };

  const height = Math.max(...blocks.map((block) => block.height));
  const lines: string[] = [];
  for (let i = 0; i < height; i++) {
    lines.push(composeRow(blocks, i, cols));
  }
  return { height, lines };
}
