import { stripFences } from "./stripFences";

export class CommandFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandFormatError";
  }
}

/**
 * Turns a model answer into one safe line for the terminal.
 *
 * Safety rule: the result never contains a line break or other control
 * character. A line break could run the command, and QuickK never runs commands.
 */
export function normalizeCommand(answer: string): string {
  let text = stripFences(answer).trim();
  // Models sometimes add a prompt sign or inline backticks.
  text = text.replace(/^`([^`\n]+)`$/, "$1").replace(/^[$#]\s+/, "");

  if (text === "") {
    throw new CommandFormatError("The model did not return a command.");
  }

  if (text.includes("\n")) {
    // Join lines that end with a line continuation: \ (POSIX), ` (PowerShell) or ^ (cmd).
    const lines = text.split("\n").map((line) => line.trimEnd());
    const lastIndex = lines.length - 1;
    const joinable = lines.every((line, index) => index === lastIndex || /[\\`^]$/.test(line));
    if (!joinable) {
      throw new CommandFormatError("The model returned more than one command. Try a more specific request.");
    }
    text = lines
      .map((line, index) => (index === lastIndex ? line.trim() : line.slice(0, -1).trim()))
      .join(" ");
  }

  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(text)) {
    throw new CommandFormatError("The command contains control characters, so it was not inserted.");
  }
  return text;
}
