import * as assert from "assert";
import { buildEditorContext } from "../../src/context/editorContext";
import { buildEditorMessages, fence, INSERT_MARKER, terminalSystemPrompt } from "../../src/prompts";

function numbered(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `line ${i}`);
}

describe("buildEditorContext", () => {
  it("splits before, selection and after", () => {
    const context = buildEditorContext({
      lines: numbered(10),
      beforeEnd: 4,
      afterStart: 6,
      contextLines: 2,
      maxContextChars: 10000,
    });
    assert.strictEqual(context.before, "line 2\nline 3");
    assert.strictEqual(context.selection, "line 4\nline 5");
    assert.strictEqual(context.after, "line 6\nline 7");
  });

  it("limits the window with contextLines", () => {
    const context = buildEditorContext({
      lines: numbered(100),
      beforeEnd: 50,
      afterStart: 51,
      contextLines: 3,
      maxContextChars: 10000,
    });
    assert.strictEqual(context.before.split("\n").length, 3);
    assert.strictEqual(context.after.split("\n").length, 3);
  });

  it("keeps the lines closest to the selection when the budget is small", () => {
    const context = buildEditorContext({
      lines: numbered(100),
      beforeEnd: 50,
      afterStart: 51,
      contextLines: 40,
      maxContextChars: 6 + 2 * 21, // selection + about 3 lines per side
    });
    assert.ok(context.before.endsWith("line 49"));
    assert.ok(context.after.startsWith("line 51"));
    assert.ok(context.before.split("\n").length <= 3);
  });

  it("always sends the whole selection", () => {
    const lines = ["x".repeat(500), "y".repeat(500), "after"];
    const context = buildEditorContext({ lines, beforeEnd: 0, afterStart: 2, contextLines: 10, maxContextChars: 100 });
    assert.strictEqual(context.selection.length, 1001);
    assert.strictEqual(context.after, "");
  });

  it("collects imports that are not in the before window", () => {
    const lines = ["import a from 'a';", "import b from 'b';", ...numbered(30), "const x = 1;"];
    const context = buildEditorContext({
      lines,
      beforeEnd: 32,
      afterStart: 33,
      contextLines: 5,
      maxContextChars: 10000,
    });
    assert.strictEqual(context.imports, "import a from 'a';\nimport b from 'b';");
  });

  it("does not repeat imports that are already in the before window", () => {
    const lines = ["import a from 'a';", "const x = 1;"];
    const context = buildEditorContext({ lines, beforeEnd: 1, afterStart: 2, contextLines: 5, maxContextChars: 10000 });
    assert.strictEqual(context.imports, "");
    assert.ok(context.before.includes("import a"));
  });
});

describe("prompts", () => {
  it("uses a fence longer than the backticks in the code", () => {
    assert.strictEqual(fence("a ``` b", "md"), "````md\na ``` b\n````");
  });

  it("puts the insert marker between before and after in generate mode", () => {
    const messages = buildEditorMessages({
      mode: "generate",
      fileName: "a.ts",
      languageId: "typescript",
      instruction: "add helper",
      context: { before: "const a = 1;", selection: "", after: "const b = 2;", imports: "" },
    });
    const user = messages[1].content;
    assert.ok(user.indexOf("const a = 1;") < user.indexOf(INSERT_MARKER));
    assert.ok(user.indexOf(INSERT_MARKER) < user.indexOf("const b = 2;"));
    assert.ok(user.includes("Instruction: add helper"));
  });

  it("shows the selection in edit mode", () => {
    const messages = buildEditorMessages({
      mode: "edit",
      fileName: "a.js",
      languageId: "javascript",
      instruction: "paginate",
      context: { before: "", selection: "db.query()", after: "", imports: "" },
    });
    assert.ok(messages[1].content.includes("Selection to rewrite:"));
    assert.ok(messages[1].content.includes("db.query()"));
    assert.ok(!messages[1].content.includes("Code before"));
  });

  it("describes the terminal", () => {
    const prompt = terminalSystemPrompt({ platform: "darwin", shell: "zsh", cwd: "/work" });
    assert.ok(prompt.includes("macOS"));
    assert.ok(prompt.includes("zsh"));
    assert.ok(prompt.includes("/work"));
  });
});
