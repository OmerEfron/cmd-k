import * as vscode from "vscode";
import { readContextConfig, readProviderSettings } from "../config";
import { buildEditorContext } from "../context/editorContext";
import { buildQuestionMessages, QuestionTurn } from "../prompts";
import { complete } from "../provider/openaiCompatible";
import { describeError, isCancellation } from "../ui/errors";
import {
  InlinePromptWidget,
  isInsetAvailable,
  WidgetHandlers,
  WidgetPhase,
  WidgetState,
} from "../ui/inlinePrompt";
import { focusActivePrompt, runPrompt } from "../ui/prompt";
import { isSensitiveFile } from "../util/secrets";
import { EditSessionManager, Session, SessionChange } from "./editSession";
import { generateEdit, pickTarget } from "./generateEdit";

export interface EditorCommandArgs {
  /** Run at once without waiting for the user to type. */
  instruction?: string;
  /** Fill the input box with this text (used by Retry in the fallback). */
  prefill?: string;
}

/** What the inline box can report. The integration tests use the same messages as the page. */
export type WidgetMessage =
  | { type: "submit"; text: string; mode: "edit" | "question" }
  | { type: "escape" | "stop" | "accept" | "reject" | "undo" | "redo" };

export interface DebugInfo {
  widgetOpen: boolean;
  widgetReady: boolean;
  phase: WidgetPhase | undefined;
  sessionState: Session["state"] | undefined;
  revisions: number;
  current: number;
  startLine: number | undefined;
  answer: string;
}

/** The state of one document while the user works with the inline box. */
interface Runner {
  uri: vscode.Uri;
  widget?: InlinePromptWidget;
  phase: WidgetPhase;
  status: string;
  hasSelection: boolean;
  /** Questions and answers, for "do it". */
  conversation: QuestionTurn[];
  answer: string;
  draft: string;
  lastInstruction: string;
  /** Set while a request runs. */
  controller?: AbortController;
  /** The user closed the box with Esc. Do not open it again by itself. */
  dismissed: boolean;
}

const ANSWER_UPDATE_MS = 60;

/**
 * Connects the commands, the inline box, the session manager and the model.
 *
 * Without the proposed API (no inline box), the Quick Input box and the CodeLens are used instead.
 */
export class EditorController implements vscode.Disposable {
  private readonly runners = new Map<string, Runner>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly widgetsChanged = new vscode.EventEmitter<void>();

  /** Fires when an inline box opens or closes. */
  readonly onDidChangeWidgets = this.widgetsChanged.event;

  constructor(
    private readonly extension: vscode.ExtensionContext,
    private readonly sessions: EditSessionManager
  ) {
    this.disposables.push(
      sessions.onDidChange((change) => this.onSessionChanged(change)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.reopenWidgets()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContextKeys())
    );
    this.updateContextKeys();
  }

  dispose(): void {
    for (const runner of this.runners.values()) {
      runner.controller?.abort();
      runner.widget?.dispose();
    }
    this.runners.clear();
    this.disposables.forEach((d) => d.dispose());
    this.widgetsChanged.dispose();
    void vscode.commands.executeCommand("setContext", "quickk.generating", false);
    void vscode.commands.executeCommand("setContext", "quickk.promptOpen", false);
  }

  hasWidget(uri: vscode.Uri): boolean {
    return this.runners.get(uri.toString())?.widget?.isOpen ?? false;
  }

  // ---------------------------------------------------------------- commands

  /** Cmd+K in the editor. */
  async run(args?: EditorCommandArgs): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const uri = editor.document.uri;
    const key = uri.toString();

    if (!isInsetAvailable()) {
      return this.runFallback(editor, args);
    }

    let runner = this.runners.get(key);
    if (runner?.widget?.isOpen) {
      runner.widget.focus();
      if (args?.instruction === undefined) {
        return;
      }
    } else {
      if (this.sessions.isGenerating(uri) && !runner) {
        vscode.window.setStatusBarMessage("QuickK: the model is still working on this file.", 3000);
        return;
      }
      if (!runner) {
        if (isSensitiveFile(editor.document.fileName) && !(await confirmSensitive(editor.document.fileName))) {
          return;
        }
        runner = this.newRunner(editor);
      }
      runner.dismissed = false;
      if (!this.openWidget(runner, editor)) {
        // The editor does not allow insets here. Use the Quick Input box.
        this.runners.delete(key);
        return this.runFallback(editor, args);
      }
    }

