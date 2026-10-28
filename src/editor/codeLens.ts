import * as vscode from "vscode";
import { EditSessionManager } from "./editSession";

/**
 * Shows "Accept | Reject" above a pending proposal.
 * It is only used when the inline box is not open (box closed with Esc, or the proposed API is off).
 */
export class ProposalCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(
    private readonly sessions: EditSessionManager,
    private readonly hasWidget: (uri: vscode.Uri) => boolean
  ) {
    this.subscription = sessions.onDidChange(() => this.changed.fire());
  }

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const session = this.sessions.get(document.uri);
    if (!session || session.state !== "review" || this.hasWidget(document.uri)) {
      return [];
    }
    const line = Math.min(session.startLine, document.lineCount - 1);
    const range = new vscode.Range(line, 0, line, 0);
    const mac = process.platform === "darwin";
    const acceptKey = mac ? "Cmd+Enter" : "Ctrl+Enter";
    const rejectKey = mac ? "Cmd+Backspace" : "Ctrl+Backspace";
    return [
      new vscode.CodeLens(range, {
        title: `$(check) Accept (${acceptKey})`,
        command: "quickk.accept",
        tooltip: "Keep the new code",
      }),
      new vscode.CodeLens(range, {
        title: `$(discard) Reject (${rejectKey})`,
        command: "quickk.reject",
        tooltip: "Keep the original code",
      }),
    ];
  }
}
