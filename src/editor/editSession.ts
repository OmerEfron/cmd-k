import * as vscode from "vscode";
import {
  classifyChanges,
  extendsLines,
  LineChange,
  matchRevision,
  maxRegionLength,
  Revision,
  sameLines,
  SessionMode,
} from "./sessionHistory";

/**
 * generating: the model writes. New code is streamed into the document.
 * review:     a proposal waits for Accept or Reject.
 * detached:   the user edited the block. QuickK stopped, the file was left as it is.
 * closed:     the user accepted or rejected. We keep the session, so Undo can bring the review back.
 */
export type SessionState = "generating" | "review" | "detached" | "closed";

/**
 * One AI edit of one block of code, from the first prompt to the decision of the user.
 *
 * The new code is really written into the document, so the user sees it in the editor:
 *
 *   edit:   [old lines (red)] [new lines (green)]   accept: delete old lines, reject: delete new lines
 *   insert: [code line] [new lines (green)]         accept: keep, reject: delete new lines
 *   blank:  [new lines (green)] instead of a blank line   reject: write the blank line back
 *
 * Only `startLine` is stored. All other positions are derived from the document text
 * at the moment we need them.
 *
 * Undo and Redo: QuickK never changes the document because of an Undo or Redo. It only
 * looks at the text that the Undo produced and shows or hides its review to match it.
 */
export interface Session {
  uri: vscode.Uri;
  mode: SessionMode;
  startLine: number;
  originalLines: string[];
  revisions: Revision[];
  /** Index of the revision that is shown. -1 while the first revision is generated. */
  current: number;
  state: SessionState;
  /** New code that is in the document now while generating. Undefined: nothing written yet. */
  written?: string[];
  /** New code of the revision before this one, while a follow-up is generated. */
  prior?: string[];
  /** A running generation stops when this number changes. */
  runId: number;
  cancel?: () => void;
}

export type Decision = "accept" | "reject";

export interface SessionChange {
  uri: vscode.Uri;
  session: Session | undefined;
}

const CONTEXT_KEY = "quickk.pending";

