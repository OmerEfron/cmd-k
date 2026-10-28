import * as assert from "assert";
import * as vscode from "vscode";
import { MockServer, startMockServer } from "../support/mockServer";
import type { QuickKApi } from "../../src/extension";

const FUNCTION_REPLY =
  "```js\nconst users = await db.query(\n  \"SELECT * FROM users LIMIT ? OFFSET ?\",\n  [limit, offset]\n);\n```";
const ORIGINAL_LINE = '  const users = await db.query("SELECT * FROM users");';
const NEW_LINES = [
  "  const users = await db.query(",
  '    "SELECT * FROM users LIMIT ? OFFSET ?",',
  "    [limit, offset]",
  "  );",
].join("\n");

let server: MockServer;
let api: QuickKApi;

async function openDoc(content: string, language = "javascript") {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  const editor = await vscode.window.showTextDocument(doc);
  return { doc, editor };
}

function selectLines(editor: vscode.TextEditor, first: number, last: number) {
  editor.selection = new vscode.Selection(first, 0, last, editor.document.lineAt(last).text.length);
}

function cursorAt(editor: vscode.TextEditor, line: number) {
  const position = new vscode.Position(line, editor.document.lineAt(line).text.length);
  editor.selection = new vscode.Selection(position, position);
}

const text = (doc: vscode.TextDocument) => doc.getText().replace(/\r\n/g, "\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("editor flow", function () {
  before(async () => {
    const extension = vscode.extensions.getExtension("quickk.quickk");
    assert.ok(extension, "extension not found");
    api = (await extension.activate()) as QuickKApi;
    server = await startMockServer(() => ({ content: FUNCTION_REPLY }));
    await vscode.workspace.getConfiguration("quickk").update("baseUrl", server.url, vscode.ConfigurationTarget.Global);
  });

  beforeEach(() => {
    server.requests.length = 0;
    server.respond = () => ({ content: FUNCTION_REPLY });
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  after(async () => {
    await server.close();
  });

  it("test 1: edits a selection and shows both versions for review", async () => {
    const { doc, editor } = await openDoc(`function a() {\n${ORIGINAL_LINE}\n}\n`);
    selectLines(editor, 1, 1);

    await vscode.commands.executeCommand("quickk.editor", { instruction: "Add pagination using limit and offset." });

    assert.strictEqual(text(doc), `function a() {\n${ORIGINAL_LINE}\n${NEW_LINES}\n}\n`);
    assert.ok(api.isPending(doc.uri));

    const user = server.requests[0].messages[1].content as string;
    assert.ok(user.includes("Add pagination using limit and offset."));
    assert.ok(user.includes(ORIGINAL_LINE));
    assert.strictEqual(server.requests[0].stream, true);

    await vscode.commands.executeCommand("quickk.accept");
    assert.strictEqual(text(doc), `function a() {\n${NEW_LINES}\n}\n`);
    assert.ok(!api.isPending(doc.uri));
  });

  it("re-indents code that the model returned without indentation", async () => {
    server.respond = () => ({ content: "```js\nconst x = 1;\nconst y = 2;\n```" });
    const { doc, editor } = await openDoc("function a() {\n  const old = 0;\n}\n");
    selectLines(editor, 1, 1);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "rename" });
    await vscode.commands.executeCommand("quickk.accept");
    assert.strictEqual(text(doc), "function a() {\n  const x = 1;\n  const y = 2;\n}\n");
  });

  it("test 4: reject keeps the original code exactly", async () => {
    const original = `function a() {\n${ORIGINAL_LINE}\n}\n`;
    const { doc, editor } = await openDoc(original);
    selectLines(editor, 1, 1);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    assert.notStrictEqual(text(doc), original);

    await vscode.commands.executeCommand("quickk.reject");
    assert.strictEqual(text(doc), original);
    assert.ok(!api.isPending(doc.uri));
  });

  it("works with Windows line breaks", async () => {
    const { doc, editor } = await openDoc(`function a() {\r\n${ORIGINAL_LINE}\r\n}\r\n`);
    assert.strictEqual(doc.eol, vscode.EndOfLine.CRLF);
    selectLines(editor, 1, 1);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    await vscode.commands.executeCommand("quickk.accept");
    assert.strictEqual(doc.getText(), `function a() {\r\n${NEW_LINES.replace(/\n/g, "\r\n")}\r\n}\r\n`);
  });

  it("uses whole lines when the selection starts in the middle of a line", async () => {
    const { doc, editor } = await openDoc(`function a() {\n${ORIGINAL_LINE}\n}\n`);
    editor.selection = new vscode.Selection(1, 10, 1, 20);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    await vscode.commands.executeCommand("quickk.accept");
    assert.strictEqual(text(doc), `function a() {\n${NEW_LINES}\n}\n`);
  });

  it("test 2: generates code below a code line when nothing is selected", async () => {
    server.respond = () => ({ content: "```ts\nfunction helper(): number {\n  return 1;\n}\n```" });
    const { doc, editor } = await openDoc("const a = 1;\nconst b = 2;\n", "typescript");
    cursorAt(editor, 0);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "add a helper" });
    assert.strictEqual(text(doc), "const a = 1;\nfunction helper(): number {\n  return 1;\n}\nconst b = 2;\n");
    assert.ok(api.isPending(doc.uri));
    assert.ok((server.requests[0].messages[1].content as string).includes("<<<INSERT CODE HERE>>>"));

    await vscode.commands.executeCommand("quickk.reject");
    assert.strictEqual(text(doc), "const a = 1;\nconst b = 2;\n");
  });

  it("generates in place on a blank line, and reject restores the blank line", async () => {
    server.respond = () => ({ content: "```js\n  return 1;\n```" });
    const original = "function a() {\n  \n}\n";
    const { doc, editor } = await openDoc(original);
    cursorAt(editor, 1);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "return one" });
    assert.strictEqual(text(doc), "function a() {\n  return 1;\n}\n");

    await vscode.commands.executeCommand("quickk.reject");
    assert.strictEqual(text(doc), original);

    await vscode.commands.executeCommand("quickk.editor", { instruction: "return one" });
    await vscode.commands.executeCommand("quickk.accept");
    assert.strictEqual(text(doc), "function a() {\n  return 1;\n}\n");
  });

  it("test 6: an API error leaves the document untouched", async () => {
    server.respond = () => ({ status: 500, errorMessage: "boom" });
    const original = `function a() {\n${ORIGINAL_LINE}\n}\n`;
    const { doc, editor } = await openDoc(original);
    selectLines(editor, 1, 1);
    const versionBefore = doc.version;

    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    assert.strictEqual(text(doc), original);
    assert.strictEqual(doc.version, versionBefore);
    assert.ok(!api.isPending(doc.uri));
  });

  it("does not use an answer that was cut off by the token limit", async () => {
    server.respond = () => ({ content: "```js\nconst partial = (", finishReason: "length" });
    const original = `function a() {\n${ORIGINAL_LINE}\n}\n`;
    const { doc, editor } = await openDoc(original);
    selectLines(editor, 1, 1);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    assert.strictEqual(text(doc), original);
    assert.ok(!api.isPending(doc.uri));
  });

  it("does not change the document for an empty answer", async () => {
    server.respond = () => ({ content: "```js\n```" });
    const original = `function a() {\n${ORIGINAL_LINE}\n}\n`;
    const { doc, editor } = await openDoc(original);
    selectLines(editor, 1, 1);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    assert.strictEqual(text(doc), original);
  });

  it("follows an edit above the block while the model works", async () => {
    server.respond = () => ({ content: FUNCTION_REPLY, delayMs: 500 });
    const original = `function a() {\n${ORIGINAL_LINE}\n}\n`;
    const { doc, editor } = await openDoc(original);
    selectLines(editor, 1, 1);

    const running = vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    await sleep(150);
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "// hi\n"));
    await running;

    assert.strictEqual(text(doc), `// hi\nfunction a() {\n${ORIGINAL_LINE}\n${NEW_LINES}\n}\n`);
    assert.ok(api.isPending(doc.uri));
  });

  it("stops and leaves the file as it is when the user types inside the block while the model works", async () => {
    server.respond = () => ({ content: FUNCTION_REPLY, delayMs: 500 });
    const original = `function a() {\n${ORIGINAL_LINE}\n}\n`;
    const { doc, editor } = await openDoc(original);
    selectLines(editor, 1, 1);

    const running = vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    await sleep(150);
    await editor.edit((builder) => builder.insert(new vscode.Position(1, 2), "/* mine */ "));
    await running;

    assert.ok(text(doc).includes("/* mine */"));
    assert.ok(!text(doc).includes("LIMIT ? OFFSET ?"), "no model code may be written after the user typed");
    assert.ok(!api.isPending(doc.uri));
  });

  it("test 5/6: a failed request can be retried with the same instruction", async () => {
    let calls = 0;
    server.respond = () => (++calls === 1 ? { status: 503, errorMessage: "busy" } : { content: FUNCTION_REPLY });
    const { doc, editor } = await openDoc(`function a() {\n${ORIGINAL_LINE}\n}\n`);
    selectLines(editor, 1, 1);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    assert.ok(!api.isPending(doc.uri));
    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    assert.ok(api.isPending(doc.uri));
  });

  it("a second instruction while a change is pending is a follow-up", async () => {
    const { doc, editor } = await openDoc(`function a() {\n${ORIGINAL_LINE}\n}\n`);
    selectLines(editor, 1, 1);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    server.respond = () => ({ content: "```js\nconst users = [];\n```" });
    await vscode.commands.executeCommand("quickk.editor", { instruction: "make it an empty array" });
    assert.strictEqual(server.requests.length, 2);
    const user = server.requests[1].messages[1].content as string;
    assert.ok(user.includes("make it an empty array"));
    assert.ok(user.includes("paginate"), "the follow-up must carry the earlier instruction");
    assert.strictEqual(text(doc), `function a() {\n${ORIGINAL_LINE}\n  const users = [];\n}\n`);

    await vscode.commands.executeCommand("quickk.accept");
    assert.strictEqual(text(doc), "function a() {\n  const users = [];\n}\n");
  });

  it("follows edits above the proposal", async () => {
    const { doc, editor } = await openDoc(`// top\nfunction a() {\n${ORIGINAL_LINE}\n}\n`);
    selectLines(editor, 2, 2);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });

    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "// one\n// two\n"));
    assert.ok(api.isPending(doc.uri), "edit above must not end the review");

    await vscode.commands.executeCommand("quickk.accept");
    assert.strictEqual(text(doc), `// one\n// two\n// top\nfunction a() {\n${NEW_LINES}\n}\n`);
  });

  it("ignores edits below the proposal", async () => {
    const { doc, editor } = await openDoc(`function a() {\n${ORIGINAL_LINE}\n}\n`);
    selectLines(editor, 1, 1);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    await editor.edit((builder) => builder.insert(new vscode.Position(doc.lineCount - 1, 0), "// end\n"));
    assert.ok(api.isPending(doc.uri));
    await vscode.commands.executeCommand("quickk.reject");
    assert.strictEqual(text(doc), `function a() {\n${ORIGINAL_LINE}\n}\n// end\n`);
  });

  it("ends the review without more edits when the user edits the proposal", async () => {
    const { doc, editor } = await openDoc(`function a() {\n${ORIGINAL_LINE}\n}\n`);
    selectLines(editor, 1, 1);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    const oldLine = 1;
    await editor.edit((builder) => builder.insert(new vscode.Position(oldLine, 2), "/* mine */ "));
    assert.ok(!api.isPending(doc.uri));

    const afterEdit = text(doc);
    await vscode.commands.executeCommand("quickk.accept");
    await vscode.commands.executeCommand("quickk.reject");
    assert.strictEqual(text(doc), afterEdit, "accept and reject must not change the file after the review ended");
  });

  it("undo goes back to the original code", async () => {
    const original = `function a() {\n${ORIGINAL_LINE}\n}\n`;
    const { doc, editor } = await openDoc(original);
    selectLines(editor, 1, 1);
    await vscode.commands.executeCommand("quickk.editor", { instruction: "paginate" });
    await vscode.commands.executeCommand("quickk.accept");
    await vscode.commands.executeCommand("undo");
    await vscode.commands.executeCommand("undo");
    assert.strictEqual(text(doc), original);
  });
});
