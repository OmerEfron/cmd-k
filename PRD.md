# Product Requirements Document (PRD)
# QuickK — Restore Cursor's Original Cmd+K Experience

**Version:** 1.0  
**Product Type:** VS Code / Cursor Extension  
**Primary Platform:** macOS  
**Secondary Platforms:** Windows, Linux  
**Status:** Proposed

---

## 1. Product Overview

### 1.1 Summary

QuickK is a lightweight VS Code extension designed to recreate the original Cursor `Cmd+K` AI functionality that was retired in October 2026.

The extension enables developers to interact with AI directly from their code editor or integrated terminal without opening a chat panel, starting an agent session, or interrupting their existing workflow.

The core principle is simple:

**Select something, press Cmd+K, describe what you want, and get the result directly where you're working.**

### 1.2 Problem Statement

Cursor previously offered a fast, contextual AI interaction accessible through `Cmd+K`.

Developers could:

- Edit selected code using natural-language instructions.
- Generate code at the current cursor position.
- Ask quick questions about selected code.
- Generate shell commands from natural-language descriptions directly in the terminal.
- Refine generated results without starting a new conversation.

These interactions were lightweight and localized.

Following the removal of the feature, developers must rely on more comprehensive Agent workflows, which introduce unnecessary overhead for simple, targeted tasks.

### 1.3 Product Goal

Recreate the original `Cmd+K` experience as closely as technically possible using public VS Code extension APIs.

Prioritize:

1. Speed and responsiveness.
2. Minimal user interaction.
3. Context awareness.
4. Inline interaction.
5. Keyboard-first usability.
6. No dependency on the Agent chat panel.
7. Complete user control over generated changes and terminal commands.

### 1.4 Target Users

Developers who use Cursor or VS Code and prefer fast, focused AI assistance over conversational agent workflows.

---

## 2. Core User Experience

### 2.1 Universal Shortcut

The extension must expose a single primary shortcut:

- macOS: `Cmd+K`
- Windows/Linux: `Ctrl+K`

Behavior must depend on the currently focused component.

| Focus | Behavior |
|---|---|
| Code editor, with selection | Edit selected code |
| Code editor, no selection | Generate code at cursor |
| Terminal | Generate terminal command |
| Inline prompt already open | Focus the existing prompt |
| Unsupported context | Do nothing or display a nonintrusive notice |

The extension should not open any persistent panels or conversations.

### 2.2 Design Principles

- The interaction must happen near the user's current working area.
- Never navigate the user away from their file or terminal unnecessarily.
- Never automatically execute generated terminal commands.
- Never apply unapproved code changes permanently.
- Allow iterative follow-up prompts.
- Minimize mouse interactions.
- Prefer a single keyboard shortcut and Enter-based workflow.

---

## 3. Feature Requirements

### 3.1 Feature A — Inline Code Editing

**Priority:** P0 — Essential

#### User Story

As a developer, I want to select a block of code, press `Cmd+K`, and describe a modification so that AI can update only that code without starting an Agent conversation.

#### Workflow

1. User highlights code inside an editor.
2. User presses `Cmd+K`.
3. A small AI input interface appears next to the selected code.
4. User enters an instruction.
5. User presses `Enter`.
6. AI generates a replacement for the selected code.
7. The editor displays the proposed changes.
8. User accepts, rejects, or refines them.

#### Example

Selected code:

```javascript
const users = await db.query("SELECT * FROM users");
```

Instruction:

> Add pagination using limit and offset.

Result:

```javascript
const users = await db.query(
  "SELECT * FROM users LIMIT ? OFFSET ?",
  [limit, offset]
);
```

#### Functional Requirements