export class EditSessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<SessionChange>();
  private readonly removedDecoration: vscode.TextEditorDecorationType;
  private readonly addedDecoration: vscode.TextEditorDecorationType;
  private readonly workingDecoration: vscode.TextEditorDecorationType;
  /** Greater than zero while QuickK itself edits the document. */
  private applying = 0;

  /** Fires when a session changes. `session` is undefined when it was removed. */
  readonly onDidChange = this.changed.event;

  constructor() {
    this.removedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.addedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    // "The model is working here": a soft background and a colored bar at the left.
    this.workingDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
      borderStyle: "solid",
      borderWidth: "0 0 0 3px",
      borderColor: new vscode.ThemeColor("focusBorder"),
    });

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.remove(doc.uri)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContextKey())
    );
    this.updateContextKey();
  }

  dispose(): void {
    this.removedDecoration.dispose();
    this.addedDecoration.dispose();
    this.workingDecoration.dispose();
    this.changed.dispose();
    this.disposables.forEach((d) => d.dispose());
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
  }

  // ---------------------------------------------------------------- lookup

  get(uri: vscode.Uri): Session | undefined {
    return this.sessions.get(uri.toString());
  }

  /** True when a proposal waits for the decision of the user. */
  isPending(uri: vscode.Uri): boolean {
    return this.get(uri)?.state === "review";
  }

  /** True when the model is writing code for this document. */
  isGenerating(uri: vscode.Uri): boolean {
    return this.get(uri)?.state === "generating";
  }

  // ---------------------------------------------------------------- generate

  /** Starts a new session. An older session of the same document is forgotten. */
  create(uri: vscode.Uri, mode: SessionMode, startLine: number, originalLines: string[]): Session {
    const session: Session = {
      uri,
      mode,
      startLine,
      originalLines,
      revisions: [],
      current: -1,
      state: "generating",
      runId: 0,
    };
    this.sessions.set(uri.toString(), session);
    this.afterChange(session.uri, session);
    return session;
  }

  /** Marks the start of a generation (the first prompt or a follow-up). Returns its id. */
  beginRun(session: Session, cancel: () => void): number {
    session.runId++;
    session.state = "generating";
    session.written = undefined;
    session.prior = session.current >= 0 ? session.revisions[session.current].lines : undefined;
    session.cancel = cancel;
    this.afterChange(session.uri, session);
    return session.runId;
  }

  /** True when the generation `runId` still owns the session. */
  isCurrentRun(session: Session, runId: number): boolean {
    return session.runId === runId && session.state === "generating" && this.sessions.get(session.uri.toString()) === session;
  }

  /** The new code that is in the document now. */
  greenLines(session: Session): string[] | undefined {
    if (session.state === "generating") {
      return session.written ?? session.prior;
    }
    if (session.state === "review" && session.current >= 0) {
      return session.revisions[session.current].lines;
    }
    return undefined;
  }

  /**
   * Writes new code into the document so that the green block shows `lines`.
   * Only appends when it can. The first write of a run starts a new undo step,
   * and `after: true` closes it.
   */
  async write(
    session: Session,
    editor: vscode.TextEditor,
    lines: string[],
    stops: { before: boolean; after: boolean }
  ): Promise<boolean> {
    if (session.state !== "generating") {
      return false;
    }
    const doc = editor.document;
    const existing = session.written ?? session.prior;
    if (existing && sameLines(existing, lines)) {
      session.written = lines;
      return true;
    }

    const eol = eolOf(doc);
    const text = toEol(lines.join("\n"), eol);
    const greenStart = this.greenStart(session);
    const separator = this.separator(session, doc);
    if (!existing && session.mode !== "blank" && !separator) {
      return false;
    }

    const ok = await this.apply(editor, stops, (builder) => {
      if (!existing) {
        if (session.mode === "blank") {
          builder.replace(doc.lineAt(session.startLine).range, text);
        } else {
          builder.insert(separator!, eol + text);
        }
      } else if (extendsLines(existing, lines)) {
        const end = endOf(greenStart, existing.join("\n"));
        builder.insert(end, eol + toEol(lines.slice(existing.length).join("\n"), eol));
      } else {
        builder.replace(new vscode.Range(greenStart, endOf(greenStart, existing.join("\n"))), text);
      }
    });
    if (ok) {
      session.written = lines;
      this.refreshDecorations();
    }
    return ok;
  }

  /**
   * Undoes the writes of a failed or cancelled run, so the document shows what it showed before the run.
   * A first run leaves no session behind. A follow-up goes back to the review of the previous revision.
   */
  async restore(session: Session, editor: vscode.TextEditor): Promise<void> {
    if (session.state !== "generating") {
      return;
    }
    const prior = session.prior;
    if (prior) {
      if (session.written && !sameLines(session.written, prior)) {
        await this.write(session, editor, prior, { before: false, after: true });
      }
      session.written = undefined;
      session.prior = undefined;
      session.cancel = undefined;
      session.state = "review";
      this.afterChange(session.uri, session);
      return;
    }

    if (session.written) {
      const doc = editor.document;
      const greenStart = this.greenStart(session);
      const greenEnd = endOf(greenStart, session.written.join("\n"));
      const separator = this.separator(session, doc);
      await this.apply(editor, { before: false, after: true }, (builder) => {
        if (session.mode === "blank") {
          builder.replace(new vscode.Range(greenStart, greenEnd), session.originalLines[0] ?? "");
        } else if (separator) {
          builder.delete(new vscode.Range(separator, greenEnd));
        }
      });
    }
    this.remove(session.uri);
  }

  /** Stores the finished revision. The document must already show it. */
  complete(session: Session, instruction: string, lines: string[]): void {
    session.revisions = session.revisions.slice(0, session.current + 1);
    session.revisions.push({ instruction, lines });
    session.current = session.revisions.length - 1;
    session.state = "review";
    session.written = undefined;
    session.prior = undefined;
    session.cancel = undefined;
    this.afterChange(session.uri, session);
  }

  // ---------------------------------------------------------------- decide

  /** Applies the decision of the user. Returns true if the document was changed as asked. */
  async decide(uri: vscode.Uri, decision: Decision): Promise<boolean> {
    const session = this.get(uri);
    if (!session || session.state !== "review") {
      return false;
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (!doc) {
      this.remove(uri);
      return false;
    }

    const green = session.revisions[session.current].lines;
    const original = session.originalLines;
    const start = session.startLine;
    const greenStart = this.greenStart(session);
    const greenEnd = endOf(greenStart, green.join("\n"));

    // Check that the document still shows what we expect. If not, do not touch it.
    const originalOk = session.mode !== "edit" || linesEqual(doc, start, original);
    if (!originalOk || !linesEqual(doc, greenStart.line, green)) {
      return this.abandon(session);
    }

    const edit = new vscode.WorkspaceEdit();
    if (decision === "accept") {
      if (session.mode === "edit") {
        edit.delete(uri, new vscode.Range(new vscode.Position(start, 0), new vscode.Position(start + original.length, 0)));
      }
    } else if (session.mode === "blank") {
      edit.replace(uri, new vscode.Range(greenStart, greenEnd), original[0] ?? "");
    } else {
      const separator = this.separator(session, doc);
      if (!separator) {
        return this.abandon(session);
      }
      edit.delete(uri, new vscode.Range(separator, greenEnd));
    }

    session.state = "closed";
    session.cancel = undefined;
    let applied = true;
    if (edit.size > 0) {
      this.applying++;
      try {
        applied = await vscode.workspace.applyEdit(edit);
      } finally {
        this.applying--;
      }
    }
    this.afterChange(session.uri, session);
    if (!applied) {
      void vscode.window.showErrorMessage("QuickK: could not update the file.");
    }
    return applied;
  }

  /** Forgets the session of a document (no edits). */
  remove(uri: vscode.Uri): void {
    const session = this.sessions.get(uri.toString());
    if (session) {
      session.runId++;
      session.cancel?.();
      this.sessions.delete(uri.toString());
      this.afterChange(uri, undefined);
    }
  }

  private abandon(session: Session): false {
    session.runId++;
    session.state = "detached";
    session.cancel = undefined;
    this.afterChange(session.uri, session);
    void vscode.window.showWarningMessage(
      "QuickK: the proposed change was edited, so it can not be applied safely. " +
        "The file was left as it is. Please remove the old or new lines by hand (Undo can also help)."
    );
    return false;
  }

  // ---------------------------------------------------------------- tracking

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    if (this.applying > 0 || event.contentChanges.length === 0) {
      return;
    }
    const session = this.sessions.get(event.document.uri.toString());
    if (!session) {
      return;
    }

    const changes: LineChange[] = event.contentChanges.map((change) => ({
      startLine: change.range.start.line,
      endLine: change.range.end.line,
      addedLines: change.text.split("\n").length - 1,
    }));
    const effect = classifyChanges(session.startLine, this.regionLength(session), changes);

    if (effect.spanning) {
      // We do not know where the block is any more.
      if (session.state === "generating" || session.state === "review") {
        void vscode.window.showWarningMessage("QuickK: the file was edited around the proposal, so the review ended.");
      }
      this.remove(event.document.uri);
      return;
    }

    let moved = false;
    if (effect.shift !== 0) {
      session.startLine += effect.shift;
      moved = true;
    }

    if (effect.touched) {
      if (event.reason !== undefined) {
        this.onUndoRedo(session, event.document);
        return;
      }
      this.onForeignEdit(session);
      return;
    }
    if (moved) {
      this.afterChange(session.uri, session);
    }
  }

  /** Undo or Redo changed the block: show the review that matches the text now. */
  private onUndoRedo(session: Session, doc: vscode.TextDocument): void {
    if (session.state === "generating") {
      session.runId++;
      session.cancel?.();
    }
    session.written = undefined;
    session.prior = undefined;
    session.cancel = undefined;

    const found = matchRevision(session, (line) => (line < doc.lineCount ? doc.lineAt(line).text : undefined));
    if (found !== undefined) {
      session.current = found;
      session.state = "review";
    } else if (session.revisions.length === 0) {
      this.remove(session.uri);
      return;
    } else {
      session.state = "closed";
    }
    this.afterChange(session.uri, session);
  }

  /** The user typed inside the block. We stop and leave the file as it is. */
  private onForeignEdit(session: Session): void {
    if (session.state === "generating") {
      session.runId++;
      session.cancel?.();
      session.state = "detached";
      void vscode.window.showWarningMessage(
        "QuickK: you edited the code while the model was writing. The request was stopped and the file was left as it is."
      );
    } else if (session.state === "review") {
      session.state = "detached";
      void vscode.window.showWarningMessage("QuickK: you edited the proposed change, so the review ended. The file was left as it is.");
    } else {
      return;
    }
    session.written = undefined;
    session.prior = undefined;
    session.cancel = undefined;
    this.afterChange(session.uri, session);
  }

  private regionLength(session: Session): number {
    const green = this.greenLines(session)?.length ?? 0;
    const own = (session.mode === "edit" ? session.originalLines.length : 0) + green;
    return maxRegionLength(session, own);
  }

  // ---------------------------------------------------------------- geometry

  private greenStart(session: Session): vscode.Position {
    const offset = session.mode === "edit" ? session.originalLines.length : 0;
    return new vscode.Position(session.startLine + offset, 0);
  }

  /** End of the line before the green block: here the line break and the new code are inserted. */
  private separator(session: Session, doc: vscode.TextDocument): vscode.Position | undefined {
    let line: number;
    if (session.mode === "edit") {
      line = session.startLine + session.originalLines.length - 1;
    } else if (session.mode === "insert") {
      line = session.startLine - 1;
    } else {
      return undefined;
    }
    return line >= 0 && line < doc.lineCount ? doc.lineAt(line).range.end : undefined;
  }

  private async apply(
    editor: vscode.TextEditor,
    stops: { before: boolean; after: boolean },
    build: (builder: vscode.TextEditorEdit) => void
  ): Promise<boolean> {
    this.applying++;
    try {
      return await editor.edit(build, { undoStopBefore: stops.before, undoStopAfter: stops.after });
    } catch {
      return false;
    } finally {
      this.applying--;
    }
  }

  // ---------------------------------------------------------------- UI state

  private afterChange(uri: vscode.Uri, session: Session | undefined): void {
    this.refreshDecorations();
    this.updateContextKey();
    this.changed.fire({ uri, session });
  }

  refreshDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const session = this.get(editor.document.uri);
      const removed: vscode.Range[] = [];
      const added: vscode.Range[] = [];
      const working: vscode.Range[] = [];

      if (session && (session.state === "generating" || session.state === "review")) {
        const green = this.greenLines(session);
        const doc = editor.document;
        const o = session.originalLines.length;
        const originalRange =
          session.mode === "edit" && o > 0 && session.startLine + o <= doc.lineCount
            ? new vscode.Range(session.startLine, 0, session.startLine + o - 1, 0)
            : undefined;
        const greenStart = this.greenStart(session);
        const greenRange =
          green && green.length > 0 && greenStart.line + green.length <= doc.lineCount
            ? new vscode.Range(greenStart.line, 0, greenStart.line + green.length - 1, 0)
            : undefined;

        if (originalRange && green) {
          removed.push(originalRange);
        }
        if (greenRange) {
          added.push(greenRange);
        }
        if (session.state === "generating") {
          // While the model writes, the target lines show the "working" look.
          const target = greenRange ?? originalRange ?? this.fallbackLine(session, doc);
          if (target) {
            working.push(target);
          }
        }
      }

      editor.setDecorations(this.removedDecoration, removed);
      editor.setDecorations(this.addedDecoration, added);
      editor.setDecorations(this.workingDecoration, working);
    }
  }

  /** The line that shows the "working" look when there is nothing else to mark. */
  private fallbackLine(session: Session, doc: vscode.TextDocument): vscode.Range | undefined {
    const line = session.mode === "insert" ? session.startLine - 1 : session.startLine;
    return line >= 0 && line < doc.lineCount ? new vscode.Range(line, 0, line, 0) : undefined;
  }

  private updateContextKey(): void {
    const active = vscode.window.activeTextEditor;
    const pending = active ? this.isPending(active.document.uri) : false;
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, pending);
  }
}

// ---------------------------------------------------------------- helpers

function eolOf(document: vscode.TextDocument): string {
  return document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}

function toEol(text: string, eol: string): string {
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

function linesEqual(doc: vscode.TextDocument, start: number, expected: string[]): boolean {
  if (start < 0 || start + expected.length > doc.lineCount) {
    return false;
  }
  return expected.every((line, i) => doc.lineAt(start + i).text === line);
}

/** Position after `text` was inserted at `start`. `text` uses \n line breaks. */
export function endOf(start: vscode.Position, text: string): vscode.Position {
  const lines = text.split("\n");
  if (lines.length === 1) {
    return new vscode.Position(start.line, start.character + lines[0].length);
  }
  return new vscode.Position(start.line + lines.length - 1, lines[lines.length - 1].length);
}
