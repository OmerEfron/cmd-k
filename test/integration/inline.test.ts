import * as assert from "assert";
import * as vscode from "vscode";
import { MockServer, startMockServer } from "../support/mockServer";
import type { QuickKApi } from "../../src/extension";

// Undo and Redo scenarios, streaming, follow-ups and question mode.
// The undo rules do not depend on the inline box, so these tests also run in the fallback mode.

const ORIGINAL_LINE = "  const a = 1;";
const ORIGINAL = `function f() {\n${ORIGINAL_LINE}\n}\n`;
const rev = (name: string) => `  const ${name} = 2;`;
const withBlock = (green: string, kept = true) =>
  `function f() {\n${kept ? ORIGINAL_LINE + "\n" : ""}${green}\n}\n`;
const reply = (code: string) => ({ content: "```js\n" + code + "\n```" });

let server: MockServer;
let api: QuickKApi;

const text = (doc: vscode.TextDocument) => doc.getText().replace(/\r\n/g, "\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      assert.fail(`Timed out waiting for: ${what}`);
    }
    await sleep(20);
  }
}

async function openDoc(content: string) {
  const doc = await vscode.workspace.openTextDocument({ content, language: "javascript" });
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(1, 0, 1, ORIGINAL_LINE.length);
  return { doc, editor };
}

const ask = (instruction: string) => vscode.commands.executeCommand("quickk.editor", { instruction });
// The inline box may hold the keyboard focus. These helpers act like a user who pressed the key in the editor.
// (Undo from inside the box is tested separately with the "undo" message.)
async function undo() {
  await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  await vscode.commands.executeCommand("undo");
}
async function redo() {
  await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  await vscode.commands.executeCommand("redo");
}

