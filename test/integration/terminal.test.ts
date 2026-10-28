import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { MockServer, startMockServer } from "../support/mockServer";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) {
      return true;
    }
    await sleep(100);
  }
  return check();
}

describe("terminal flow", function () {
  let server: MockServer;
  let terminal: vscode.Terminal;
  let calls: Array<[string, boolean | undefined]>;
  let realSendText: (text: string, addNewLine?: boolean) => void;

  before(async () => {
    server = await startMockServer(() => ({ content: "echo hi" }));
    await vscode.workspace.getConfiguration("quickk").update("baseUrl", server.url, vscode.ConfigurationTarget.Global);
    await vscode.extensions.getExtension("quickk.quickk")!.activate();

    terminal = vscode.window.createTerminal({ name: "quickk-test" });
    terminal.show();
    await sleep(1500);
    // Record every call to sendText but still call the real function.
    realSendText = terminal.sendText.bind(terminal);
    (terminal as any).sendText = (text: string, addNewLine?: boolean) => {
      calls.push([text, addNewLine]);
      realSendText(text, addNewLine);
    };
  });

  beforeEach(() => {
    calls = [];
    server.requests.length = 0;
  });

  after(async () => {
    terminal.dispose();
    await server.close();
  });

  it("test 3: inserts the command into the active terminal and does not run it", async () => {
    const marker = path.join(os.tmpdir(), `quickk-marker-${Date.now()}`);
    server.respond = () => ({ content: `\`\`\`bash\ntouch ${marker}\n\`\`\`` });
    assert.strictEqual(vscode.window.activeTerminal, terminal);

    await vscode.commands.executeCommand("quickk.terminal", { instruction: "create a marker file" });

    assert.deepStrictEqual(calls, [[`touch ${marker}`, false]]);
    await sleep(1500);
    assert.strictEqual(fs.existsSync(marker), false, "the command must not run");

    // Control check: the same text with a line break does run. This proves the test can see a run.
    const control = path.join(os.tmpdir(), `quickk-control-${Date.now()}`);
    realSendText(`touch ${control}`, true);
    assert.ok(await waitFor(() => fs.existsSync(control), 5000), "control command did not run");

    for (const file of [marker, control]) {
      fs.rmSync(file, { force: true });
    }
  });

  it("sends OS and shell information to the model", async () => {
    await vscode.commands.executeCommand("quickk.terminal", { instruction: "say hi" });
    const system = server.requests[0].messages[0].content as string;
    assert.ok(system.includes(process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux"));
    assert.ok(/Shell: \S+/.test(system));
  });

  it("does not insert several commands", async () => {
    server.respond = () => ({ content: "cd app\nnpm test" });
    await vscode.commands.executeCommand("quickk.terminal", { instruction: "test the app" });
    assert.deepStrictEqual(calls, []);
  });

  it("does not insert commands with control characters", async () => {
    // A carriage return in the middle would press Enter in the terminal.
    server.respond = () => ({ content: "echo hi\rrm important" });
    await vscode.commands.executeCommand("quickk.terminal", { instruction: "say hi" });
    assert.deepStrictEqual(calls, []);
  });

  it("removes a trailing carriage return instead of sending it", async () => {
    server.respond = () => ({ content: "echo hi\r" });
    await vscode.commands.executeCommand("quickk.terminal", { instruction: "say hi" });
    assert.deepStrictEqual(calls, [["echo hi", false]]);
  });

  it("does not insert anything when the API fails", async () => {
    server.respond = () => ({ status: 500 });
    await vscode.commands.executeCommand("quickk.terminal", { instruction: "say hi" });
    assert.deepStrictEqual(calls, []);
  });

  it("does not create another terminal", async () => {
    server.respond = () => ({ content: "echo hi" });
    const before = vscode.window.terminals.length;
    await vscode.commands.executeCommand("quickk.terminal", { instruction: "say hi" });
    assert.strictEqual(vscode.window.terminals.length, before);
  });
});
