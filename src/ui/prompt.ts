import * as vscode from "vscode";
import { isCancellation, showFailure } from "./errors";

export interface PromptOptions {
  title: string;
  placeholder: string;
  /** Text that is already in the input box (used by Retry). */
  prefill?: string;
  /** When set, the input box is skipped and the work starts at once. */
  instruction?: string;
  /** Does the work. It must throw CancelledError (or any error) when the signal is aborted. */
  run: (instruction: string, signal: AbortSignal, progress: (text: string) => void) => Promise<void>;
  /** Called when the user chooses Retry after an error. */
  onRetry: (instruction: string) => void;
}

let activeInput: vscode.InputBox | undefined;
let directRunning = false;

/** True while a prompt is open or a request is running. */
export function isPromptBusy(): boolean {
  return activeInput !== undefined || directRunning;
}

/** Brings an open prompt to the front. Returns false if there is none. */
export function focusActivePrompt(): boolean {
  if (activeInput) {
    activeInput.show();
    return true;
  }
  return false;
}

export async function runPrompt(options: PromptOptions): Promise<void> {
  if (focusActivePrompt() || directRunning) {
    return;
  }
  if (options.instruction !== undefined) {
    await runDirect(options, options.instruction);
  } else {
    await runWithInput(options);
  }
}

function runWithInput(options: PromptOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const input = vscode.window.createInputBox();
    activeInput = input;
    input.title = options.title;
    input.placeholder = options.placeholder;
    input.prompt = "Enter to send, Esc to cancel";
    input.value = options.prefill ?? "";

    const controller = new AbortController();
    let working = false;
    let finished = false;

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      activeInput = undefined;
      input.dispose();
      resolve();
    };

    input.onDidAccept(async () => {
      const text = input.value.trim();
      // Ignore empty input and a second Enter while a request is running.
      if (text === "" || working) {
        return;
      }
      working = true;
      input.busy = true;
      let failure: unknown;
      try {
        await options.run(text, controller.signal, (message) => {
          input.title = message;
        });
      } catch (error) {
        failure = error;
      }
      finish();
      if (failure !== undefined && !controller.signal.aborted && !isCancellation(failure)) {
        showFailure(failure, () => options.onRetry(text));
      }
    });

    // Escape (or clicking away) hides the box. This also cancels a running request.
    input.onDidHide(() => {
      controller.abort();
      finish();
    });

    input.show();
  });
}

async function runDirect(options: PromptOptions, instruction: string): Promise<void> {
  directRunning = true;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: options.title, cancellable: true },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        try {
          await options.run(instruction, controller.signal, (message) => progress.report({ message }));
        } catch (error) {
          if (!controller.signal.aborted && !isCancellation(error)) {
            showFailure(error, () => options.onRetry(instruction));
          }
        }
      }
    );
  } finally {
    directRunning = false;
  }
}