describe("inline flow: undo, redo, stream, follow-up, question", function () {
  this.timeout(20000);

  before(async () => {
    const extension = vscode.extensions.getExtension("quickk.quickk");
    assert.ok(extension);
    api = (await extension.activate()) as QuickKApi;
    server = await startMockServer(() => reply(rev("b")));
    await vscode.workspace.getConfiguration("quickk").update("baseUrl", server.url, vscode.ConfigurationTarget.Global);
  });

  beforeEach(() => {
    server.requests.length = 0;
    server.respond = () => reply(rev("b"));
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  after(async () => {
    await server.close();
  });

  // ------------------------------------------------------------ undo scenarios

  it("scenario 2: Undo while the model writes removes the partial code and stops the request", async () => {
    server.respond = () => ({
      chunks: ["```js\n  const b = 1;\n  const c = 2;\n  const d = 3;\n", "  const e = 4;\n```"],
      chunkDelayMs: 1200,
    });
    const { doc } = await openDoc(ORIGINAL);

    const running = ask("many lines");
    await until(() => text(doc).includes("const b = 1;"), "the first lines to appear");
    assert.ok(api.debug(doc.uri).sessionState === "generating");

    await undo();
    await running;

    assert.strictEqual(text(doc), ORIGINAL);
    assert.ok(!api.isPending(doc.uri));
    assert.strictEqual(api.debug(doc.uri).sessionState, undefined);
  });

  it("stops with the cancel command and puts the original back", async () => {
    server.respond = () => ({
      chunks: ["```js\n  const b = 1;\n  const c = 2;\n  const d = 3;\n", "  const e = 4;\n```"],
      chunkDelayMs: 1200,
    });
    const { doc } = await openDoc(ORIGINAL);

    const running = ask("many lines");
    await until(() => text(doc).includes("const b = 1;"), "the first lines to appear");
    await vscode.commands.executeCommand("quickk.cancel");
    await running;

    assert.strictEqual(text(doc), ORIGINAL);
    assert.ok(!api.isPending(doc.uri));
  });

  it("streams the lines into the file before the answer is complete", async () => {
    server.respond = () => ({
      chunks: ["```js\n  const b = 1;\n  const c = 2;\n  const d = 3;\n", "  const e = 4;\n```"],
      chunkDelayMs: 500,
    });
    const { doc } = await openDoc(ORIGINAL);

    const running = ask("many lines");
    await until(() => text(doc).includes("const b = 1;"), "the first lines to appear");
    assert.ok(!text(doc).includes("const e = 4;"), "the last line must not be there yet");
    await running;

    assert.strictEqual(
      text(doc),
      `function f() {\n${ORIGINAL_LINE}\n  const b = 1;\n  const c = 2;\n  const d = 3;\n  const e = 4;\n}\n`
    );
    assert.strictEqual(api.debug(doc.uri).sessionState, "review");

    // The whole stream is one undo step.
    await undo();
    assert.strictEqual(text(doc), ORIGINAL);
  });

  it("scenario 3: Undo in review restores the original, Redo brings the proposal back", async () => {
    const { doc } = await openDoc(ORIGINAL);
    await ask("change");
    const proposal = text(doc);
    assert.strictEqual(proposal, withBlock(rev("b")));

    await undo();
    assert.strictEqual(text(doc), ORIGINAL);
    assert.ok(!api.isPending(doc.uri));

    await redo();
    assert.strictEqual(text(doc), proposal);
    assert.ok(api.isPending(doc.uri), "the review must come back with Redo");

    await vscode.commands.executeCommand("quickk.accept");
    assert.strictEqual(text(doc), withBlock(rev("b"), false));
  });

  it("scenario 4: Undo after Accept brings the review back, and again the original", async () => {
    const { doc } = await openDoc(ORIGINAL);
    await ask("change");
    await vscode.commands.executeCommand("quickk.accept");
    assert.strictEqual(text(doc), withBlock(rev("b"), false));
    assert.ok(!api.isPending(doc.uri));

    await undo();
    assert.strictEqual(text(doc), withBlock(rev("b")));
    assert.ok(api.isPending(doc.uri), "the review must come back");
    assert.strictEqual(api.debug(doc.uri).sessionState, "review");

    await undo();
    assert.strictEqual(text(doc), ORIGINAL);
    assert.ok(!api.isPending(doc.uri));

    await redo();
    assert.strictEqual(text(doc), withBlock(rev("b")));
    assert.ok(api.isPending(doc.uri));
  });

  it("scenario 5: Undo after Reject brings the review back", async () => {
    const { doc } = await openDoc(ORIGINAL);
    await ask("change");
    await vscode.commands.executeCommand("quickk.reject");
    assert.strictEqual(text(doc), ORIGINAL);

    await undo();
    assert.strictEqual(text(doc), withBlock(rev("b")));
    assert.ok(api.isPending(doc.uri));

    await vscode.commands.executeCommand("quickk.accept");
    assert.strictEqual(text(doc), withBlock(rev("b"), false));
  });

  it("scenario 6: follow-ups undo one revision at a time", async () => {
    const { doc } = await openDoc(ORIGINAL);
    await ask("first");
    server.respond = () => reply(rev("c"));
    await ask("second");
    assert.strictEqual(text(doc), withBlock(rev("c")));
    assert.strictEqual(api.debug(doc.uri).revisions, 2);

    await undo();
    assert.strictEqual(text(doc), withBlock(rev("b")), "one Undo goes back one revision");
    assert.ok(api.isPending(doc.uri));
    assert.strictEqual(api.debug(doc.uri).current, 0);

    await undo();
    assert.strictEqual(text(doc), ORIGINAL);
    assert.ok(!api.isPending(doc.uri));

    await redo();
    assert.strictEqual(text(doc), withBlock(rev("b")));
    await redo();
    assert.strictEqual(text(doc), withBlock(rev("c")));
    assert.ok(api.isPending(doc.uri));
    assert.strictEqual(api.debug(doc.uri).current, 1);

    await vscode.commands.executeCommand("quickk.reject");
    assert.strictEqual(text(doc), ORIGINAL);
  });

  it("scenario 7: Undo and Redo of an edit below the block do not touch the review", async () => {
    const { doc, editor } = await openDoc(ORIGINAL);
    await ask("change");
    const proposal = text(doc);

    await editor.edit((builder) => builder.insert(new vscode.Position(doc.lineCount - 1, 0), "// end\n"));
    assert.ok(api.isPending(doc.uri));
    await undo();
    assert.strictEqual(text(doc), proposal);
    assert.ok(api.isPending(doc.uri), "Undo of an unrelated edit must keep the review");
    await redo();
    assert.strictEqual(text(doc), proposal + "// end\n");
    assert.ok(api.isPending(doc.uri));
  });

  it("scenario 8: Undo of a user edit inside the block brings the review back", async () => {
    const { doc, editor } = await openDoc(ORIGINAL);
    await ask("change");
    const proposal = text(doc);

    // Line 2 is the green line.
    await editor.edit((builder) => builder.insert(new vscode.Position(2, 2), "/* mine */ "));
    assert.ok(!api.isPending(doc.uri), "a user edit inside the block ends the review");

    await undo();
    assert.strictEqual(text(doc), proposal);
    assert.ok(api.isPending(doc.uri), "Undo of the user edit must bring the review back");
    await vscode.commands.executeCommand("quickk.reject");
    assert.strictEqual(text(doc), ORIGINAL);
  });

  it("follow-up on a generated block (no selection) works and is rejectable", async () => {
    const doc = await vscode.workspace.openTextDocument({ content: "const a = 1;\nconst b = 2;\n", language: "javascript" });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 12, 0, 12);
    server.respond = () => reply("function h() {}");
    await ask("add h");
    assert.strictEqual(text(doc), "const a = 1;\nfunction h() {}\nconst b = 2;\n");
    server.respond = () => reply("function h() { return 1; }");
    await ask("return one");
    assert.strictEqual(text(doc), "const a = 1;\nfunction h() { return 1; }\nconst b = 2;\n");
    await vscode.commands.executeCommand("quickk.reject");
    assert.strictEqual(text(doc), "const a = 1;\nconst b = 2;\n");
  });

  it("a follow-up that fails keeps the first proposal", async () => {
    const { doc } = await openDoc(ORIGINAL);
    await ask("first");
    const proposal = text(doc);
    server.respond = () => ({ status: 500, errorMessage: "boom" });
    await ask("second");
    assert.strictEqual(text(doc), proposal);
    assert.ok(api.isPending(doc.uri));
    assert.strictEqual(api.debug(doc.uri).sessionState, "review");
  });

  it("a follow-up that returns the same code changes nothing", async () => {
    const { doc } = await openDoc(ORIGINAL);
    await ask("first");
    const proposal = text(doc);
    await ask("same again");
    assert.strictEqual(text(doc), proposal);
    assert.strictEqual(api.debug(doc.uri).revisions, 1);
  });

  // ------------------------------------------------------------ the inline box

  describe("with the inline box", function () {
    before(function () {
      // The API always has the function, so the run script tells us if the proposed API is on.
      if (process.env.QUICKK_NO_PROPOSED || !api.inlineAvailable()) {
        this.skip();
      }
    });

    it("opens above the code and shows the review state", async () => {
      const { doc } = await openDoc(ORIGINAL);
      await ask("change");
      const info = api.debug(doc.uri);
      assert.ok(info.widgetOpen, "the box must be open");
      assert.strictEqual(info.phase, "review");
      await until(() => api.debug(doc.uri).widgetReady, "the page to load");
    });

    it("Escape closes the box and keeps the proposal; Accept still works", async () => {
      const { doc } = await openDoc(ORIGINAL);
      await ask("change");
      await api.simulate(doc.uri, { type: "escape" });
      assert.ok(!api.debug(doc.uri).widgetOpen);
      assert.ok(api.isPending(doc.uri));
      await vscode.commands.executeCommand("quickk.accept");
      assert.strictEqual(text(doc), withBlock(rev("b"), false));
    });

    it("Escape in the box stops a running request", async () => {
      server.respond = () => ({
        chunks: ["```js\n  const b = 1;\n  const c = 2;\n  const d = 3;\n", "  const e = 4;\n```"],
        chunkDelayMs: 1200,
      });
      const { doc } = await openDoc(ORIGINAL);
      await vscode.commands.executeCommand("quickk.editor");
      const running = api.simulate(doc.uri, { type: "submit", text: "many", mode: "edit" });
      await until(() => text(doc).includes("const b = 1;"), "the first lines to appear");
      await api.simulate(doc.uri, { type: "escape" });
      await running;
      assert.strictEqual(text(doc), ORIGINAL);
      assert.ok(!api.isPending(doc.uri));
      assert.ok(api.debug(doc.uri).widgetOpen, "the box stays open so the user can edit the text");
      assert.strictEqual(api.debug(doc.uri).phase, "typing");
    });

    it("Accept and Reject from the box act on the proposal", async () => {
      const { doc } = await openDoc(ORIGINAL);
      await ask("change");
      await api.simulate(doc.uri, { type: "reject" });
      assert.strictEqual(text(doc), ORIGINAL);
      assert.ok(!api.debug(doc.uri).widgetOpen);

      await ask("change");
      await api.simulate(doc.uri, { type: "accept" });
      assert.strictEqual(text(doc), withBlock(rev("b"), false));
      assert.ok(!api.debug(doc.uri).widgetOpen);
    });

    it("a request from the box with the text of a follow-up creates a revision", async () => {
      const { doc } = await openDoc(ORIGINAL);
      await vscode.commands.executeCommand("quickk.editor");
      await api.simulate(doc.uri, { type: "submit", text: "first", mode: "edit" });
      server.respond = () => reply(rev("c"));
      await api.simulate(doc.uri, { type: "submit", text: "second", mode: "edit" });
      assert.strictEqual(text(doc), withBlock(rev("c")));
      assert.strictEqual(api.debug(doc.uri).revisions, 2);
    });

    it("question mode answers in the box and does not change the file", async () => {
      server.respond = () => ({ content: "It adds **one** to a." });
      const { doc } = await openDoc(ORIGINAL);
      await vscode.commands.executeCommand("quickk.editor");
      await api.simulate(doc.uri, { type: "submit", text: "what does this do?", mode: "question" });

      const info = api.debug(doc.uri);
      assert.strictEqual(info.phase, "answered");
      assert.strictEqual(info.answer, "It adds **one** to a.");
      assert.strictEqual(text(doc), ORIGINAL);
      assert.ok(!api.isPending(doc.uri));
      const system = server.requests[0].messages[0].content as string;
      assert.ok(/question/i.test(system), "the question prompt must be used");
    });

    it("'do it' after a question sends the conversation and creates an edit", async () => {
      server.respond = () => ({ content: "Because it is a constant." });
      const { doc } = await openDoc(ORIGINAL);
      await vscode.commands.executeCommand("quickk.editor");
      await api.simulate(doc.uri, { type: "submit", text: "why const?", mode: "question" });

      server.respond = () => reply(rev("b"));
      await api.simulate(doc.uri, { type: "submit", text: "ok, rename it", mode: "edit" });

      const user = server.requests[1].messages.map((m: any) => String(m.content)).join("\n");
      assert.ok(user.includes("why const?"));
      assert.ok(user.includes("Because it is a constant."));
      assert.ok(user.includes("ok, rename it"));
      assert.strictEqual(text(doc), withBlock(rev("b")));
      assert.strictEqual(api.debug(doc.uri).phase, "review");
    });

    it("a failing question shows the error and leaves the file alone", async () => {
      server.respond = () => ({ status: 500, errorMessage: "boom" });
      const { doc } = await openDoc(ORIGINAL);
      await vscode.commands.executeCommand("quickk.editor");
      await api.simulate(doc.uri, { type: "submit", text: "why?", mode: "question" });
      assert.strictEqual(api.debug(doc.uri).phase, "error");
      assert.strictEqual(text(doc), ORIGINAL);
    });

    it("Undo of a review closes the box, and Redo opens it again with the review", async () => {
      const { doc } = await openDoc(ORIGINAL);
      await ask("change");
      await undo();
      assert.strictEqual(text(doc), ORIGINAL);
      assert.ok(!api.debug(doc.uri).widgetOpen, "the box goes away with the proposal");

      await redo();
      const info = api.debug(doc.uri);
      assert.strictEqual(text(doc), withBlock(rev("b")));
      assert.ok(info.widgetOpen, "the box must come back with the review");
      assert.strictEqual(info.phase, "review");
    });

    it("Undo and Redo pressed inside the (empty) box act on the document", async () => {
      const { doc } = await openDoc(ORIGINAL);
      server.respond = () => reply(rev("c"));
      await ask("change");
      await until(() => api.debug(doc.uri).widgetReady, "the page to load");

      await api.simulate(doc.uri, { type: "undo" });
      assert.strictEqual(text(doc), ORIGINAL);
      assert.ok(!api.debug(doc.uri).widgetOpen, "the box goes away with the proposal");

      // The box is gone, so the user presses Redo in the editor.
      await redo();
      assert.strictEqual(text(doc), withBlock(rev("c")));
      assert.ok(api.isPending(doc.uri));
      assert.ok(api.debug(doc.uri).widgetOpen);
    });

    it("Undo inside the box goes back one revision when there are two", async () => {
      const { doc } = await openDoc(ORIGINAL);
      await ask("first");
      server.respond = () => reply(rev("c"));
      await ask("second");
      await until(() => api.debug(doc.uri).widgetReady, "the page to load");

      await api.simulate(doc.uri, { type: "undo" });
      assert.strictEqual(text(doc), withBlock(rev("b")));
      assert.ok(api.debug(doc.uri).widgetOpen, "the review is still there, so the box stays");
      assert.strictEqual(api.debug(doc.uri).phase, "review");
    });

    it("Undo while the model writes keeps the box open so the user can try again", async () => {
      server.respond = () => ({
        chunks: ["```js\n  const b = 1;\n  const c = 2;\n  const d = 3;\n", "  const e = 4;\n```"],
        chunkDelayMs: 1200,
      });
      const { doc } = await openDoc(ORIGINAL);
      await vscode.commands.executeCommand("quickk.editor");
      const running = api.simulate(doc.uri, { type: "submit", text: "many", mode: "edit" });
      await until(() => text(doc).includes("const b = 1;"), "the first lines to appear");
      await undo();
      await running;
      assert.strictEqual(text(doc), ORIGINAL);
      const info = api.debug(doc.uri);
      assert.ok(info.widgetOpen);
      assert.strictEqual(info.phase, "typing");
    });
  });
});
