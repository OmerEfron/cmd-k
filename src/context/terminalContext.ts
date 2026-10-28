import * as path from "path";
import * as vscode from "vscode";
import { TerminalContext } from "../prompts";

/**
 * Reads what we know about a terminal. Every part is optional:
 * shell type and working directory are only known in some setups.
 */
export function readTerminalContext(terminal: vscode.Terminal): TerminalContext {
  return {
    platform: process.platform,
    shell: detectShell(terminal),
    cwd: detectCwd(terminal),
  };
}

function detectShell(terminal: vscode.Terminal): string | undefined {
  // Detected type of this terminal (for example "zsh" or "pwsh").
  const detected = terminal.state?.shell;
  if (detected) {
    return detected;
  }
  // Fallback: the default shell of the editor. It may differ from this terminal.
  const fallback = vscode.env.shell;
  return fallback ? path.basename(fallback).replace(/\.exe$/i, "") : undefined;
}

function detectCwd(terminal: vscode.Terminal): string | undefined {
  const uri = terminal.shellIntegration?.cwd;
  if (uri) {
    return uri.scheme === "file" ? uri.fsPath : uri.path;
  }
  const cwd = (terminal.creationOptions as vscode.TerminalOptions | undefined)?.cwd;
  if (typeof cwd === "string") {
    return cwd;
  }
  if (cwd) {
    return cwd.fsPath;
  }
  return undefined;
}
