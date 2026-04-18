/**
 * Undo stack for the single-line token editor.
 */

const MAX_UNDO = 200;

export interface Snapshot {
  buffer: string;
  cursor: number;
}

export interface UndoState {
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  insertEntry: Snapshot | null;
}

export function createUndoState(): UndoState {
  return { undoStack: [], redoStack: [], insertEntry: null };
}

export function pushUndo(undo: UndoState, buffer: string, cursor: number): void {
  undo.undoStack.push({ buffer, cursor });
  if (undo.undoStack.length > MAX_UNDO) undo.undoStack.shift();
  undo.redoStack.length = 0;
}

export function markInsertEntry(undo: UndoState, buffer: string, cursor: number): void {
  undo.insertEntry = { buffer, cursor };
}

export function commitInsertSession(undo: UndoState, currentBuffer: string): void {
  if (undo.insertEntry && undo.insertEntry.buffer !== currentBuffer) {
    undo.undoStack.push(undo.insertEntry);
    if (undo.undoStack.length > MAX_UNDO) undo.undoStack.shift();
    undo.redoStack.length = 0;
  }
  undo.insertEntry = null;
}

export function undo(undoState: UndoState, buffer: string, cursor: number): Snapshot | null {
  if (undoState.undoStack.length === 0) return null;
  undoState.redoStack.push({ buffer, cursor });
  return undoState.undoStack.pop() ?? null;
}

export function redo(undoState: UndoState, buffer: string, cursor: number): Snapshot | null {
  if (undoState.redoStack.length === 0) return null;
  undoState.undoStack.push({ buffer, cursor });
  return undoState.redoStack.pop() ?? null;
}
