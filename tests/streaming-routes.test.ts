/**
 * End-to-end SSE event sequences for the three streaming endpoints.
 *
 * streaming-pipeline.test.ts covers what the pipeline does with the upstream
 * bytes; these tests check what a client actually receives — the event names,
 * their order, and the terminator. Each endpoint speaks a different dialect
 * (OpenAI chunks, Responses events, Anthropic events) built from the same
 * pipeline, so a change in the shared code can break one dialect and leave the
 * others looking fine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";

const env = {
  ONE_MIN_CHAT_API_URL: "https://api.1min.ai/api/chat-with-ai",
  ONE_MIN_API_URL: "https://api.1min.ai/api/features",
  ONE_MIN_ASSET_URL: "https://api.1min.ai/api/assets",
  ONE_MIN_MODELS_API_URL: "https://api.1min.ai/models",
} as Env;

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const MODELS = [
  {
    modelId: "open-mistral-nemo",
    name: "open-mistral-nemo",
    provider: "test-provider",
    status: "ACTIVE",
    features: ["UNIFY_CHAT_WITH_AI"],
    modality: { INPUT: ["text"], OUTPUT: ["text"] },
    creditMetadata: {},
  },
];

/** A healthy upstream stream: two deltas, then result + done. */
const HEALTHY_STREAM = [
  'event: content\ndata: {"content":"Hel"}',
  'event: content\ndata: {"content":"lo"}',
  'event: result\ndata: {"aiRecord":{"status":"SUCCESS"}}',
  'event: done\ndata: {"message":"Stream completed"}',
].join("\n\n");

/** HTTP 200 with an in-stream error — how the upstream reports a failure. */
const ERROR_STREAM =
  'event: content\ndata: {"content":"Par"}\n\nevent: error\ndata: {"error":"Model is not supported"}\n\n';

let streamBody = HEALTHY_STREAM;
let streamingCalls: string[];

