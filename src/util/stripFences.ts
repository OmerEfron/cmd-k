/**
 * Takes the code out of a model answer.
 *
 * The prompts ask for exactly one fenced code block. Models sometimes add text
 * around it, so we use the first fenced block. If there is no fence, the whole
 * answer is treated as code.
 */
export function stripFences(answer: string): string {
  const text = answer.replace(/\r\n/g, "\n");
  const open = /^[ \t]*(`{3,}|~{3,})[^\n]*\n/m.exec(text);
  if (!open) {
    return trimBlankEdges(text);
  }

  const fence = open[1];
  const bodyStart = open.index + open[0].length;
  const rest = text.slice(bodyStart);
  // The closing fence is a line with at least as many fence characters.
  const close = new RegExp(`^[ \\t]*${fence[0]}{${fence.length},}[ \\t]*$`, "m").exec(rest);
  const body = close ? rest.slice(0, close.index) : rest;
  return trimBlankEdges(body);
}

/** Removes empty lines at the start and end. Keeps the indentation of the first code line. */
export function trimBlankEdges(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[0].trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.map((line) => (line.trim() === "" ? "" : line)).join("\n");
}