- FR-001: Detect the selected text and its original range.
- FR-002: Retrieve file language and relevant surrounding code.
- FR-003: Display a compact, contextual prompt.
- FR-004: Send the selection, surrounding context, and instruction to the configured LLM.
- FR-005: Generate replacement code.
- FR-006: Present differences between original and generated code.
- FR-007: Allow accepting or rejecting modifications.
- FR-008: Allow additional instructions that refine the current result.
- FR-009: Preserve indentation, formatting conventions, and existing code structure.
- FR-010: Restrict modifications to the selected range by default.
- FR-011: Support cancellation during generation.
- FR-012: Preserve the original code if generation fails.
- FR-013: Support standard Undo/Redo after accepting changes.

#### Acceptance Criteria

- Editing must not require opening Agent.
- The selected code is the primary target.
- Code outside the selection must remain unchanged unless explicitly authorized.
- Users can preview and reject edits.
- The workflow remains within the current editor.

---

### 3.2 Feature B — Generate Code Without Selection

**Priority:** P0 — Essential

#### User Story

As a developer, I want to press `Cmd+K` without selecting code and describe what to generate so the result is inserted at my current cursor position.

#### Workflow

1. User places the cursor inside a file.
2. User presses `Cmd+K`.
3. The inline input appears.
4. User describes the desired code.
5. AI generates code using the surrounding context.
6. A preview appears at the insertion point.
7. User accepts or rejects it.

#### Example

Instruction:

> Create a function that retries an async operation three times with exponential backoff.

The extension generates the function using the current file's language and conventions.

#### Functional Requirements

- FR-014: Identify cursor position.
- FR-015: Automatically gather nearby code context.
- FR-016: Include enclosing function/class context when available.
- FR-017: Generate code compatible with the current programming language.
- FR-018: Preview generated code at the cursor.
- FR-019: Allow acceptance, rejection, and refinement.
- FR-020: Prevent unrelated file modifications.

---

### 3.3 Feature C — Quick Question Mode

**Priority:** P1 — High

#### User Story

As a developer, I want to ask a question about selected code without requesting a modification.

#### Workflow

1. Select code.
2. Press `Cmd+K`.
3. Switch to question mode using `Alt+Enter`.
4. Enter a question.
5. Receive a concise explanation inside the inline interface.
6. Optionally convert the answer into an edit.

#### Examples

- "What does this function do?"
- "Is there a memory leak here?"
- "Why could this query be slow?"
- "How would you improve this logic?"

#### Functional Requirements

- FR-021: Provide Edit and Question modes.
- FR-022: Support switching modes without losing the selection.
- FR-023: Display answers without modifying the file.
- FR-024: Allow follow-up questions.
- FR-025: Support instructions such as "do it" to convert a suggestion into a code edit.

---

### 3.4 Feature D — Terminal Command Generation

**Priority:** P0 — Essential

#### User Story

As a developer, I want to press `Cmd+K` inside the integrated terminal, describe a command in plain English, and receive the generated command directly in that terminal.

This functionality must closely reproduce Cursor's previous terminal `Cmd+K`.

#### Workflow

1. User focuses the integrated terminal.
2. User presses `Cmd+K`.
3. A compact prompt appears near the terminal input.
4. User describes the desired operation.
5. User presses `Enter`.
6. AI generates a shell command.
7. The command is inserted into the focused terminal without executing it.
8. User may edit the command and execute it manually.

#### Example

Instruction:

> Find every process listening on port 3000.

Generated command:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

Another example:

> Show me all Docker containers using more than 500MB of memory.

The extension produces an appropriate Docker-based shell command.

#### Functional Requirements

- FR-026: Detect whether the integrated terminal is focused.
- FR-027: Identify the active terminal instance.
- FR-028: Detect shell type when available (zsh, bash, PowerShell, etc.).
- FR-029: Obtain current working directory where supported.
- FR-030: Generate a command appropriate to the detected shell and operating system.
- FR-031: Insert the generated command into the original terminal.
- FR-032: Do not execute the command automatically.
- FR-033: Permit editing the generated command before execution.
- FR-034: Support cancellation of command generation.
- FR-035: Avoid creating an additional terminal unnecessarily.
- FR-036: Preserve the original terminal's working context.
- FR-037: Clearly distinguish generated commands from executed commands.

