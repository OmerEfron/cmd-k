// Reads a streamed model answer and returns the code lines as soon as they are complete.
// This file must not import "vscode", so it can be unit tested with plain Node.

const OPEN_FENCE = /^[ \t]*(`{3,}|~{3,})[^\n]*$/;

type State = "start" | "inside" | "plain" | "done";

/**
 * Incremental version of `stripFences`.
 *
 * The prompts ask for one fenced code block. While the answer streams in, we
 * skip the opening fence, return code lines, and stop at the closing fence.
 * If the answer does not start with a fence, all lines are treated as code.
 *
 * The streamed lines are only a preview. When the answer is complete, the
 * caller compares them with `stripFences(fullText)`, which is the final result.
 */
export class FenceStream {
  private buffer = "";
  private state: State = "start";
  private fence = "";

  /** Adds text. Returns the new code lines that are complete. */
  push(text: string): string[] {
    this.buffer += text.replace(/\r\n/g, "\n");
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.consume(line, lines);
      index = this.buffer.indexOf("\n");
    }
    return lines;
  }

  /** Call at the end of the stream. Returns the last line, which has no line break. */
  finish(): string[] {
    const lines: string[] = [];
    if (this.buffer !== "") {
      const line = this.buffer;
      this.buffer = "";
      this.consume(line, lines);
    }
    return lines;
  }

  private consume(line: string, lines: string[]): void {
    switch (this.state) {
      case "start": {
        const open = OPEN_FENCE.exec(line);
        if (open) {
          this.fence = open[1];
          this.state = "inside";
        } else if (line.trim() !== "") {
          this.state = "plain";
          lines.push(line);
        }
        return;
      }
      case "plain":
        lines.push(line);
        return;
      case "inside":
        if (this.isClosingFence(line)) {
          this.state = "done";
        } else {
          lines.push(line);
        }
        return;
      case "done":
        return;
    }
  }

  private isClosingFence(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.length >= this.fence.length && trimmed === this.fence[0].repeat(trimmed.length);
  }
}

/**
 * Chooses which lines may be written to the editor now.
 *
 * - Blank lines at the start and the end are never written.
 * - The last line is held back, so the final write is always a real edit
 *   (this closes the undo step).
 */
export function writableLines(codeLines: string[]): string[] {
  let start = 0;
  while (start < codeLines.length && codeLines[start].trim() === "") {
    start++;
  }
  let end = codeLines.length;
  while (end > start && codeLines[end - 1].trim() === "") {
    end--;
  }
  const trimmed = codeLines.slice(start, end);
  return trimmed.slice(0, Math.max(0, trimmed.length - 1));
}
