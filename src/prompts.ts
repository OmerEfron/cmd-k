import { EditorContext } from "./context/editorContext";
import { ChatMessage } from "./provider/openaiCompatible";

export const INSERT_MARKER = "<<<INSERT CODE HERE>>>";

export interface TerminalContext {
  platform: string;
  shell?: string;
  cwd?: string;
}

const EDIT_SYSTEM = [
  "You are a precise code editing engine inside a code editor.",
  "The user gives an instruction and a block of code called the selection.",
  "Rewrite ONLY the selection so that it follows the instruction.",
  "Rules:",
  "- Reply with exactly one fenced code block that contains the complete replacement for the selection, and nothing else.",
  "- Do not repeat code that is before or after the selection.",
  "- Keep the existing indentation style, naming and conventions.",
  "- Do not explain your changes and do not add comments about them, unless the user asks for it.",
].join("\n");

const GENERATE_SYSTEM = [
  "You are a precise code generation engine inside a code editor.",
  `The user gives an instruction and some code around the marker ${INSERT_MARKER}.`,
  "Write new code that will be inserted at the marker.",
  "Rules:",
  "- Reply with exactly one fenced code block that contains only the new code, and nothing else.",
  "- Indent the code exactly as it must appear in the file at the marker.",
  "- Do not repeat the code around the marker.",
  "- Use the language, style and naming of the surrounding code.",
  "- Do not explain the code.",
].join("\n");

export function terminalSystemPrompt(context: TerminalContext): string {
  const lines = [
    "You turn a plain-English request into one command for the user's terminal.",
    `Operating system: ${describePlatform(context.platform)}.`,
    `Shell: ${context.shell ?? "unknown (assume the default shell of the operating system)"}.`,
  ];
  if (context.cwd) {
    lines.push(`Current directory: ${context.cwd}`);
  }
  lines.push(
    "Rules:",
    "- Reply with the command only. It must be on a single line.",
    "- No explanation, no comments, no markdown, no code fences.",
    "- Use tools that are normally installed on this operating system.",
    "- Use a pipe or && only when it is really needed.",
    "- Never wrap the command in a shell prompt sign like $."
  );
  return lines.join("\n");
}