#### Important UX Requirement

Generating a terminal command must not require opening an AI chat panel or copying a command manually.

The ideal interaction is:

`Cmd+K` → Describe → `Enter` → Command appears in terminal.

#### Error Handling

If terminal insertion is unavailable or unsafe, display the command in a compact interface with a Copy action.

Never silently execute a generated command.

---

### 3.5 Feature E — Context Awareness

**Priority:** P1 — High

The extension must provide enough context for useful results without turning every request into a comprehensive codebase search.

#### Editor Context

Include when applicable:

- Selected code.
- Current language.
- Filename.
- Relevant code before and after the selection.
- Enclosing function or class.
- Current file imports.
- Project-level conventions, when explicitly configured.

#### Terminal Context

Include when available:

- Operating system.
- Shell type.
- Current working directory.
- Relevant recent command and output.
- Current workspace identity.

#### Requirements

- FR-038: Establish a configurable context-size limit.
- FR-039: Prioritize selected code and nearby lines.
- FR-040: Avoid automatically scanning the entire repository.
- FR-041: Support manually adding files or code snippets as context.
- FR-042: Prevent secrets and environment files from being automatically included.
- FR-043: Respect workspace exclusions.

---

### 3.6 Feature F — Iterative Refinement

**Priority:** P1 — High

The original Cursor workflow allowed follow-up modifications without reopening a new conversation.

QuickK must support the same behavior.

#### Example

Initial instruction:

> Convert this function to async.

Follow-up:

> Add proper error handling.

Second follow-up:

> Return null instead of throwing.

The extension must maintain the local edit session's context.

#### Requirements

- FR-044: Preserve original code throughout the active editing session.
- FR-045: Maintain a short history of instructions and generated results.
- FR-046: Allow subsequent prompts to modify the latest proposed version.
- FR-047: Provide an option to reject all session changes.
- FR-048: Clear session context on explicit dismissal.
- FR-049: Prevent unrelated edits from corrupting the active session.

---

### 3.7 Feature G — Code Review and Diff

**Priority:** P0 — Essential

Before permanent acceptance, AI-generated changes must be reviewable.

#### Requirements

- FR-050: Highlight inserted lines.
- FR-051: Highlight removed lines.
- FR-052: Show the original and modified versions.
- FR-053: Provide Accept and Reject actions.
- FR-054: Support keyboard-first acceptance and rejection.
- FR-055: Restore the original state if changes are rejected.
- FR-056: Detect conflicts when the user or another extension changes the same document during generation.

Prefer in-editor diff decorations. A separate diff view is an acceptable technical fallback, but is less desirable.

---

## 4. Interface Requirements

### 4.1 Inline Prompt

The primary interface should be a compact input placed near the selected code or cursor.

It should include:

- Text input.
- Edit/Question mode indicator.
- Submit control.
- Cancel control.
- Loading/progress indicator.
- Optional model indicator.

The prompt must not occupy a large part of the editor.

### 4.2 Terminal Prompt

The terminal interface should resemble the original lightweight command input.

It should:

- Appear near the terminal's input area where supported.
- Avoid opening a webview panel or Agent chat.
- Keep the terminal visible.
- Return focus to the terminal when finished.

Because VS Code does not expose every internal terminal rendering hook, an anchored terminal overlay may require an approximation using supported UI APIs.

### 4.3 Keyboard Interactions

| Shortcut | Action |
|---|---|
| `Cmd+K` | Open contextual AI prompt |
| `Enter` | Submit prompt |
| `Escape` | Dismiss/cancel |
| `Alt+Enter` | Switch to Quick Question mode |
| `Cmd+Shift+Enter` | Request full-file editing |
| `Cmd+Enter` | Accept proposed editor changes |
| `Cmd+Backspace` | Reject proposed editor changes |