    if (args?.instruction !== undefined) {
      await this.submit(runner, args.instruction, "edit");
    }
  }

  async decide(decision: "accept" | "reject"): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await this.sessions.decide(editor.document.uri, decision);
    }
  }

  /** Stops the request of the active document. */
  cancel(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const uri = editor.document.uri;
    this.runners.get(uri.toString())?.controller?.abort();
    this.sessions.get(uri)?.cancel?.();
  }

  // ---------------------------------------------------------------- for tests

  debug(uri: vscode.Uri): DebugInfo {
    const runner = this.runners.get(uri.toString());
    const session = this.sessions.get(uri);
    return {
      widgetOpen: runner?.widget?.isOpen ?? false,
      widgetReady: runner?.widget?.isReady ?? false,
      phase: runner?.phase,
      sessionState: session?.state,
      revisions: session?.revisions.length ?? 0,
      current: session?.current ?? -1,
      startLine: session?.startLine,
      answer: runner?.answer ?? "",
    };
  }

  /** Acts as if the page in the inline box had sent this message. */
  async simulate(uri: vscode.Uri, message: WidgetMessage): Promise<void> {
    const runner = this.runners.get(uri.toString());
    if (!runner) {
      return;
    }
    await this.handlersFor(runner).handle(message);
  }

  // ---------------------------------------------------------------- inline box

  private newRunner(editor: vscode.TextEditor): Runner {
    const runner: Runner = {
      uri: editor.document.uri,
      phase: "typing",
      status: "",
      hasSelection: !editor.selection.isEmpty,
      conversation: [],
      answer: "",
      draft: "",
      lastInstruction: "",
      dismissed: false,
    };
    this.runners.set(editor.document.uri.toString(), runner);
    return runner;
  }

  /** Opens (or opens again) the box above the code. Returns false if that is not possible. */
  private openWidget(runner: Runner, editor: vscode.TextEditor): boolean {
    const session = this.sessions.get(runner.uri);
    if (session?.state === "review") {
      runner.phase = "review";
    } else if (session?.state === "generating") {
      runner.phase = "generating";
    }
    const anchor =
      session && (session.state === "review" || session.state === "generating")
        ? session.startLine
        : pickTarget(editor).startLine;

    if (!runner.widget || runner.widget.editor !== editor) {
      runner.widget?.dispose();
      runner.widget = new InlinePromptWidget(editor, this.handlersFor(runner));
    }
    const ok = runner.widget.open(anchor, { ...this.stateOf(runner), focus: true, inputValue: runner.draft });
    if (!ok) {
      runner.widget = undefined;
    }
    this.afterWidgetChange();
    return ok;
  }

  /** Brings back boxes that were removed because their editor was hidden. */
  private reopenWidgets(): void {
    for (const runner of this.runners.values()) {
      if (runner.widget?.isOpen || runner.dismissed) {
        continue;
      }
      const session = this.sessions.get(runner.uri);
      if (session?.state !== "review" && session?.state !== "generating") {
        continue;
      }
      const editor = this.editorFor(runner.uri);
      if (editor) {
        this.openWidget(runner, editor);
      }
    }
    this.updateContextKeys();
  }

  private handlersFor(runner: Runner): WidgetHandlers & { handle(message: WidgetMessage): Promise<void> } {
    const handlers = {
      submit: (text: string, mode: "edit" | "question") => this.submit(runner, text, mode),
      stop: () => runner.controller?.abort(),
      accept: () => void this.sessions.decide(runner.uri, "accept"),
      reject: () => void this.sessions.decide(runner.uri, "reject"),
      escape: () => this.escape(runner),
      undoRedo: async (kind: "undo" | "redo") => {
        // The keyboard focus is in the box. Give it back to the editor, then undo there.
        await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
        await vscode.commands.executeCommand(kind);
      },
      draft: (text: string) => {
        runner.draft = text;
      },
      disposed: () => {
        runner.widget = undefined;
        this.afterWidgetChange();
      },
      handle: async (message: WidgetMessage) => {
        switch (message.type) {
          case "submit":
            await handlers.submit(message.text, message.mode);
            break;
          case "escape":
            handlers.escape();
            break;
          case "undo":
          case "redo":
            await handlers.undoRedo(message.type);
            break;
          case "stop":
            handlers.stop();
            break;
          case "accept":
            await this.sessions.decide(runner.uri, "accept");
            break;
          case "reject":
            await this.sessions.decide(runner.uri, "reject");
            break;
        }
      },
    };
    return handlers;
  }

  private escape(runner: Runner): void {
    if (runner.controller) {
      runner.controller.abort();
      return;
    }
    // Close the box. A pending proposal stays: it can still be accepted or rejected with keys or CodeLens.
    runner.dismissed = true;
    runner.widget?.dispose();
    runner.widget = undefined;
    const session = this.sessions.get(runner.uri);
    if (session?.state !== "review") {
      this.runners.delete(runner.uri.toString());
    }
    this.focusEditor();
    this.afterWidgetChange();
  }

  private closeRunner(runner: Runner, focusEditor: boolean): void {
    const hadWidget = runner.widget?.isOpen ?? false;
    runner.controller?.abort();
    runner.widget?.dispose();
    runner.widget = undefined;
    this.runners.delete(runner.uri.toString());
    if (hadWidget && focusEditor) {
      this.focusEditor();
    }
    this.afterWidgetChange();
  }

  private focusEditor(): void {
    void vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  }

  private afterWidgetChange(): void {
    this.updateContextKeys();
    this.widgetsChanged.fire();
  }

  // ---------------------------------------------------------------- requests

  private async submit(runner: Runner, text: string, mode: "edit" | "question"): Promise<void> {
    if (runner.controller) {
      return;
    }
    const controller = new AbortController();
    runner.controller = controller;
    runner.lastInstruction = text;
    runner.draft = "";
    this.updateContextKeys();
    try {
      if (mode === "question") {
        await this.ask(runner, text, controller);
      } else {
        await this.edit(runner, text, controller);
      }
    } finally {
      runner.controller = undefined;
      this.updateContextKeys();
    }
  }

  private async edit(runner: Runner, text: string, controller: AbortController): Promise<void> {
    this.setPhase(runner, "generating", { status: "Waiting for the model...", inputValue: text });
    try {
      const outcome = await generateEdit({
        extension: this.extension,
        sessions: this.sessions,
        uri: runner.uri,
        getEditor: () => this.editorFor(runner.uri),
        instruction: text,
        conversation: runner.conversation,
        signal: controller.signal,
        progress: (status) => this.setStatus(runner, status),
      });
      runner.conversation = [];
      runner.answer = "";
      if (outcome === "no-change") {
        this.setPhase(runner, this.phaseAfterRun(runner), {
          status: "The model proposed no change.",
          inputValue: text,
          focus: true,
        });
      } else if (runner.phase !== "review") {
        this.setPhase(runner, "review", { inputValue: "", focus: true });
      }
    } catch (error) {
      if (isCancellation(error) || controller.signal.aborted) {
        this.setPhase(runner, this.phaseAfterRun(runner), { status: "Stopped.", inputValue: text, focus: true });
      } else {
        this.setPhase(runner, "error", { status: describeError(error), inputValue: text, focus: true });
      }
    }
  }

  /** Where the box goes after a request ended without a new proposal. */
  private phaseAfterRun(runner: Runner): WidgetPhase {
    if (this.sessions.get(runner.uri)?.state === "review") {
      return "review";
    }
    return runner.conversation.length > 0 ? "answered" : "typing";
  }

  private async ask(runner: Runner, question: string, controller: AbortController): Promise<void> {
    const editor = this.editorFor(runner.uri);
    if (!editor) {
      return;
    }
    runner.answer = "";
    this.setPhase(runner, "answering", { status: "Thinking...", inputValue: question });
    try {
      const settings = await readProviderSettings(this.extension.secrets);
      if (!settings || controller.signal.aborted) {
        this.setPhase(runner, this.phaseAfterRun(runner), { inputValue: question, focus: true });
        return;
      }

      const doc = editor.document;
      const target = pickTarget(editor);
      const lines = doc.getText().split(/\r?\n/);
      const { contextLines, maxContextChars } = readContextConfig();
      const afterStart = target.mode === "edit" ? target.startLine + target.originalLines.length : target.startLine + (target.mode === "blank" ? 1 : 0);
      const context = buildEditorContext({
        lines,
        beforeEnd: target.startLine,
        afterStart,
        contextLines,
        maxContextChars,
      });
      const messages = buildQuestionMessages({
        fileName: vscode.workspace.asRelativePath(doc.uri),
        languageId: doc.languageId,
        context,
        hasSelection: target.hasSelection,
        conversation: runner.conversation,
        question,
      });

      let lastUpdate = 0;
      const result = await complete(settings, messages, {
        signal: controller.signal,
        onDelta: (delta, total) => {
          runner.answer += delta;
          const now = Date.now();
          if (now - lastUpdate >= ANSWER_UPDATE_MS) {
            lastUpdate = now;
            runner.widget?.update({ answer: runner.answer, status: `Thinking... (${total} characters)` });
          }
        },
      });
      runner.answer = result.text;
      runner.conversation.push({ question, answer: result.text });
      this.setPhase(runner, "answered", { inputValue: "", focus: true });
    } catch (error) {
      if (isCancellation(error) || controller.signal.aborted) {
        // Keep what the model already wrote, if anything.
        if (runner.answer) {
          runner.conversation.push({ question, answer: runner.answer });
        }
        this.setPhase(runner, this.phaseAfterRun(runner), { status: "Stopped.", inputValue: question, focus: true });
      } else {
        this.setPhase(runner, "error", { status: describeError(error), inputValue: question, focus: true });
      }
    }
  }

  // ---------------------------------------------------------------- state of the box

  private setPhase(
    runner: Runner,
    phase: WidgetPhase,
    patch: { status?: string; inputValue?: string; focus?: boolean } = {}
  ): void {
    runner.phase = phase;
    runner.status = patch.status ?? "";
    runner.widget?.update({
      ...this.stateOf(runner),
      inputValue: patch.inputValue,
      focus: patch.focus,
    });
  }

  private setStatus(runner: Runner, status: string): void {
    runner.status = status;
    runner.widget?.update({ status });
  }

  private stateOf(runner: Runner): WidgetState {
    const session = this.sessions.get(runner.uri);
    const reviewing = session?.state === "review";
    const editing = session ? session.mode === "edit" : runner.hasSelection;
    const canQuestion = !reviewing;
    const asking = runner.phase === "answering" || runner.phase === "answered";

    let placeholder: string;
    if (runner.phase === "review") {
      placeholder = "Follow-up instruction...";
    } else if (runner.phase === "answered") {
      placeholder = "Ask more, or say what to change (Enter applies it as an edit)";
    } else {
      placeholder = editing ? "Describe how to change the selected code" : "Describe the code to generate here";
    }

    return {
      phase: runner.phase,
      modeLabel: asking ? "Ask" : editing ? "Edit" : "Generate",
      placeholder,
      model: vscode.workspace.getConfiguration("quickk").get<string>("model", ""),
      status: runner.status || defaultStatus(runner.phase, canQuestion),
      answer: runner.answer,
      canQuestion,
      isMac: process.platform === "darwin",
    };
  }

  // ---------------------------------------------------------------- session events

  private onSessionChanged(change: SessionChange): void {
    const { session, uri } = change;
    let runner = this.runners.get(uri.toString());

    if (!session) {
      // The session ended without a decision (Undo, or the request failed).
      if (runner && (runner.phase === "generating" || runner.phase === "review")) {
        this.setPhase(runner, "typing", { inputValue: runner.lastInstruction, focus: true });
      }
      this.updateContextKeys();
      return;
    }

    switch (session.state) {
      case "generating":
        runner?.widget?.moveTo(session.startLine);
        break;
      case "review": {
        if (!runner) {
          // Undo or Redo brought a review back and nobody has a box for it.
          const editor = this.editorFor(uri);
          if (editor && isInsetAvailable()) {
            runner = this.newRunner(editor);
            runner.hasSelection = session.mode === "edit";
          }
        }
        if (runner) {
          if (runner.phase !== "review") {
            this.setPhase(runner, "review", { inputValue: "", focus: true });
          }
          if (runner.widget?.isOpen) {
            runner.widget.moveTo(session.startLine);
          } else if (!runner.dismissed) {
            const editor = this.editorFor(uri);
            if (editor) {
              this.openWidget(runner, editor);
            }
          }
        }
        break;
      }
      case "detached":
      case "closed":
        if (runner) {
          this.closeRunner(runner, true);
        }
        break;
    }
    this.afterWidgetChange();
  }

  // ---------------------------------------------------------------- helpers

  private editorFor(uri: vscode.Uri): vscode.TextEditor | undefined {
    const key = uri.toString();
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.toString() === key) {
      return active;
    }
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
  }

  private updateContextKeys(): void {
    const active = vscode.window.activeTextEditor;
    const runner = active ? this.runners.get(active.document.uri.toString()) : undefined;
    const generating =
      !!active && (runner?.controller !== undefined || this.sessions.isGenerating(active.document.uri));
    void vscode.commands.executeCommand("setContext", "quickk.generating", generating);
    void vscode.commands.executeCommand("setContext", "quickk.promptOpen", runner?.widget?.isOpen ?? false);
  }

  // ---------------------------------------------------------------- fallback (Quick Input)

  private async runFallback(editor: vscode.TextEditor, args?: EditorCommandArgs): Promise<void> {
    const uri = editor.document.uri;
    const session = this.sessions.get(uri);
    if (session?.state === "generating") {
      vscode.window.setStatusBarMessage("QuickK: the model is still working on this file.", 3000);
      return;
    }
    if (focusActivePrompt()) {
      return;
    }
    const followUp = session?.state === "review";
    const target = pickTarget(editor);
    if (!followUp && isSensitiveFile(editor.document.fileName) && !(await confirmSensitive(editor.document.fileName))) {
      return;
    }

    await runPrompt({
      title: followUp ? "QuickK: Follow-up" : target.hasSelection ? "QuickK: Edit selection" : "QuickK: Generate code",
      placeholder: followUp
        ? "Describe what to change in the proposal"
        : target.hasSelection
          ? "Describe how to change the selected code"
          : "Describe the code to generate at the cursor",
      prefill: args?.prefill,
      instruction: args?.instruction,
      run: async (instruction, signal, progress) => {
        const outcome = await generateEdit({
          extension: this.extension,
          sessions: this.sessions,
          uri,
          getEditor: () => this.editorFor(uri),
          instruction,
          signal,
          progress,
        });
        if (outcome === "no-change") {
          void vscode.window.showInformationMessage("QuickK: the model proposed no change.");
        }
      },
      onRetry: (instruction) =>
        void vscode.commands.executeCommand("quickk.editor", { prefill: instruction } satisfies EditorCommandArgs),
    });
  }
}

function defaultStatus(phase: WidgetPhase, canQuestion: boolean): string {
  switch (phase) {
    case "typing":
      return canQuestion ? "Enter: send   Alt+Enter: ask a question   Esc: close" : "Enter: send   Esc: close";
    case "review":
      return "Review the change. Type a follow-up, or accept or reject.";
    case "answered":
      return "Enter: apply as an edit   Alt+Enter: ask more   Esc: close";
    default:
      return "";
  }
}

async function confirmSensitive(fileName: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    "This file may contain secrets.",
    {
      modal: true,
      detail: `${fileName}\n\nQuickK would send code from this file to your AI provider.`,
    },
    "Send anyway"
  );
  return choice === "Send anyway";
}
