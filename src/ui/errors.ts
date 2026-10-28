import * as vscode from "vscode";
import { CancelledError, ProviderError } from "../provider/openaiCompatible";

/** An error with a message that is safe and useful to show to the user as it is. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export function isCancellation(error: unknown): boolean {
  return error instanceof CancelledError;
}

export function describeError(error: unknown): string {
  if (error instanceof UserError || error instanceof ProviderError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `Unexpected error: ${error.message}`;
  }
  return "Unexpected error.";
}

/** Shows an error. Nothing was changed in the user's files when we get here. */
export function showFailure(error: unknown, retry?: () => void): void {
  const message = `QuickK: ${describeError(error)}`;
  if (retry) {
    void vscode.window.showErrorMessage(message, "Retry").then((choice) => {
      if (choice === "Retry") {
        retry();
      }
    });
  } else {
    void vscode.window.showErrorMessage(message);
  }
}