Shortcuts must be configurable to prevent conflicts with other installed extensions.

Exact behavior may depend on editor keyboard focus and the active UI component.

---

## 5. Technical Architecture

### 5.1 Extension Platform

- TypeScript
- VS Code Extension API
- Compatible with Cursor's extension environment
- Node.js extension host
- No separate backend required for basic functionality

### 5.2 Core Components

**Shortcut & Context Router**

Determines whether the user is in the editor or terminal, then routes the request to the appropriate handler.

**Editor Interaction Controller**

Manages selections, cursor positions, document context, previews, and application of edits.

**Terminal Interaction Controller**

Handles terminal focus, shell context, generated commands, and nonexecuting command insertion.

**AI Provider Adapter**

Provides a standardized interface for multiple LLM services.

**Prompt Context Builder**

Constructs bounded, relevant context for each request.

**Diff & Session Manager**

Tracks original and generated code, revisions, user decisions, and document conflicts.

**UI Controller**

Handles compact input widgets, loading states, questions, and review actions.

### 5.3 LLM Integration

Support configurable AI providers, initially:

- OpenAI
- Anthropic
- Custom OpenAI-compatible API endpoints

Configuration should include:

- API key stored in VS Code SecretStorage.
- Model selection.
- Custom API endpoint where applicable.
- Request timeout.
- Maximum output tokens.
- Context-size limits.
- Temperature or equivalent parameters when supported.

The extension should not depend on Cursor's internal Agent infrastructure or proprietary APIs.

### 5.4 Response Handling

Use streaming when supported by the provider.

For code edits, require structured results that clearly identify the intended replacement or insertion.

Validate responses before applying changes.

Do not assume the LLM always returns valid code or correctly scoped edits.

---

## 6. Nonfunctional Requirements

### 6.1 Performance

Responsiveness is a core product requirement.

Targets:

- Shortcut-to-input visibility: less than 150 ms at p95.
- Context gathering for ordinary selections: less than 300 ms at p95.
- Terminal command generation: target first visible response within 1 second under favorable network/provider conditions.
- Avoid unnecessary repository-wide indexing.
- Avoid unnecessary tool calls.
- Keep the extension host responsive during requests.

LLM response times depend on the configured model and network connection; the extension cannot guarantee one-second generation.

### 6.2 Reliability

- Handle API errors without modifying original code.
- Support request cancellation.
- Avoid double submission.
- Prevent stale responses from overwriting newer changes.
- Preserve editor state during generation.
- Detect document changes before applying a proposed edit.

### 6.3 Security

- API keys must never appear in logs.
- Do not execute generated terminal commands automatically.
- Clearly warn about potentially destructive commands.
- Respect workspace trust settings.
- Avoid sending known secrets or excluded files automatically.
- Minimize source-code data sent to external providers.
- Make provider use and code transmission transparent.

### 6.4 Privacy

No telemetry by default.

If telemetry is later added, it must be optional and must not collect source code, prompts, secrets, or terminal output.

---

## 7. MVP Scope

### 7.1 Must Have — Phase 1

- Context-sensitive `Cmd+K`.
- Inline code editing on selected text.
- Code generation without selection.
- Terminal command generation.
- Insert terminal commands without execution.
- Accept/reject generated code.
- Compact prompt.
- Model/provider configuration.
- API key management.
- Basic cancellation and error handling.
- Cursor and VS Code compatibility.

### 7.2 Phase 2

- Quick Question mode.
- Iterative follow-up prompts.
- Full-file editing.
- Better inline diff presentation.
- Automatic shell context retrieval.
- User-defined prompt templates.
- Manually attached project files as context.

### 7.3 Phase 3

- Enhanced language-server integration.
- Symbol-aware context gathering.
- Optional project rules support.
- Improved terminal output awareness.
- Multiple model profiles.
- Performance optimization and prompt caching.

---

## 8. Out of Scope

QuickK is not intended to replace Cursor Agent.

