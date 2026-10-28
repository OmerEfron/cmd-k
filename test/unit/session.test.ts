import * as assert from "assert";
import {
  classifyChanges,
  extendsLines,
  matchRevision,
  maxRegionLength,
  pendingLines,
  SessionShape,
} from "../../src/editor/sessionHistory";
import { FenceStream, writableLines } from "../../src/util/streamFence";

function collect(parts: string[]): string[] {
  const stream = new FenceStream();
  const lines: string[] = [];
  for (const part of parts) {
    lines.push(...stream.push(part));
  }
  lines.push(...stream.finish());
  return lines;
}

describe("FenceStream", () => {
  it("returns code lines of a fenced block as they complete", () => {
    const stream = new FenceStream();
    assert.deepStrictEqual(stream.push("```js\nconst a"), []);
    assert.deepStrictEqual(stream.push(" = 1;\nconst b = 2;\n"), ["const a = 1;", "const b = 2;"]);
    assert.deepStrictEqual(stream.push("```\nThanks!"), []);
    assert.deepStrictEqual(stream.finish(), []);
  });

  it("handles fences that are split between chunks", () => {
    assert.deepStrictEqual(collect(["``", "`ts\nlet x;\n``", "`"]), ["let x;"]);
  });

  it("treats an answer without a fence as code", () => {
    assert.deepStrictEqual(collect(["foo();\nbar();"]), ["foo();", "bar();"]);
  });

  it("returns the last line that has no line break", () => {
    assert.deepStrictEqual(collect(["```\na\nb"]), ["a", "b"]);
  });

  it("keeps shorter fences inside a longer fence", () => {
    assert.deepStrictEqual(collect(["````md\n```js\ncode\n```\n````\n"]), ["```js", "code", "```"]);
  });

  it("handles Windows line breaks", () => {
    assert.deepStrictEqual(collect(["```\r\na\r\nb\r\n```\r\n"]), ["a", "b"]);
  });

  it("ignores text after the closing fence", () => {
    assert.deepStrictEqual(collect(["```\na\n```\nmore text\n```\nignored\n```"]), ["a"]);
  });
});

describe("writableLines", () => {
  it("holds back the last line", () => {
    assert.deepStrictEqual(writableLines(["a", "b", "c"]), ["a", "b"]);
    assert.deepStrictEqual(writableLines(["a"]), []);
  });

  it("never writes blank lines at the start or the end", () => {
    assert.deepStrictEqual(writableLines(["", "a", "b", "", ""]), ["a"]);
    assert.deepStrictEqual(writableLines(["", ""]), []);
  });

  it("keeps blank lines inside the code", () => {
    assert.deepStrictEqual(writableLines(["a", "", "b", "c"]), ["a", "", "b"]);
  });
});

const edit: SessionShape = {
  mode: "edit",
  startLine: 3,
  originalLines: ["old1", "old2"],
  revisions: [
    { instruction: "one", lines: ["new1"] },
    { instruction: "two", lines: ["new1", "new2"] },
  ],
};

function doc(lines: string[]) {
  return (line: number) => lines[line];
}

describe("session history", () => {
  it("shows original and new lines in edit mode", () => {
    assert.deepStrictEqual(pendingLines(edit, ["x"]), ["old1", "old2", "x"]);
    assert.deepStrictEqual(pendingLines({ mode: "insert", originalLines: [] }, ["x"]), ["x"]);
  });

  it("finds the revision that is in the document", () => {
    const base = ["a", "b", "c"];
    assert.strictEqual(matchRevision(edit, doc([...base, "old1", "old2", "new1"])), 0);
    assert.strictEqual(matchRevision(edit, doc([...base, "old1", "old2", "new1", "new2", "d"])), 1);
  });

  it("finds nothing for the original text, the accepted text or other text", () => {
    const base = ["a", "b", "c"];
    assert.strictEqual(matchRevision(edit, doc([...base, "old1", "old2", "d"])), undefined);
    assert.strictEqual(matchRevision(edit, doc([...base, "new1", "new2"])), undefined);
    assert.strictEqual(matchRevision(edit, doc([...base, "old1"])), undefined);
  });

  it("prefers the newest matching revision", () => {
    const same: SessionShape = {
      mode: "insert",
      startLine: 0,
      originalLines: [],
      revisions: [
        { instruction: "a", lines: ["x"] },
        { instruction: "b", lines: ["x"] },
      ],
    };
    assert.strictEqual(matchRevision(same, doc(["x"])), 1);
  });

  it("knows the largest block size", () => {
    assert.strictEqual(maxRegionLength(edit), 4);
    assert.strictEqual(maxRegionLength({ ...edit, revisions: [] }, 7), 7);
  });

  it("detects prefix extension", () => {
    assert.ok(extendsLines(["a"], ["a", "b"]));
    assert.ok(!extendsLines(["a"], ["a"]));
    assert.ok(!extendsLines(["a"], ["x", "b"]));
    assert.ok(!extendsLines([], []));
  });
});

describe("classifyChanges", () => {
  it("shifts the block for changes above it", () => {
    // Two lines added at line 0.
    assert.deepStrictEqual(classifyChanges(5, 3, [{ startLine: 0, endLine: 0, addedLines: 2 }]), {
      shift: 2,
      touched: false,
      spanning: false,
    });
    // Three lines removed above.
    assert.strictEqual(classifyChanges(5, 3, [{ startLine: 0, endLine: 3, addedLines: 0 }]).shift, -3);
  });

  it("ignores changes below the block", () => {
    const effect = classifyChanges(5, 3, [{ startLine: 8, endLine: 8, addedLines: 1 }]);
    assert.deepStrictEqual(effect, { shift: 0, touched: false, spanning: false });
  });

  it("detects changes inside the block", () => {
    assert.ok(classifyChanges(5, 3, [{ startLine: 5, endLine: 5, addedLines: 0 }]).touched);
    assert.ok(classifyChanges(5, 3, [{ startLine: 7, endLine: 7, addedLines: 0 }]).touched);
  });

  it("detects a change that spans into the block", () => {
    assert.ok(classifyChanges(5, 3, [{ startLine: 2, endLine: 5, addedLines: 0 }]).spanning);
  });

  it("treats a block of length zero as having no inside", () => {
    assert.deepStrictEqual(classifyChanges(5, 0, [{ startLine: 5, endLine: 5, addedLines: 0 }]), {
      shift: 0,
      touched: false,
      spanning: false,
    });
  });
});
