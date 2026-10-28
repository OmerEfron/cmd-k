import * as vscode from "vscode";
import { readContextConfig, readProviderSettings } from "../config";
import { buildEditorContext } from "../context/editorContext";
import { buildEditorMessages, buildFollowUpMessages, QuestionTurn } from "../prompts";
import { CancelledError, complete, ProviderError } from "../provider/openaiCompatible";
import { UserError } from "../ui/errors";
import { commonIndent, reindent } from "../util/reindent";
import { stripFences } from "../util/stripFences";
import { FenceStream, writableLines } from "../util/streamFence";
import { EditSessionManager } from "./editSession";
import { sameLines, SessionMode } from "./sessionHistory";

/** What the user selected, turned into the start of an edit session. */
export interface Target {
  mode: SessionMode;
  /** First line of the block (for "insert": the first new line). */
  startLine: number;
  originalLines: string[];
  hasSelection: boolean;
}

export function pickTarget(editor: vscode.TextEditor): Target {
  const selection = editor.selection;
  const doc = editor.document;

  if (!selection.isEmpty) {
    const startLine = selection.start.line;
    let endLine = selection.end.line;
    // A selection that ends at the start of a line does not include that line.
    if (selection.end.character === 0 && endLine > startLine) {
      endLine--;
    }
    const originalLines: string[] = [];
    for (let line = startLine; line <= endLine; line++) {
      originalLines.push(doc.lineAt(line).text);
    }
    return { mode: "edit", startLine, originalLines, hasSelection: true };
  }

  const cursorLine = selection.active.line;
  const current = doc.lineAt(cursorLine);
  if (current.isEmptyOrWhitespace) {
    // A blank line is replaced by the new code.
    return { mode: "blank", startLine: cursorLine, originalLines: [current.text], hasSelection: false };
  }
  // Otherwise the new code goes on new lines below the cursor line.
  return { mode: "insert", startLine: cursorLine + 1, originalLines: [], hasSelection: false };
}

export interface GenerateArgs {
  extension: vscode.ExtensionContext;
  sessions: EditSessionManager;
  uri: vscode.Uri;
  /** The visible editor of the document. It can change, for example after a tab switch. */
  getEditor(): vscode.TextEditor | undefined;
  instruction: string;
  /** Earlier questions and answers (when the user says "do it" after a question). */
  conversation?: QuestionTurn[];
  signal: AbortSignal;
  progress(text: string): void;
}

export type GenerateOutcome = "done" | "no-change";

const FLUSH_INTERVAL_MS = 50;

/**
 * Runs one request (a first prompt or a follow-up) and streams the new code into the document.
 *
 * Rules that keep the user's code safe:
 * - The document is only changed while the model writes, and every change can be undone in one step.
 * - If the request fails or is cancelled, the document is put back to what it showed before this request.
 * - If the user typed in the block or pressed Undo, the request stops and nothing more is written.
 */