The following are explicitly excluded from the initial product:

- Autonomous multi-file modifications.
- Autonomous repository exploration.
- Background agents.
- Automatic terminal execution.
- Multi-step task planning.
- Persistent AI chat sessions.
- Cloud-hosted agent orchestration.
- Browser automation.
- Automatic deployment.
- Agent-style tool-calling loops.

The product must remain focused on fast, local interactions.

---

## 9. Technical Constraints and Risks

### 9.1 Inline UI Fidelity

VS Code extensions do not expose all of Cursor's original internal inline editing UI components.

Exact placement, styling, and behavior may not be reproducible using public APIs alone.

**Mitigation:** Use supported editor decorations, input widgets, and diff views to approximate the original interaction while preserving functionality.

### 9.2 Terminal UI Fidelity

Public extension APIs provide terminal interaction capabilities but do not permit unrestricted modification of the integrated terminal's native interface.

**Mitigation:** Build the closest supported interaction, with a compact Quick Input fallback.

### 9.3 Terminal Context Availability

Shell type, working directory, previous commands, and output may not always be accessible.

**Mitigation:** Use VS Code Shell Integration where available, and degrade gracefully when unavailable.

### 9.4 Shortcut Conflicts

`Cmd+K` can be bound to other editor commands.

**Mitigation:** Contribute context-specific keybindings and provide installation guidance for resolving conflicts.

### 9.5 AI Quality and Latency

Different models produce different output quality and response times.

**Mitigation:** Make providers configurable and use concise, task-specific prompts.

### 9.6 Cursor Compatibility

Cursor is based on VS Code but may customize keyboard handling and extension behavior.

**Mitigation:** Test all supported workflows in current Cursor builds rather than assuming VS Code compatibility guarantees identical behavior.

---

## 10. Success Criteria

The extension is successful when developers can complete the original core `Cmd+K` interactions without opening Agent.

### Acceptance Test 1 — Selected Code

Given a selected JavaScript function, when the user presses `Cmd+K` and requests a refactor, the extension must present a reviewable replacement in the same file.

### Acceptance Test 2 — Empty Selection

Given a cursor position in a TypeScript file, when the user presses `Cmd+K` and requests a helper function, the extension must generate code at the insertion point.

### Acceptance Test 3 — Terminal Command

Given an active zsh terminal, when the user presses `Cmd+K` and requests a shell command, the extension must generate and insert the command into that terminal without executing it.

### Acceptance Test 4 — Rejection

Given a pending code change, when the user rejects it, the original code must remain intact.

### Acceptance Test 5 — Follow-up

Given an active code-edit session, when the user submits a follow-up instruction, the extension must refine the current proposal without requiring a new Agent session.

### Acceptance Test 6 — API Failure

Given a failed LLM request, the extension must show a clear error, preserve original code, and allow retry.

### Acceptance Test 7 — Context Switching

Given an editor and an integrated terminal, `Cmd+K` must invoke the correct workflow based on focus.

---

## 11. Definition of Done

The MVP is complete when:

1. The extension installs successfully in Cursor and VS Code.
2. The contextual keyboard shortcut works in both editor and terminal.
3. Selected code can be modified through natural-language instructions.
4. New code can be generated at the cursor.
5. Proposed edits can be accepted or rejected.
6. Terminal commands can be generated and inserted without execution.
7. No Agent panel is required for any MVP workflow.
8. API keys are stored securely.
9. Errors do not cause unintended code modifications or command execution.
10. The core workflows work reliably using only documented extension APIs.

---

## 12. Product Philosophy

**QuickK is not an AI agent; it serves as an AI-enhanced editing and command-generation tool.**

It should seamlessly integrate with the developer's keyboard, rather than act as a competing assistant.

The desired interaction is prompt, focused, contextual, and ephemeral.

Developers should be able to fulfill a request and resume their work without departing from their current editor or terminal.

**The quality of the experience is more important than the quantity of features.**
