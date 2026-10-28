// Builds a bounded piece of context around the code that the user works on.
// This file must not import "vscode", so it can be unit tested with plain Node.

export interface EditorContextInput {
  /** All lines of the document, without line breaks. */
  lines: string[];
  /** Lines [0, beforeEnd) are "before". */
  beforeEnd: number;
  /** Lines [afterStart, end) are "after". Lines [beforeEnd, afterStart) are the selection. */
  afterStart: number;
  contextLines: number;
  maxContextChars: number;
}

export interface EditorContext {
  before: string;
  selection: string;
  after: string;
  /** Import lines from the top of the file that are not already inside `before`. */
  imports: string;
}

const IMPORT_PATTERN =
  /^\s*(?:import\s|export\s.+\sfrom\s|from\s+\S+\s+import\s|(?:const|let|var)\s+.+=\s*require\(|#include\s|using\s|use\s|package\s|require\s|@import\s)/;

const MAX_IMPORT_SCAN_LINES = 200;
const MAX_IMPORT_LINES = 40;
const MAX_IMPORT_CHARS = 2000;

export function buildEditorContext(input: EditorContextInput): EditorContext {
  const { lines, beforeEnd, afterStart, contextLines, maxContextChars } = input;

  const selection = lines.slice(beforeEnd, afterStart).join("\n");

  // The selection is always sent in full. The rest shares what is left of the budget.
  const budget = Math.max(0, maxContextChars - selection.length);
  const beforeBudget = Math.floor(budget / 2);
  const afterBudget = budget - beforeBudget;

  const beforeStart = Math.max(0, beforeEnd - contextLines);
  const afterEnd = Math.min(lines.length, afterStart + contextLines);

  const before = takeClosestLines(lines.slice(beforeStart, beforeEnd), beforeBudget, "end");
  const after = takeClosestLines(lines.slice(afterStart, afterEnd), afterBudget, "start");

  const imports = collectImports(lines, beforeEnd - before.count);

  return {
    before: before.text,
    selection,
    after: after.text,
    imports,
  };
}

/**
 * Keeps whole lines that are closest to the selection until the character budget is used.
 * `anchor` tells which end of the list touches the selection.
 */
function takeClosestLines(lines: string[], budget: number, anchor: "start" | "end"): { text: string; count: number } {
  const kept: string[] = [];
  let used = 0;
  const ordered = anchor === "end" ? [...lines].reverse() : lines;
  for (const line of ordered) {
    const cost = line.length + 1;
    if (used + cost > budget) {
      break;
    }
    kept.push(line);
    used += cost;
  }
  if (anchor === "end") {
    kept.reverse();
  }
  return { text: kept.join("\n"), count: kept.length };
}

function collectImports(lines: string[], firstLineOfBefore: number): string {
  const found: string[] = [];
  let chars = 0;
  const limit = Math.min(lines.length, MAX_IMPORT_SCAN_LINES, Math.max(0, firstLineOfBefore));
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (!IMPORT_PATTERN.test(line)) {
      continue;
    }
    if (found.length >= MAX_IMPORT_LINES || chars + line.length + 1 > MAX_IMPORT_CHARS) {
      break;
    }
    found.push(line);
    chars += line.length + 1;
  }
  return found.join("\n");
}
