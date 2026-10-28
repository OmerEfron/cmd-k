# QuickK

Cmd+K for quick AI work in VS Code and Cursor. No agent. No chat panel.

Select something, press `Cmd+K`, say what you want, and review the result where you work.

## What it does

| Where you are | What happens |
|---|---|
| Editor, with a selection | Edits the selected lines. The new code streams in under the old code. You choose Accept or Reject. |
| Editor, no selection | Generates code at the cursor. You can accept or reject it. |
| Editor, `Alt+Enter` in the box | Asks a question about the code. The answer shows in the box. The file is not changed. |
| Integrated terminal | Writes a shell command into the terminal. It is **never** run for you. |

## The input box above the code

QuickK shows a small input box **above the code**, inside the editor (like the old Cursor). It uses the VS Code proposed API `editorInsets`. This API is not allowed for extensions from the Marketplace, so you need to turn it on for QuickK once. See [Setup](#setup).

Without it, QuickK uses a Quick Input box at the top of the window, and Accept / Reject links (CodeLens) above the change. Everything works, but there is no inline box, and no question mode.

## Keys

| Key | Where | Action |
|---|---|---|
| `Cmd+K` (`Ctrl+K` on Windows/Linux) | Editor | Open the box (or focus it) |
| `Enter` | Box | Send. With a proposal open, this is a follow-up |
| `Alt+Enter` | Box | Ask a question instead of editing |
| `Cmd+Enter` | Editor or box | Accept the proposed change |
| `Cmd+Backspace` | Editor, or empty box | Reject the proposed change |
| `Escape` | Box or editor | Stop a running request. Otherwise close the box (the proposal stays) |
| `Cmd+Z` / `Cmd+Shift+Z` | Editor, or empty box | Undo / redo, see below |

## Setup

1. Run **QuickK: Set API Key**. The key is stored in VS Code SecretStorage.
2. Turn on the inline box (once):
   - Open the command palette and run **Preferences: Configure Runtime Arguments**. This opens `argv.json`.
   - Add this line, then restart Cursor / VS Code completely:

     ```json
     "enable-proposed-api": ["quickk.quickk"]
     ```
   - If you started it from a terminal, you can use `--enable-proposed-api quickk.quickk` instead.
3. Optional: change these settings.
   - `quickk.baseUrl`: any OpenAI-compatible API (default `https://api.openai.com/v1`)
   - `quickk.model`
   - `quickk.maxTokens`, `quickk.temperature` (set to `null` if your model does not accept it), `quickk.timeoutMs`
   - `quickk.contextLines`, `quickk.maxContextChars`

For a local server (for example Ollama or LM Studio) set `quickk.baseUrl` to its address, such as `http://localhost:11434/v1`. No API key is needed for `localhost`.

To install the `.vsix`: **Extensions: Install from VSIX...**. Build it with Node 20 or newer:

```sh
npm run package   # creates quickk-0.1.0.vsix
```

The extension uses a proposed API, so it can be installed from a `.vsix` but not published to the Marketplace.

## How the review works

When you edit a selection, QuickK works on whole lines. It adds the new code under the old code while the model writes. The old lines are red and the new lines are green.

- **Accept** removes the old lines.
- **Reject** removes the new lines. Your original code stays as it was.
- **Follow-up**: type another instruction in the box while the proposal is open. The new answer replaces the green code. QuickK remembers each version.
- **Question**: press `Alt+Enter` to ask. Then write what to do and press `Enter`. QuickK sends the conversation along, so "do it" works.
- If you type inside the proposal while the model works, QuickK stops and leaves the file as it is. It does not guess.
- Edits above the proposal are fine. QuickK follows the code to its new place.

## Undo and redo

QuickK never changes your file because of Undo or Redo. It only looks at the text and shows or hides its review.

- Every QuickK change (the whole stream, Accept, Reject) is **one** undo step.
- `Cmd+Z` while the model writes: the partial code is removed and the request stops.
- `Cmd+Z` during a review: your original code comes back. `Cmd+Shift+Z` brings the proposal and the review back.
- `Cmd+Z` after Accept or Reject: the review comes back. Press it again to get your original code.
- `Cmd+Z` after follow-ups goes back one version at a time.
- Undo or redo of your own edits does not touch the review. If you edited inside the proposal and then undo that edit, the review comes back.

When the keyboard focus is in the box, `Cmd+Z` first undoes the text in the box. With an empty box it undoes the document.

## Safety

- Terminal commands are only typed into the terminal. You press Enter yourself.
- Commands that look dangerous (for example `rm -rf`, `git push --force`, `dd`) need a confirmation.
- Files that often contain secrets (`.env`, `*.pem`, `id_rsa`, ...) are not sent without your confirmation.
- No telemetry. Your code goes only to the API you configure.
- The extension needs a trusted workspace.

## Shortcut conflicts

`Cmd+K` is the first key of many VS Code shortcuts (chords, such as `Cmd+K Cmd+S`). While the editor has focus, QuickK takes `Cmd+K`, so those chords do not work. This is the same as in Cursor.

To fix a conflict:

1. Open **Preferences: Open Keyboard Shortcuts**.
2. Search for `quickk`.
3. Change the key for **QuickK: Edit Selection or Generate Code** and **QuickK: Generate Terminal Command**.

In Cursor, remove the built-in bindings that use `Cmd+K` (for example the inline edit) or QuickK will not get the key.

In the terminal, `Cmd+K` normally clears the terminal. QuickK replaces this while the terminal has focus. You can still use **Terminal: Clear** from the command palette.

On Windows and Linux, the terminal may send `Ctrl+K` to the shell (it is "kill line" in many shells) before VS Code can use it. If `Ctrl+K` does nothing in the terminal, add QuickK to the list of commands that skip the shell in your settings:

```json
"terminal.integrated.commandsToSkipShell": ["quickk.terminal"]
```

## Development

```sh
npm install
npm run compile     # type check + bundle
npm test            # unit tests
npm run test:integration   # runs the extension in a real VS Code with a local mock AI server
npm run package     # build a .vsix (needs Node 20+)
```

`test:integration` downloads VS Code the first time. It does not call a real AI provider. It runs with the proposed API on. Set `QUICKK_NO_PROPOSED=1` to test the fallback (no inline box). Set `QUICKK_GREP` to run only some tests.

Press `F5` to start an Extension Development Host. For the inline box in it, start it with `--enable-proposed-api=quickk.quickk` (the `.vscode/launch.json` can pass this).
