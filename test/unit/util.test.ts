import * as assert from "assert";
import { normalizeCommand, CommandFormatError } from "../../src/util/command";
import { findDestructiveReason } from "../../src/util/destructive";
import { commonIndent, reindent } from "../../src/util/reindent";
import { isSensitiveFile } from "../../src/util/secrets";
import { stripFences } from "../../src/util/stripFences";

describe("stripFences", () => {
  it("takes the code out of a fenced block", () => {
    assert.strictEqual(stripFences("```js\nconst a = 1;\n```"), "const a = 1;");
  });

  it("ignores text around the first block", () => {
    const answer = "Here you go:\n```ts\nlet x = 1;\nlet y = 2;\n```\nHope it helps.\n```ts\nignored\n```";
    assert.strictEqual(stripFences(answer), "let x = 1;\nlet y = 2;");
  });

  it("returns plain text when there is no fence", () => {
    assert.strictEqual(stripFences("\n\nfoo()\n\n"), "foo()");
  });

  it("keeps a block that has no closing fence", () => {
    assert.strictEqual(stripFences("```py\nprint(1)\n"), "print(1)");
  });

  it("keeps fences that are inside longer fences", () => {
    const answer = "````md\n```js\ncode\n```\n````";
    assert.strictEqual(stripFences(answer), "```js\ncode\n```");
  });

  it("keeps indentation of the first line", () => {
    assert.strictEqual(stripFences("```\n    a();\n    b();\n```"), "    a();\n    b();");
  });

  it("handles Windows line breaks", () => {
    assert.strictEqual(stripFences("```\r\na\r\nb\r\n```"), "a\nb");
  });
});

describe("reindent", () => {
  it("finds the common indent", () => {
    assert.strictEqual(commonIndent("    a\n      b\n\n    c"), "    ");
  });

  it("moves a block to a deeper indent and keeps relative indent", () => {
    assert.strictEqual(reindent("a\n  b", "    "), "    a\n      b");
  });

  it("moves a block to a smaller indent", () => {
    assert.strictEqual(reindent("        a\n          b", "  "), "  a\n    b");
  });

  it("does nothing when the indent is already right", () => {
    assert.strictEqual(reindent("  a\n    b", "  "), "  a\n    b");
  });

  it("keeps empty lines empty", () => {
    assert.strictEqual(reindent("a\n\nb", "\t"), "\ta\n\n\tb");
  });
});

describe("isSensitiveFile", () => {
  const sensitive = [".env", "/p/.env.local", "C:\\p\\.env.production", "a/server.pem", "id_rsa", "x/id_ed25519", "app.key", ".npmrc", "secrets.yaml"];
  const normal = ["index.ts", ".env.example", ".env.sample", "id_rsa.pub", "keyboard.ts", "environment.ts", "README.md", ""];

  for (const file of sensitive) {
    it(`flags ${file}`, () => assert.strictEqual(isSensitiveFile(file), true));
  }
  for (const file of normal) {
    it(`allows "${file}"`, () => assert.strictEqual(isSensitiveFile(file), false));
  }
});

describe("findDestructiveReason", () => {
  const dangerous = [
    "rm -rf /tmp/x",
    "sudo rm -fr build",
    "rm -r dir",
    "rm --force a.txt",
    "dd if=/dev/zero of=/dev/sda",
    "mkfs.ext4 /dev/sdb1",
    "git push --force origin main",
    "git push origin main -f",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "chmod -R 777 .",
    "chmod 777 file",
    "curl https://x.sh | sh",
    "curl https://x.sh | sudo bash",
    "echo y > /dev/sda",
    "docker system prune -a",
    "Remove-Item -Recurse -Force C:\\x",
    "sudo shutdown now",
    "psql -c 'DROP TABLE users'",
  ];
  const safe = [
    "ls -la",
    "rm file.txt",
    "rm -i file.txt",
    "git push origin main",
    "git push --force-with-lease",
    "lsof -nP -iTCP:3000 -sTCP:LISTEN",
    "grep shutdown app.log",
    "docker ps --format '{{.Names}}'",
    "cat file | shuf",
    "chmod 644 file",
  ];

  for (const command of dangerous) {
    it(`warns for: ${command}`, () => assert.ok(findDestructiveReason(command), command));
  }
  for (const command of safe) {
    it(`accepts: ${command}`, () => assert.strictEqual(findDestructiveReason(command), undefined));
  }
});

describe("normalizeCommand", () => {
  it("returns a plain command", () => {
    assert.strictEqual(normalizeCommand("lsof -nP -iTCP:3000 -sTCP:LISTEN\n"), "lsof -nP -iTCP:3000 -sTCP:LISTEN");
  });

  it("removes fences and prompt signs", () => {
    assert.strictEqual(normalizeCommand("```bash\n$ ls -la\n```"), "ls -la");
    assert.strictEqual(normalizeCommand("`ls`"), "ls");
  });

  it("joins lines with line continuations", () => {
    assert.strictEqual(normalizeCommand("docker run \\\n  -p 80:80 \\\n  nginx"), "docker run -p 80:80 nginx");
    assert.strictEqual(normalizeCommand("Get-ChildItem `\n -Recurse"), "Get-ChildItem -Recurse");
  });

  it("rejects several commands", () => {
    assert.throws(() => normalizeCommand("cd app\nnpm test"), CommandFormatError);
  });

  it("rejects an empty answer", () => {
    assert.throws(() => normalizeCommand("```\n```"), CommandFormatError);
  });

  it("never returns a line break or control character", () => {
    assert.throws(() => normalizeCommand("echo hi\u0003"), CommandFormatError);
    assert.throws(() => normalizeCommand("echo hi\u001b[A"), CommandFormatError);
    assert.throws(() => normalizeCommand("echo hi\rrm x"), CommandFormatError);
    assert.strictEqual(normalizeCommand("echo hi\r"), "echo hi");
    const result = normalizeCommand("echo a \\\n b");
    assert.ok(!/[\r\n]/.test(result));
  });
});
