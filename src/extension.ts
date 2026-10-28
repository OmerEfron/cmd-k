import * as vscode from "vscode";
import { clearApiKey, promptForApiKey } from "./config";
import { ProposalCodeLensProvider } from "./editor/codeLens";
import { EditSessionManager } from "./editor/editSession";
import { DebugInfo, EditorCommandArgs, EditorController, WidgetMessage } from "./editor/editorCommand";
import { runTerminalCommand, TerminalCommandArgs } from "./terminal/terminalController";
import { isInsetAvailable } from "./ui/inlinePrompt";

/** Small API. The integration tests use it. */
export interface QuickKApi {
  /** True while a proposal waits for Accept or Reject. */
  isPending(uri: vscode.Uri): boolean;
  /** True if the inline box (proposed API editorInsets) can be used. */
  inlineAvailable(): boolean;
  /** The state of the inline box and the session of a document. */
  debug(uri: vscode.Uri): DebugInfo;
  /** Acts as if the inline box had sent this message. */
  simulate(uri: vscode.Uri, message: WidgetMessage): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): QuickKApi {
  const sessions = new EditSessionManager();
  const controller = new EditorController(context, sessions);
  const codeLens = new ProposalCodeLensProvider(sessions, (uri) => controller.hasWidget(uri));

  context.subscriptions.push(
    sessions,
    controller,
    codeLens,
    controller.onDidChangeWidgets(() => codeLens.refresh()),
    vscode.languages.registerCodeLensProvider({ scheme: "*" }, codeLens),

    vscode.commands.registerCommand("quickk.editor", (args?: EditorCommandArgs) => controller.run(args)),
    vscode.commands.registerCommand("quickk.terminal", (args?: TerminalCommandArgs) =>
      runTerminalCommand(context, args)
    ),
    vscode.commands.registerCommand("quickk.accept", () => controller.decide("accept")),
    vscode.commands.registerCommand("quickk.reject", () => controller.decide("reject")),
    vscode.commands.registerCommand("quickk.cancel", () => controller.cancel()),
    vscode.commands.registerCommand("quickk.setApiKey", async () => {
      if (await promptForApiKey(context.secrets)) {
        void vscode.window.showInformationMessage("QuickK: API key saved.");
      }
    }),
    vscode.commands.registerCommand("quickk.clearApiKey", () => clearApiKey(context.secrets))
  );

  return {
    isPending: (uri) => sessions.isPending(uri),
    inlineAvailable: () => isInsetAvailable(),
    debug: (uri) => controller.debug(uri),
    simulate: (uri, message) => controller.simulate(uri, message),
  };
}

export function deactivate(): void {
  // Nothing to clean up: disposables are registered in context.subscriptions.
}