export function describePlatform(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

const FOLLOWUP_SYSTEM = [
  "You are a precise code editing engine inside a code editor.",
  "You already proposed a replacement for a selection. The user now gives a follow-up instruction.",
  "Write the NEW complete replacement for the ORIGINAL selection. Start from your current proposal and apply the follow-up instruction.",
  "Rules:",
  "- Reply with exactly one fenced code block that contains the complete replacement for the original selection, and nothing else.",
  "- Do not repeat code that is before or after the selection.",
  "- Keep the existing indentation style, naming and conventions.",
  "- Do not explain your changes.",
].join("\n");

const FOLLOWUP_GENERATE_SYSTEM = [
  "You are a precise code generation engine inside a code editor.",
  `You already proposed new code for the position of the marker ${INSERT_MARKER}. The user now gives a follow-up instruction.`,
  "Write the NEW complete code for that position. Start from your current proposal and apply the follow-up instruction.",
  "Rules:",
  "- Reply with exactly one fenced code block that contains only the new code, and nothing else.",
  "- Indent the code exactly as it must appear in the file at the marker.",
  "- Do not repeat the code around the marker.",
  "- Do not explain the code.",
].join("\n");

const QUESTION_SYSTEM = [
  "You answer questions about code inside a code editor.",
  "Rules:",
  "- Be concise: a few short sentences or a short list.",
  "- Use Markdown. Put code in fenced code blocks and keep code snippets short.",
  "- Do not rewrite the whole selection unless the user asks for it.",
  "- If you suggest a change, describe it in words or with a small snippet. The user can tell you to apply it.",
].join("\n");

/** A question of the user and the answer of the model. */
export interface QuestionTurn {
  question: string;
  answer: string;
}

export interface EditPromptInput {
  mode: "edit" | "generate";
  fileName: string;
  languageId: string;
  instruction: string;
  context: EditorContext;
  /** Earlier questions and answers. Used when the user says "do it" after a question. */
  conversation?: QuestionTurn[];
}

const MAX_HISTORY = 5;

function conversationText(conversation: QuestionTurn[] | undefined): string[] {
  if (!conversation || conversation.length === 0) {
    return [];
  }
  const turns = conversation.slice(-MAX_HISTORY).map((turn) => `Question: ${turn.question}\nAnswer: ${turn.answer}`);
  return ["Conversation so far (the instruction below may refer to it):", turns.join("\n\n")];
}

export interface FollowUpPromptInput {
  mode: "edit" | "generate";
  fileName: string;
  languageId: string;
  context: EditorContext;
  /** The current proposal (the new code). */
  proposal: string;
  /** Earlier instructions of this session, oldest first. The last one belongs to the current proposal. */
  instructions: string[];
  instruction: string;
}

export function buildFollowUpMessages(input: FollowUpPromptInput): ChatMessage[] {
  const { context, languageId } = input;
  const parts: string[] = [`File: ${input.fileName}`, `Language: ${languageId}`];
  if (context.imports) {
    parts.push("Imports at the top of the file:", fence(context.imports, languageId));
  }
  if (input.mode === "edit") {
    if (context.before) {
      parts.push("Code before the selection:", fence(context.before, languageId));
    }
    parts.push("Original selection:", fence(context.selection, languageId));
    if (context.after) {
      parts.push("Code after the selection:", fence(context.after, languageId));
    }
  } else {
    const around = [context.before, INSERT_MARKER, context.after].filter((part) => part !== "").join("\n");
    parts.push("Code around the insert position:", fence(around, languageId));
  }
  const previous = input.instructions.slice(-MAX_HISTORY);
  if (previous.length > 0) {
    parts.push("Earlier instructions, oldest first:", previous.map((text, i) => `${i + 1}. ${text}`).join("\n"));
  }
  parts.push("Your current proposal:", fence(input.proposal, languageId), `Follow-up instruction: ${input.instruction}`);
  return [
    { role: "system", content: input.mode === "edit" ? FOLLOWUP_SYSTEM : FOLLOWUP_GENERATE_SYSTEM },
    { role: "user", content: parts.join("\n\n") },
  ];
}

export interface QuestionPromptInput {
  fileName: string;
  languageId: string;
  context: EditorContext;
  /** True when the user selected code. Otherwise the context is the code around the cursor. */
  hasSelection: boolean;
  conversation: QuestionTurn[];
  question: string;
}

/** Messages for a question. Earlier turns are sent as real chat messages. */
export function buildQuestionMessages(input: QuestionPromptInput): ChatMessage[] {
  const { context, languageId } = input;
  const parts: string[] = [`File: ${input.fileName}`, `Language: ${languageId}`];
  if (input.hasSelection) {
    if (context.before) {
      parts.push("Code before the selection:", fence(context.before, languageId));
    }
    parts.push("Selected code:", fence(context.selection, languageId));
    if (context.after) {
      parts.push("Code after the selection:", fence(context.after, languageId));
    }
  } else {
    parts.push("Code around the cursor:", fence([context.before, context.after].filter(Boolean).join("\n"), languageId));
  }

  const messages: ChatMessage[] = [
    { role: "system", content: QUESTION_SYSTEM },
    { role: "user", content: parts.join("\n\n") },
    { role: "assistant", content: "I have read the code. What is your question?" },
  ];
  for (const turn of input.conversation.slice(-MAX_HISTORY)) {
    messages.push({ role: "user", content: turn.question }, { role: "assistant", content: turn.answer });
  }
  messages.push({ role: "user", content: input.question });
  return messages;
}

export function buildEditorMessages(input: EditPromptInput): ChatMessage[] {
  const { context, languageId } = input;
  const parts: string[] = [`File: ${input.fileName}`, `Language: ${languageId}`];

  if (context.imports) {
    parts.push("Imports at the top of the file:", fence(context.imports, languageId));
  }

  if (input.mode === "edit") {
    if (context.before) {
      parts.push("Code before the selection:", fence(context.before, languageId));
    }
    parts.push("Selection to rewrite:", fence(context.selection, languageId));
    if (context.after) {
      parts.push("Code after the selection:", fence(context.after, languageId));
    }
  } else {
    const around = [context.before, INSERT_MARKER, context.after].filter((part) => part !== "").join("\n");
    parts.push("Code around the insert position:", fence(around, languageId));
  }

  parts.push(...conversationText(input.conversation));
  parts.push(`Instruction: ${input.instruction}`);

  return [
    { role: "system", content: input.mode === "edit" ? EDIT_SYSTEM : GENERATE_SYSTEM },
    { role: "user", content: parts.join("\n\n") },
  ];
}

export function buildTerminalMessages(instruction: string, context: TerminalContext): ChatMessage[] {
  return [
    { role: "system", content: terminalSystemPrompt(context) },
    { role: "user", content: instruction },
  ];
}

/** Wraps text in a code fence that is longer than any backtick run inside the text. */
export function fence(text: string, languageId: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `${marks}${languageId}\n${text}\n${marks}`;
}
