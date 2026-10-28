// Copy of the proposed API "editorInsets":
// https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.editorInsets.d.ts
// The API is only available when the extension is allowed to use proposed APIs.
// Always check that the function exists before you call it.

declare module "vscode" {
  export interface WebviewEditorInset {
    readonly editor: TextEditor;
    readonly line: number;
    readonly height: number;
    readonly webview: Webview;
    readonly onDidDispose: Event<void>;
    dispose(): void;
  }

  export namespace window {
    export function createWebviewTextEditorInset(
      editor: TextEditor,
      line: number,
      height: number,
      options?: WebviewOptions
    ): WebviewEditorInset;
  }
}
