import * as vscode from "vscode";
import { inlinePromptHtml } from "./inlinePromptHtml";

export type WidgetPhase = "typing" | "generating" | "review" | "answering" | "answered" | "error";

/** Everything the page needs to draw itself. */
export interface WidgetState {
  phase: WidgetPhase;
  /** "Edit", "Generate" or "Ask". */
  modeLabel: string;
  placeholder: string;
  model: string;
  status?: string;
  /** Markdown of the answer (question mode). */
  answer?: string;
  /** Set the text of the input box. Leave undefined to keep what the user typed. */
  inputValue?: string;
  /** Move the keyboard focus into the input box. */
  focus?: boolean;
  canQuestion: boolean;
  isMac: boolean;
}

export interface WidgetHandlers {
  submit(text: string, mode: "edit" | "question"): void;
  stop(): void;
  accept(): void;
  reject(): void;
  escape(): void;
  /** Undo or Redo was pressed in an empty box: run it on the document. */
  undoRedo(kind: "undo" | "redo"): void | Promise<void>;
  /** The user typed in the box. */
  draft(text: string): void;
  /** The inset was removed from outside (for example the editor tab closed). */
  disposed(): void;
}

/** Height of the inset in editor lines. The API can not resize an inset. */
const HEIGHT_NORMAL = 3;
const HEIGHT_ANSWER = 10;

/** Set when the first try to create an inset failed (the proposed API is not enabled for this extension). */
let insetBroken = false;

/**
 * True if the proposed API "editorInsets" can be used.
 * The function always exists, but it throws when the API is not enabled. We learn that on the first try.
 */
export function isInsetAvailable(): boolean {
  return !insetBroken && typeof vscode.window.createWebviewTextEditorInset === "function";
}

/**
 * The input box that sits above the code, inside the editor.
 *
 * It is a small web page in an editor inset (a proposed API, see src/types/editorInsets.d.ts).
 * The inset API can not resize the page, so a change of height creates a new page.
 * The page asks for its state with a "ready" message, so nothing is lost when it is created again.
 */
export class InlinePromptWidget {
  private inset: vscode.WebviewEditorInset | undefined;
  private ready = false;
  private anchorLine = 0;
  private height = HEIGHT_NORMAL;
  private state: WidgetState | undefined;

  constructor(
    readonly editor: vscode.TextEditor,
    private readonly handlers: WidgetHandlers
  ) {}

  get isOpen(): boolean {
    return this.inset !== undefined;
  }

  /** True when the page has loaded and can take messages. */
  get isReady(): boolean {
    return this.ready;
  }

  get currentPhase(): WidgetPhase | undefined {
    return this.state?.phase;
  }

  /**
   * Shows the box above `anchorLine` (the first line of the code it belongs to).
   * Returns false if the editor does not allow it.
   */
  open(anchorLine: number, state: WidgetState): boolean {
    this.anchorLine = anchorLine;
    this.state = { ...state, focus: true };
    this.height = heightFor(state.phase);
    return this.create();
  }

  /** Changes the state of the page. Creates the page again when the height changes. */
  update(patch: Partial<WidgetState>): void {
    if (!this.state) {
      return;
    }
    this.state = { ...this.state, ...patch };
    const height = heightFor(this.state.phase);
    if (height !== this.height && this.inset) {
      this.height = height;
      this.state = { ...this.state, focus: true };
      this.create();
      return;
    }
    this.post();
  }

  /** The block moved in the document: put the box above its new first line. */
  moveTo(anchorLine: number): void {
    if (anchorLine === this.anchorLine || !this.inset) {
      this.anchorLine = anchorLine;
      return;
    }
    this.anchorLine = anchorLine;
    if (this.state) {
      this.state = { ...this.state, focus: true };
    }
    this.create();
  }

  /** Moves the keyboard focus into the box. */
  focus(): void {
    this.update({ focus: true });
  }

  dispose(): void {
    const inset = this.inset;
    this.inset = undefined;
    this.ready = false;
    inset?.dispose();
  }

  // ---------------------------------------------------------------- internals

  private create(): boolean {
    const old = this.inset;
    // Forget the old inset first, so its dispose event is not seen as "removed from outside".
    this.inset = undefined;
    this.ready = false;
    old?.dispose();

    let inset: vscode.WebviewEditorInset;
    try {
      // The inset appears BELOW the given line. For "above the anchor line" we pass one line less.
      inset = vscode.window.createWebviewTextEditorInset(this.editor, this.anchorLine - 1, this.height, {
        enableScripts: true,
      });
    } catch {
      // Not enabled (see README: enable-proposed-api). From now on the Quick Input fallback is used.
      insetBroken = true;
      return false;
    }
    this.inset = inset;
    inset.webview.onDidReceiveMessage((message) => this.onMessage(inset, message));
    inset.onDidDispose(() => {
      if (this.inset === inset) {
        this.inset = undefined;
        this.ready = false;
        this.handlers.disposed();
      }
    });
    inset.webview.html = inlinePromptHtml(nonce());
    return true;
  }

  private post(): void {
    if (this.inset && this.ready && this.state) {
      void this.inset.webview.postMessage({ type: "state", ...this.state });
      // Focus and input text are one-time instructions.
      this.state = { ...this.state, focus: false, inputValue: undefined };
    }
  }

  private onMessage(inset: vscode.WebviewEditorInset, message: any): void {
    if (this.inset !== inset || !message) {
      return;
    }
    switch (message.type) {
      case "ready":
        this.ready = true;
        this.post();
        break;
      case "submit":
        if (typeof message.text === "string" && (message.mode === "edit" || message.mode === "question")) {
          this.handlers.submit(message.text, message.mode);
        }
        break;
      case "draft":
        if (typeof message.text === "string") {
          this.handlers.draft(message.text);
        }
        break;
      case "stop":
        this.handlers.stop();
        break;
      case "accept":
        this.handlers.accept();
        break;
      case "reject":
        this.handlers.reject();
        break;
      case "escape":
        this.handlers.escape();
        break;
      case "undo":
      case "redo":
        this.handlers.undoRedo(message.type);
        break;
    }
  }
}

function heightFor(phase: WidgetPhase): number {
  return phase === "answering" || phase === "answered" ? HEIGHT_ANSWER : HEIGHT_NORMAL;
}

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
