/**
 * POST /v1/messages — Anthropic Messages API translation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import type { OneMinRequestBody } from "../src/types";
import {
  CHAT_MODEL,
  contentBlock,
  type FetchMock,
  installFetchMock,
  oneMinChatResponse,
  requestTo,
  sseResponse,
  testCtx,
  testEnv,
  UPSTREAM,
  VISION_MODEL,
} from "./helpers";

let upstream: FetchMock;

beforeEach(() => {
  upstream = installFetchMock();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function post(body: unknown) {
  return app.request(
    "http://localhost/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    testEnv(),
    testCtx,
  );
}

const prompt = () =>
  (requestTo(upstream, UPSTREAM.chat).body as OneMinRequestBody).promptObject
    .prompt as string;

describe("non-streaming", () => {
  it("returns an Anthropic message", async () => {
    upstream.reply(UPSTREAM.chat, () =>
      oneMinChatResponse("Bonjour", {
        inputToken: 7,
        outputToken: 2,
        totalToken: 9,
      }),
    );

    const res = await post({
      model: CHAT_MODEL,
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      model: CHAT_MODEL,
      content: [{ type: "text", text: "Bonjour" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 2 },
    });
    expect(body.id).toMatch(/^msg_[0-9a-f]{20}$/);
  });

  it("folds a string system prompt into the conversation", async () => {
    upstream.reply(UPSTREAM.chat, () => oneMinChatResponse("ok"));
    await post({
      model: CHAT_MODEL,
      max_tokens: 10,
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(prompt()).toBe("System: be brief\n\nHuman: hi\n\n");
  });

  it("folds a block-array system prompt", async () => {
    upstream.reply(UPSTREAM.chat, () => oneMinChatResponse("ok"));
    await post({
      model: CHAT_MODEL,
      max_tokens: 10,
      system: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(prompt()).toBe("System: line one\nline two\n\nHuman: hi\n\n");
  });

  it("flattens text and tool_result blocks", async () => {
    upstream.reply(UPSTREAM.chat, () => oneMinChatResponse("ok"));
    await post({
      model: CHAT_MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "question" },
            { type: "tool_result", tool_use_id: "t1", content: "plain result" },
            {
              type: "tool_result",
              tool_use_id: "t2",
              content: [{ type: "text", text: "block result" }],
            },
          ],
        },
      ],
    });
    expect(prompt()).toBe("Human: question\nplain result\nblock result\n\n");
  });

  it("estimates usage when the upstream reports zeroes", async () => {
    upstream.reply(UPSTREAM.chat, () =>
      oneMinChatResponse("answer", { inputToken: 0, outputToken: 0 }),
    );
    const res = await post({
      model: CHAT_MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "a longer question here" }],
    });
    const usage = ((await res.json()) as { usage: Record<string, number> })
      .usage;
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
  });
});

describe("validation", () => {
  it("requires messages, in Anthropic error shape", async () => {
    const res = await post({ model: CHAT_MODEL, max_tokens: 10 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "messages: Field required",
      },
    });
  });

  it("requires max_tokens", async () => {
    const res = await post({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("max_tokens");
  });

  it("rejects image content blocks for a non-vision model", async () => {
    const res = await post({
      model: CHAT_MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "x" },
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(
      "does not support image inputs",
    );
  });

  it("rejects an image block with neither url nor data", async () => {
    const res = await post({
      model: VISION_MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64" } }],
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("source.url");
  });

  it("reports an unknown model as an Anthropic not_found_error", async () => {
    const res = await post({
      model: "nope",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      type: "error",
      error: { type: "not_found_error" },
    });
  });
});

describe("images", () => {
  it("uploads a base64 image block and attaches its path", async () => {
    upstream.reply(UPSTREAM.asset, () =>
      Response.json({ fileContent: { path: "images/abc.png" } }),
    );
    upstream.reply(UPSTREAM.chat, () => oneMinChatResponse("a cat"));

    const res = await post({
      model: VISION_MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aGVsbG8=",
              },
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(requestTo(upstream, UPSTREAM.chat).body).toMatchObject({
      promptObject: { attachments: { images: ["images/abc.png"] } },
    });
    expect(upstream.callsTo(UPSTREAM.asset)).toHaveLength(1);
  });

  it("fetches and uploads a url-sourced image block through the same asset pipeline", async () => {
    upstream.on((url) =>
      url === "https://example.com/dog.png"
        ? new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
          })
        : undefined,
    );
    upstream.reply(UPSTREAM.asset, () =>
      Response.json({ fileContent: { path: "images/dog.png" } }),
    );
    upstream.reply(UPSTREAM.chat, () => oneMinChatResponse("a dog"));

    const res = await post({
      model: VISION_MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: "https://example.com/dog.png" },
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(requestTo(upstream, UPSTREAM.chat).body).toMatchObject({
      promptObject: { attachments: { images: ["images/dog.png"] } },
    });
    expect(upstream.callsTo(UPSTREAM.asset)).toHaveLength(1);
  });
});

describe("streaming", () => {
  it("emits the Anthropic event sequence", async () => {
    upstream.reply(UPSTREAM.chat, () =>
      sseResponse([contentBlock("Hel"), contentBlock("lo")]),
    );

    const res = await post({
      model: CHAT_MODEL,
      max_tokens: 10,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    const text = await res.text();
    expect([...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1])).toEqual([
      "message_start",
      "content_block_start",
      "ping",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(text).toContain('"text":"Hel"');
    expect(text).toContain('"stop_reason":"end_turn"');
  });

  it("emits an Anthropic error event when the upstream stream fails", async () => {
    upstream.reply(UPSTREAM.chat, () =>
      sseResponse(['event: error\ndata: {"error":"model exploded"}']),
    );

    const res = await post({
      model: CHAT_MODEL,
      max_tokens: 10,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain('"message":"model exploded"');
    expect(text).not.toContain("message_stop");
  });
});
