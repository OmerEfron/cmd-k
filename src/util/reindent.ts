/** Leading spaces and tabs of a line. */
export function leadingWhitespace(line: string): string {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0] : "";
}

/** The smallest indentation among lines that are not empty. */
export function commonIndent(text: string): string {
  let result: string | undefined;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const indent = leadingWhitespace(line);
    if (result === undefined || indent.length < result.length) {
      result = indent;
    }
  }
  return result ?? "";
}

/**
 * Moves a block of code to a new base indentation.
 * The relative indentation inside the block stays the same.
 */
export function reindent(text: string, targetIndent: string): string {
  const current = commonIndent(text);
  if (current === targetIndent) {
    return text;
  }
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") {
        return "";
      }
      const withoutBase = line.startsWith(current) ? line.slice(current.length) : line.trimStart();
      return targetIndent + withoutBase;
    })
    .join("\n");
}
