// A tiny OpenAI-compatible server for tests and for manual curl checks.
//
// Run it by hand:   node out/test/support/mockServer.js
// Then:             curl -N localhost:8787/v1/chat/completions -d '{"messages":[{"role":"user","content":"hi"}]}'

import * as http from "http";

export interface MockReply {
  content?: string;
  finishReason?: string;
  /** HTTP status. Anything other than 200 sends an error body. */
  status?: number;
  errorMessage?: string;
  delayMs?: number;
  /** Send the answer in these pieces instead of three equal ones. */
  chunks?: string[];
  /** Wait this long after each piece. */
  chunkDelayMs?: number;
}

export type Responder = (body: any) => MockReply;

export interface MockServer {
  url: string;
  requests: any[];
  headers: http.IncomingHttpHeaders[];
  respond: Responder;
  close(): Promise<void>;
}

export async function startMockServer(initial: Responder, port = 0): Promise<MockServer> {
  const state: MockServer = {
    url: "",
    requests: [],
    headers: [],
    respond: initial,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // Keep an empty body: the responder decides what to do.
      }
      state.requests.push(body);
      state.headers.push(req.headers);
      const reply = state.respond(body);
      if (reply.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      }

      if (reply.status && reply.status !== 200) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: reply.errorMessage ?? "mock error" } }));
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      const content = reply.content ?? "";
      const size = Math.max(1, Math.ceil(content.length / 3));
      const pieces: string[] = reply.chunks ?? [];
      if (!reply.chunks) {
        for (let i = 0; i < content.length; i += size) {
          pieces.push(content.slice(i, i + size));
        }
      }
      for (const piece of pieces) {
        if (closed) {
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        if (reply.chunkDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, reply.chunkDelayMs));
        }
      }
      if (closed) {
        return;
      }
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reply.finishReason ?? "stop" }] })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  state.url = `http://127.0.0.1:${actualPort}/v1`;
  return state;
}

if (require.main === module) {
  startMockServer((body) => {
    const system = String(body?.messages?.[0]?.content ?? "");
    if (system.includes("terminal")) {
      return { content: "lsof -nP -iTCP:3000 -sTCP:LISTEN" };
    }
    return { content: "```js\nconst users = await db.query(\n  'SELECT * FROM users LIMIT ? OFFSET ?',\n  [limit, offset]\n);\n```" };
  }, 8787).then((server) => console.log(`Mock server at ${server.url}`));
}