function sseResponse(body: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of body.match(/[\s\S]{1,13}/g) ?? []) {
          controller.enqueue(encoder.encode(piece));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

beforeEach(() => {
  streamBody = HEALTHY_STREAM;
  streamingCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.startsWith("https://api.1min.ai/models")) {
        const feature = new URL(url).searchParams.get("feature") ?? "";
        return new Response(
          JSON.stringify({
            models: feature === "UNIFY_CHAT_WITH_AI" ? MODELS : [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("https://api.1min.ai/api/chat-with-ai")) {
        streamingCalls.push(url);
        return sseResponse(streamBody);
      }
      throw new Error(`unexpected upstream call: ${url}`);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function post(path: string, body: unknown) {
  return app.fetch(
    new Request(`https://relay.test${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

interface SSEEvent {
  event?: string;
  data: string;
}

/** Parse the SSE text a client would receive back into events, in order. */
function parseSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join("\n") });
  }
  return events;
}

async function streamEvents(path: string, body: unknown): Promise<SSEEvent[]> {
  const res = await post(path, body);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  return parseSSE(await res.text());
}

describe("POST /v1/chat/completions (stream: true)", () => {
  const request = {
    model: "open-mistral-nemo",
    messages: [{ role: "user", content: "ping" }],
    stream: true,
  };

  it("asks the upstream for a stream", async () => {
    await streamEvents("/v1/chat/completions", request);
    expect(streamingCalls[0]).toContain("isStreaming=true");
  });

  it("emits delta chunks, a stop chunk, then [DONE]", async () => {
    const events = await streamEvents("/v1/chat/completions", request);

    expect(events.at(-1)?.data).toBe("[DONE]");

    const chunks = events
      .slice(0, -1)
      .map((e) => JSON.parse(e.data) as {
        object: string;
        choices: Array<{
          delta: { content?: string };
          finish_reason: string | null;
        }>;
      });

    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(true);
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? null)).toEqual([
      "Hel",
      "lo",
      null,
    ]);
    expect(chunks.map((c) => c.choices[0]?.finish_reason)).toEqual([
      null,
      null,
      "stop",
    ]);
  });

  it("stops at the error instead of pretending the answer finished", async () => {
    streamBody = ERROR_STREAM;
    const events = await streamEvents("/v1/chat/completions", request);

    // The partial delta went out; nothing after it may claim completion.
    expect(events.some((e) => e.data.includes("Par"))).toBe(true);
    expect(events.some((e) => e.data === "[DONE]")).toBe(false);
    expect(events.some((e) => e.data.includes('"finish_reason":"stop"'))).toBe(
      false,
    );

    const last = JSON.parse(events.at(-1)?.data ?? "{}") as {
      error: { message: string; code: string };
    };
    expect(last.error.code).toBe("upstream_stream_error");
    expect(last.error.message).toContain("Model is not supported");
  });
});

describe("POST /v1/responses (stream: true)", () => {
  const request = {
    model: "open-mistral-nemo",
    input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
    stream: true,
  };

  it("emits the Responses lifecycle in order", async () => {
    const events = await streamEvents("/v1/responses", request);

    expect(events.map((e) => e.event ?? "[done]")).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
      "[done]", // the `data: [DONE]` line carries no event name
    ]);
    expect(events.at(-1)?.data).toBe("[DONE]");
  });

  it("carries the deltas and the assembled text", async () => {
    const events = await streamEvents("/v1/responses", request);
    const byType = (name: string) =>
      events
        .filter((e) => e.event === name)
        .map((e) => JSON.parse(e.data) as Record<string, unknown>);

    expect(byType("response.output_text.delta").map((e) => e.delta)).toEqual([
      "Hel",
      "lo",
    ]);
    expect(byType("response.output_text.done")[0]?.text).toBe("Hello");

    const completed = byType("response.completed")[0]?.response as {
      status: string;
      output: Array<{ content: Array<{ text: string }>; status: string }>;
      usage: { total_tokens: number };
    };
    expect(completed.status).toBe("completed");
    expect(completed.output[0]?.content[0]?.text).toBe("Hello");
    expect(completed.usage.total_tokens).toBeGreaterThan(0);
  });

  it("does not emit response.completed when the upstream errors", async () => {
    streamBody = ERROR_STREAM;
    const events = await streamEvents("/v1/responses", request);
    expect(events.some((e) => e.event === "response.created")).toBe(true);
    expect(events.some((e) => e.event === "response.completed")).toBe(false);
    expect(events.at(-1)?.data).toContain("upstream_stream_error");
  });
});

describe("POST /v1/messages (stream: true)", () => {
  const request = {
    model: "open-mistral-nemo",
    max_tokens: 64,
    messages: [{ role: "user", content: "ping" }],
    stream: true,
  };

  it("emits the Anthropic lifecycle in order", async () => {
    const events = await streamEvents("/v1/messages", request);

    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "ping",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // Anthropic streams have no [DONE] sentinel; message_stop ends it.
    expect(events.some((e) => e.data === "[DONE]")).toBe(false);
  });

  it("carries text_delta blocks and a stop reason", async () => {
    const events = await streamEvents("/v1/messages", request);
    const deltas = events
      .filter((e) => e.event === "content_block_delta")
      .map(
        (e) =>
          (JSON.parse(e.data) as { delta: { type: string; text: string } })
            .delta,
      );
    expect(deltas.map((d) => d.type)).toEqual(["text_delta", "text_delta"]);
    expect(deltas.map((d) => d.text).join("")).toBe("Hello");

    const messageDelta = JSON.parse(
      events.find((e) => e.event === "message_delta")?.data ?? "{}",
    ) as { delta: { stop_reason: string }; usage: { output_tokens: number } };
    expect(messageDelta.delta.stop_reason).toBe("end_turn");
    expect(messageDelta.usage.output_tokens).toBeGreaterThan(0);
  });

  it("does not emit message_stop when the upstream errors", async () => {
    streamBody = ERROR_STREAM;
    const events = await streamEvents("/v1/messages", request);
    expect(events.some((e) => e.event === "message_start")).toBe(true);
    expect(events.some((e) => e.event === "message_stop")).toBe(false);
    expect(events.at(-1)?.data).toContain("upstream_stream_error");
  });
});
