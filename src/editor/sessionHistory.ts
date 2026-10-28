// Pure logic for edit sessions: which text the document shows in each state,
// how to recognise a state after Undo / Redo, and how to follow edits.
// This file must not import "vscode", so it can be unit tested with plain Node.

/**
 * edit:   the selected lines stay (red) and the new lines are added below them (green).
 * insert: new lines are added below a code line (nothing is replaced).
 * blank:  new lines take the place of a blank line.
 */
export type SessionMode = "edit" | "insert" | "blank";

export interface Revision {
  instruction: string;
  /** The new code of this revision. */
  lines: string[];
}

export interface SessionShape {
  mode: SessionMode;
  /** First line of the block in the document. For "insert" this is the first new line. */
  startLine: number;
  /** edit: the selected lines. blank: the whitespace of the line. insert: empty. */
  originalLines: string[];
  revisions: Revision[];
}

/** The lines the document shows from `startLine` on while revision `lines` is pending. */
export function pendingLines(session: Pick<SessionShape, "mode" | "originalLines">, lines: string[]): string[] {
  return session.mode === "edit" ? [...session.originalLines, ...lines] : lines;
}

/**
 * Finds the revision whose pending text is in the document right now.
 * Used after Undo / Redo. The newest matching revision wins.
 */
export function matchRevision(
  session: SessionShape,
  getLine: (line: number) => string | undefined
): number | undefined {
  for (let index = session.revisions.length - 1; index >= 0; index--) {
    const expected = pendingLines(session, session.revisions[index].lines);
    let same = true;
    for (let i = 0; i < expected.length; i++) {
      if (getLine(session.startLine + i) !== expected[i]) {
        same = false;
        break;
      }
    }
    if (same) {
      return index;
    }
  }
  return undefined;
}

/** The biggest number of lines that the block can have in any known state. */
export function maxRegionLength(session: SessionShape, extraLines = 0): number {
  let longest = Math.max(session.originalLines.length, extraLines);
  for (const revision of session.revisions) {
    longest = Math.max(longest, pendingLines(session, revision.lines).length);
  }
  return longest;
}

export interface LineChange {
  startLine: number;
  endLine: number;
  /** Number of line breaks in the inserted text. */
  addedLines: number;
}

export interface ChangeEffect {
  /** How many lines the block moved because of changes above it. */
  shift: number;
  /** Something changed inside the block. */
  touched: boolean;
  /** A change starts above the block and ends in it: the position is not reliable any more. */
  spanning: boolean;
}

/** Sorts the changes of one edit event by where they happen relative to the block. */
export function classifyChanges(startLine: number, length: number, changes: LineChange[]): ChangeEffect {
  const effect: ChangeEffect = { shift: 0, touched: false, spanning: false };
  for (const change of changes) {
    if (change.endLine < startLine) {
      effect.shift += change.addedLines - (change.endLine - change.startLine);
    } else if (change.startLine < startLine) {
      effect.spanning = true;
    } else if (change.startLine > startLine + length - 1) {
      // Below the block: nothing to do.
    } else {
      effect.touched = true;
    }
  }
  return effect;
}

export function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** True when `lines` starts with `prefix` and has more lines. */
export function extendsLines(prefix: string[], lines: string[]): boolean {
  if (lines.length <= prefix.length) {
    return false;
  }
  return prefix.every((line, i) => lines[i] === line);
}