export async function generateEdit(args: GenerateArgs): Promise<GenerateOutcome> {
  const { extension, sessions, uri, instruction, signal, progress } = args;

  const editor = args.getEditor();
  if (!editor) {
    throw new UserError("The editor is not visible. Open the file and try again.");
  }
  const settings = await readProviderSettings(extension.secrets);
  if (!settings || signal.aborted) {
    throw new CancelledError();
  }

  const doc = editor.document;
  let session = sessions.get(uri);
  if (session?.state === "generating") {
    throw new UserError("QuickK is already working on this file.");
  }
  const followUp = session?.state === "review";
  const lines = doc.getText().split(/\r?\n/);

  if (!session || !followUp) {
    const target = pickTarget(editor);
    session = sessions.create(uri, target.mode, target.startLine, target.originalLines);
  }
  const current = session;

  // Where the block is now and what the model should see around it.
  const green = sessions.greenLines(current);
  const originalCount = current.originalLines.length;
  const pendingLength = green
    ? current.mode === "edit"
      ? originalCount + green.length
      : green.length
    : current.mode === "edit"
      ? originalCount
      : current.mode === "blank"
        ? 1
        : 0;
  const baseLines = [
    ...lines.slice(0, current.startLine),
    ...current.originalLines,
    ...lines.slice(current.startLine + pendingLength),
  ];
  const { contextLines, maxContextChars } = readContextConfig();
  const context = buildEditorContext({
    lines: baseLines,
    beforeEnd: current.startLine,
    afterStart: current.startLine + (current.mode === "insert" ? 0 : originalCount),
    contextLines,
    maxContextChars,
  });

  const promptMode = current.mode === "edit" ? "edit" : "generate";
  const fileName = vscode.workspace.asRelativePath(doc.uri);
  const messages =
    followUp && green
      ? buildFollowUpMessages({
          mode: promptMode,
          fileName,
          languageId: doc.languageId,
          context,
          proposal: green.join("\n"),
          instructions: current.revisions.slice(0, current.current + 1).map((revision) => revision.instruction),
          instruction,
        })
      : buildEditorMessages({
          mode: promptMode,
          fileName,
          languageId: doc.languageId,
          instruction,
          context,
          conversation: args.conversation,
        });

  const indent = commonIndent(current.originalLines.join("\n"));
  const fixIndent = (text: string[]): string[] =>
    current.mode === "edit" && text.length > 0 ? reindent(text.join("\n"), indent).split("\n") : text;

  const controller = new AbortController();
  signal.addEventListener("abort", () => controller.abort(), { once: true });
  const runId = sessions.beginRun(current, () => controller.abort());
  const stillMine = () => sessions.isCurrentRun(current, runId);

  const fence = new FenceStream();
  const codeLines: string[] = [];
  let wroteOnce = false;
  let writeFailed = false;
  let flushing: Promise<void> = Promise.resolve();
  let lastFlush = 0;

  // Writes the lines that are complete so far. The last line is held back (see writableLines).
  const flush = async (): Promise<void> => {
    if (!stillMine()) {
      return;
    }
    const target = fixIndent(writableLines(codeLines));
    if (target.length === 0) {
      return;
    }
    const existing = sessions.greenLines(current);
    if (existing && sameLines(existing, target)) {
      return;
    }
    const liveEditor = args.getEditor();
    if (!liveEditor) {
      return;
    }
    const ok = await sessions.write(current, liveEditor, target, { before: !wroteOnce, after: false });
    wroteOnce = true;
    if (!ok && stillMine()) {
      writeFailed = true;
      controller.abort();
    }
  };

  try {
    progress("Waiting for the model...");
    const result = await complete(settings, messages, {
      signal: controller.signal,
      onDelta: (delta, total) => {
        codeLines.push(...fence.push(delta));
        progress(`Generating... (${total} characters)`);
        const now = Date.now();
        if (now - lastFlush >= FLUSH_INTERVAL_MS) {
          lastFlush = now;
          flushing = flushing.then(flush);
        }
      },
    });
    await flushing;

    if (!stillMine()) {
      // The user pressed Undo or typed in the block. The session manager already handled the document.
      throw new CancelledError();
    }
    if (result.finishReason === "length") {
      throw new ProviderError(
        "The answer was cut off because it reached the token limit (quickk.maxTokens). Nothing was changed.",
        "truncated"
      );
    }
    const finalText = stripFences(result.text);
    if (finalText.trim() === "") {
      throw new ProviderError("The model returned no code. Nothing was changed.", "empty");
    }
    const finalLines = fixIndent(finalText.split("\n"));

    const unchanged = followUp ? sameLines(finalLines, green ?? []) : current.mode === "edit" && sameLines(finalLines, current.originalLines);
    if (unchanged) {
      await sessions.restore(current, args.getEditor() ?? editor);
      return "no-change";
    }

    const finalEditor = args.getEditor();
    if (!finalEditor) {
      throw new UserError("The editor was closed before the code could be shown.");
    }
    // The last write closes the undo step of this request.
    if (!(await sessions.write(current, finalEditor, finalLines, { before: !wroteOnce, after: true }))) {
      throw new UserError("The file changed before the code could be shown. Nothing was changed.");
    }
    if (!stillMine()) {
      throw new CancelledError();
    }
    sessions.complete(current, instruction, finalLines);
    return "done";
  } catch (error) {
    await flushing.catch(() => undefined);
    // Put the document back. This does nothing when Undo or the user already took care of it.
    const liveEditor = args.getEditor();
    if (liveEditor) {
      await sessions.restore(current, liveEditor);
    } else {
      sessions.remove(uri);
    }
    if (writeFailed && !(error instanceof UserError)) {
      throw new UserError("The file changed while the model was writing. Nothing was changed.");
    }
    throw error;
  }
}
