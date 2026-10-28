// Client for OpenAI-compatible chat completion APIs.
// This file must not import "vscode", so it can be unit tested with plain Node.

export interface ProviderSettings {
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** null means: do not send the temperature field. */
  temperature: number | null;
  timeoutMs: number;
  apiKey?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ProviderErrorKind = "http" | "timeout" | "network" | "truncated" | "empty" | "format";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: ProviderErrorKind,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Thrown when the caller cancels the request. */
export class CancelledError extends Error {
  constructor() {
    super("Request cancelled");
    this.name = "CancelledError";
  }
}

export interface CompletionResult {
  text: string;
  finishReason: string | null;
}

export interface CompleteOptions {
  signal?: AbortSignal;
  /** Called with each new piece of text while the answer streams in. */
  onDelta?: (delta: string, totalLength: number) => void;
  fetchImpl?: typeof fetch;
}

/**
 * Splits a Server-Sent Events byte stream into "data:" payloads.
 * Chunks can end in the middle of a line, so we keep the incomplete part.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    return this.readLines(lines);
  }

  /** Call at the end of the stream to read a last line without a line break. */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return this.readLines([rest]);
  }

  private readLines(lines: string[]): string[] {
    const payloads: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload.length > 0) {
          payloads.push(payload);
        }
      }
    }
    return payloads;
  }
}

export interface ParsedPayload {
  done: boolean;
  delta: string;
  finishReason: string | null;
}

/** Reads one SSE payload (a JSON string, or [DONE]). */
export function parsePayload(payload: string): ParsedPayload {
  if (payload === "[DONE]") {
    return { done: true, delta: "", finishReason: null };
  }
  let json: any;
  try {
    json = JSON.parse(payload);
  } catch {
    throw new ProviderError("The API sent a stream chunk that is not valid JSON.", "format");
  }
  if (json && json.error) {
    throw new ProviderError(describeApiError(json), "http");
  }
  const choice = json?.choices?.[0];
  const delta = typeof choice?.delta?.content === "string" ? choice.delta.content : "";
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  return { done: false, delta, finishReason };
}

function describeApiError(json: any): string {
  const message = json?.error?.message ?? json?.message;
  return typeof message === "string" && message.length > 0 ? message : "The API returned an error.";
}

export function buildUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "") + "/chat/completions";
}

export function buildRequestBody(settings: ProviderSettings, messages: ChatMessage[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    stream: true,
    max_tokens: settings.maxTokens,
  };
  if (settings.temperature !== null) {
    body.temperature = settings.temperature;
  }
  return body;
}

/** True when the URL points to this computer. Local servers often need no API key. */
export function isLocalUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

export async function complete(
  settings: ProviderSettings,
  messages: ChatMessage[],
  options: CompleteOptions = {}
): Promise<CompletionResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, settings.timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      throw new CancelledError();
    }
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    };
    if (settings.apiKey) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    const response = await doFetch(buildUrl(settings.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(buildRequestBody(settings, messages)),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ProviderError(await readErrorMessage(response), "http", response.status);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return await readJsonBody(response, options);
    }
    return await readStream(response, options);
  } catch (error) {
    if (error instanceof ProviderError || error instanceof CancelledError) {
      throw error;
    }
    if (timedOut) {
      throw new ProviderError(`The request timed out after ${settings.timeoutMs} ms.`, "timeout");
    }
    if (options.signal?.aborted) {
      throw new CancelledError();
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`Could not reach the API: ${reason}`, "network");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    // Ignore: we still report the status code.
  }
  let detail = text.slice(0, 300);
  try {
    detail = describeApiError(JSON.parse(text));
  } catch {
    // Not JSON: use the plain text.
  }
  const suffix = detail ? `: ${detail}` : "";
  return `The API answered with status ${response.status}${suffix}`;
}

async function readJsonBody(response: Response, options: CompleteOptions): Promise<CompletionResult> {
  const json: any = await response.json();
  if (json?.error) {
    throw new ProviderError(describeApiError(json), "http");
  }
  const choice = json?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  if (text) {
    options.onDelta?.(text, text.length);
  }
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  return { text, finishReason };
}

async function readStream(response: Response, options: CompleteOptions): Promise<CompletionResult> {
  if (!response.body) {
    throw new ProviderError("The API sent an empty response.", "empty");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let text = "";
  let finishReason: string | null = null;
  let finished = false;

  const handle = (payloads: string[]) => {
    for (const payload of payloads) {
      const parsed = parsePayload(payload);
      if (parsed.done) {
        finished = true;
        return;
      }
      if (parsed.delta) {
        text += parsed.delta;
        options.onDelta?.(parsed.delta, text.length);
      }
      if (parsed.finishReason) {
        finishReason = parsed.finishReason;
      }
    }
  };

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    handle(parser.push(decoder.decode(value, { stream: true })));
  }
  if (!finished) {
    handle(parser.push(decoder.decode()));
    handle(parser.flush());
  }
  reader.cancel().catch(() => undefined);
  return { text, finishReason };
}
