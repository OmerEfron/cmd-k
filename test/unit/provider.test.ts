import * as assert from "assert";
import {
  buildRequestBody,
  buildUrl,
  CancelledError,
  complete,
  isLocalUrl,
  parsePayload,
  ProviderError,
  ProviderSettings,
  SseParser,
} from "../../src/provider/openaiCompatible";

const settings: ProviderSettings = {
  baseUrl: "https://example.test/v1/",
  model: "m",
  maxTokens: 100,
  temperature: 0.2,
  timeoutMs: 1000,
  apiKey: "sk-secret",
};

function sse(...events: string[]): string {
  return events.map((e) => `data: ${e}\n\n`).join("");
}

function chunk(content: string, finish: string | null = null): string {
  return JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] });
}

function streamResponse(parts: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

describe("SseParser", () => {
  it("reads data lines", () => {
    const parser = new SseParser();
    assert.deepStrictEqual(parser.push("data: a\n\ndata: b\n\n"), ["a", "b"]);
  });

  it("joins a line that is split between chunks", () => {
    const parser = new SseParser();
    assert.deepStrictEqual(parser.push("data: {\"x\""), []);
    assert.deepStrictEqual(parser.push(":1}\n\n"), ['{"x":1}']);
  });

  it("handles CRLF and ignores other fields", () => {
    const parser = new SseParser();
    assert.deepStrictEqual(parser.push(": comment\r\nevent: x\r\ndata: a\r\n\r\n"), ["a"]);
  });

  it("flush reads a last line without line break", () => {
    const parser = new SseParser();
    parser.push("data: last");
    assert.deepStrictEqual(parser.flush(), ["last"]);
  });
});

describe("parsePayload", () => {
  it("reads delta and finish reason", () => {
    assert.deepStrictEqual(parsePayload(chunk("hi", "stop")), { done: false, delta: "hi", finishReason: "stop" });
  });

  it("detects [DONE]", () => {
    assert.strictEqual(parsePayload("[DONE]").done, true);
  });

  it("accepts chunks without content", () => {
    assert.strictEqual(parsePayload(JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })).delta, "");
  });

  it("throws for an error object", () => {
    assert.throws(() => parsePayload(JSON.stringify({ error: { message: "bad" } })), /bad/);
  });

  it("throws for invalid JSON", () => {
    assert.throws(() => parsePayload("{oops"), ProviderError);
  });
});

describe("request building", () => {
  it("builds the URL without double slashes", () => {
    assert.strictEqual(buildUrl("https://example.test/v1/"), "https://example.test/v1/chat/completions");
    assert.strictEqual(buildUrl("http://localhost:11434/v1"), "http://localhost:11434/v1/chat/completions");
  });

  it("leaves out temperature when it is null", () => {
    const body = buildRequestBody({ ...settings, temperature: null }, []);
    assert.ok(!("temperature" in body));
    assert.strictEqual(buildRequestBody(settings, []).temperature, 0.2);
    assert.strictEqual(buildRequestBody(settings, []).stream, true);
  });

  it("knows local URLs", () => {
    assert.ok(isLocalUrl("http://localhost:1234/v1"));
    assert.ok(isLocalUrl("http://127.0.0.1:1234/v1"));
    assert.ok(!isLocalUrl("https://api.openai.com/v1"));
    assert.ok(!isLocalUrl("not a url"));
  });
});

describe("complete", () => {
  it("joins streamed text and sends the key", async () => {
    let seenAuth = "";
    let seenBody: any;
    const fetchImpl = (async (_url: string, init: any) => {
      seenAuth = init.headers.Authorization;
      seenBody = JSON.parse(init.body);
      return streamResponse([sse(chunk("Hel")), sse(chunk("lo", "stop"), "[DONE]")]);
    }) as unknown as typeof fetch;

    const deltas: string[] = [];
    const result = await complete(settings, [{ role: "user", content: "x" }], {
      fetchImpl,
      onDelta: (d) => deltas.push(d),
    });
    assert.strictEqual(result.text, "Hello");
    assert.strictEqual(result.finishReason, "stop");
    assert.deepStrictEqual(deltas, ["Hel", "lo"]);
    assert.strictEqual(seenAuth, "Bearer sk-secret");
    assert.strictEqual(seenBody.model, "m");
  });

  it("reports the length finish reason", async () => {
    const fetchImpl = (async () => streamResponse([sse(chunk("abc", "length"), "[DONE]")])) as unknown as typeof fetch;
    const result = await complete(settings, [], { fetchImpl });
    assert.strictEqual(result.finishReason, "length");
  });

  it("works with a plain JSON answer", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "full" }, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await complete(settings, [], { fetchImpl });
    assert.strictEqual(result.text, "full");
  });

  it("turns an HTTP error into a ProviderError without the key", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid key" } }), { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(
      () => complete(settings, [], { fetchImpl }),
      (error: any) => {
        assert.ok(error instanceof ProviderError);
        assert.strictEqual(error.status, 401);
        assert.ok(error.message.includes("Invalid key"));
        assert.ok(!error.message.includes("sk-secret"));
        return true;
      }
    );
  });

  it("reports network problems", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await assert.rejects(() => complete(settings, [], { fetchImpl }), (e: any) => e.kind === "network");
  });

  it("times out", async () => {
    const fetchImpl = ((_url: string, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    await assert.rejects(
      () => complete({ ...settings, timeoutMs: 20 }, [], { fetchImpl }),
      (e: any) => e instanceof ProviderError && e.kind === "timeout"
    );
  });

  it("can be cancelled", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_url: string, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const pending = complete(settings, [], { fetchImpl, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(() => pending, CancelledError);
  });

  it("rejects at once when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => complete(settings, [], { signal: controller.signal }), CancelledError);
  });
});
