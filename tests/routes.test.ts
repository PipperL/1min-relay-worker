/**
 * Route-level tests: exercise the real Hono app with the upstream stubbed out.
 *
 * The unit tests cover the pure helpers; these check the wiring — that routes
 * are registered, middleware runs, errors come back in the right shape, and
 * the handlers assemble what the helpers produce.
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

function model(id: string, extra: Record<string, unknown> = {}) {
  return {
    modelId: id,
    name: id,
    provider: "test-provider",
    status: "ACTIVE",
    features: ["UNIFY_CHAT_WITH_AI"],
    modality: { INPUT: ["text"], OUTPUT: ["text"] },
    creditMetadata: {},
    ...extra,
  };
}

const MODELS: Record<string, unknown[]> = {
  UNIFY_CHAT_WITH_AI: [
    model("open-mistral-nemo"),
    model("retired-chat-model", { status: "DISABLED" }),
  ],
  IMAGE_GENERATOR: [
    model("gpt-image-1-mini", { features: ["IMAGE_GENERATOR"] }),
    model("black-forest-labs/flux-dev", { features: ["IMAGE_GENERATOR"] }),
    model("black-forest-labs/flux-schnell", {
      features: ["IMAGE_GENERATOR"],
      status: "DISABLED",
    }),
  ],
  SPEECH_TO_TEXT: [model("whisper-1", { features: ["SPEECH_TO_TEXT"] })],
  TEXT_TO_SPEECH: [model("tts-1", { features: ["TEXT_TO_SPEECH"] })],
};

const CHAT_RECORD = {
  aiRecord: {
    metadata: { inputToken: 98, outputToken: 3, totalToken: 101 },
    aiRecordDetail: { resultObject: ["Pong"] },
  },
};

let upstreamCalls: Array<{ url: string; body?: unknown }>;

function stubUpstream() {
  upstreamCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      let body: unknown;
      if (init?.body && typeof init.body === "string") {
        body = JSON.parse(init.body);
      }
      upstreamCalls.push({ url, body });

      if (url.startsWith("https://api.1min.ai/models")) {
        const feature = new URL(url).searchParams.get("feature") ?? "";
        return new Response(
          JSON.stringify({ models: MODELS[feature] ?? [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.startsWith("https://api.1min.ai/api/assets")) {
        return new Response(
          JSON.stringify({
            asset: { key: "documents/uploaded.txt" },
            fileContent: {
              uuid: "file-uuid-1234",
              path: "documents/uploaded.txt",
            },
          }),
          { status: 200 },
        );
      }

      if (url.startsWith("https://api.1min.ai/api/chat-with-ai")) {
        return new Response(JSON.stringify(CHAT_RECORD), { status: 200 });
      }

      if (url.startsWith("https://api.1min.ai/api/features")) {
        const type = (body as { type?: string })?.type;
        if (type === "TEXT_TO_SPEECH") {
          return new Response(
            JSON.stringify({
              aiRecord: {
                temporaryUrl: "https://s3.example/audio.mp3?sig=1",
                aiRecordDetail: { resultObject: ["audios/generated.mp3"] },
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            aiRecord: {
              temporaryUrl: "https://s3.example/first.png?sig=1",
              aiRecordDetail: {
                resultObject: ["images/first.png", "images/second.png"],
              },
            },
          }),
          { status: 200 },
        );
      }

      if (url.startsWith("https://s3.example/")) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }

      throw new Error(`unexpected upstream call: ${url}`);
    }),
  );
}

function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", "Bearer test-key");
  }
  return app.fetch(
    new Request(`https://relay.test${path}`, { ...init, headers }),
    env,
    ctx,
  );
}

beforeEach(stubUpstream);
afterEach(() => vi.unstubAllGlobals());

describe("auth", () => {
  it("rejects a request with no credentials", async () => {
    const res = await app.fetch(
      new Request("https://relay.test/v1/models"),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("authentication_error");
  });
});

describe("GET /v1/models", () => {
  it("omits models the upstream reports as DISABLED", async () => {
    const res = await call("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("open-mistral-nemo");
    expect(ids).toContain("gpt-image-1-mini");
    expect(ids).not.toContain("retired-chat-model");
    expect(ids).not.toContain("black-forest-labs/flux-schnell");
  });
});

describe("GET /v1/models/{model}", () => {
  it("returns a single model", async () => {
    const res = await call("/v1/models/open-mistral-nemo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; object: string };
    expect(body).toMatchObject({ id: "open-mistral-nemo", object: "model" });
  });

  it("handles an id containing a slash", async () => {
    const res = await call("/v1/models/black-forest-labs/flux-dev");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("black-forest-labs/flux-dev");
  });

  it("handles a percent-encoded id", async () => {
    const res = await call("/v1/models/black-forest-labs%2Fflux-dev");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("black-forest-labs/flux-dev");
  });

  it("404s an unknown model in OpenAI error shape", async () => {
    const res = await call("/v1/models/no-such-model");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_found");
  });
});

describe("POST /v1/chat/completions", () => {
  it("reports the upstream token counts", async () => {
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "open-mistral-nemo",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usage: { prompt_tokens: number; total_tokens: number };
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.usage).toEqual({
      prompt_tokens: 98,
      completion_tokens: 3,
      total_tokens: 101,
    });
    expect(body.choices[0]?.message.content).toBe("Pong");
  });

  it("rejects a request carrying tools", async () => {
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "open-mistral-nemo",
        messages: [{ role: "user", content: "ping" }],
        tools: [{ type: "function", function: { name: "f" } }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unsupported_parameter");
  });
});

describe("POST /v1/responses", () => {
  it("accepts an input item that omits `type`", async () => {
    const res = await call("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "open-mistral-nemo",
        input: [
          { role: "user", content: [{ type: "input_text", text: "ping" }] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const chatCall = upstreamCalls.find((c) =>
      c.url.includes("/api/chat-with-ai"),
    );
    const prompt = (
      chatCall?.body as { promptObject: { prompt: string } }
    ).promptObject.prompt;
    expect(prompt).toContain("ping");
  });

  it("uploads an input_file and references it by asset uuid", async () => {
    // The upstream expects attachments.files to hold fileContent.uuid. Given
    // a path or key it accepts the request, attaches nothing, and lets the
    // model invent an answer — so this assertion is the guard against a
    // failure that is invisible at runtime.
    const res = await call("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "open-mistral-nemo",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "summarise this" },
              {
                type: "input_file",
                filename: "memo.txt",
                file_data: btoa("secret codename"),
              },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);

    expect(upstreamCalls.some((c) => c.url.includes("/api/assets"))).toBe(true);

    const chatCall = upstreamCalls.find((c) =>
      c.url.includes("/api/chat-with-ai"),
    );
    const promptObject = (
      chatCall?.body as {
        promptObject: { attachments?: { files?: string[] } };
      }
    ).promptObject;
    expect(promptObject.attachments?.files).toEqual(["file-uuid-1234"]);
  });

  it("passes an existing file_id through without re-uploading", async () => {
    await call("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "open-mistral-nemo",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "summarise this" },
              { type: "input_file", file_id: "already-there" },
            ],
          },
        ],
      }),
    });
    expect(upstreamCalls.some((c) => c.url.includes("/api/assets"))).toBe(false);
    const chatCall = upstreamCalls.find((c) =>
      c.url.includes("/api/chat-with-ai"),
    );
    expect(
      (chatCall?.body as { promptObject: { attachments?: { files?: string[] } } })
        .promptObject.attachments?.files,
    ).toEqual(["already-there"]);
  });

  it("rejects an input that yields no content", async () => {
    const res = await call("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "open-mistral-nemo", input: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("empty_input");
  });
});

describe("POST /v1/messages", () => {
  const anthropicBody = (extra: Record<string, unknown> = {}) => ({
    model: "open-mistral-nemo",
    max_tokens: 64,
    messages: [{ role: "user", content: "ping" }],
    ...extra,
  });

  function post(body: unknown, init: RequestInit = {}) {
    return call("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    });
  }

  it("answers in Anthropic message shape", async () => {
    const res = await post(anthropicBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      type: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      stop_reason: "end_turn",
    });
    expect(body.content).toEqual([{ type: "text", text: "Pong" }]);
    // Real upstream counts, not the local estimate.
    expect(body.usage).toEqual({ input_tokens: 98, output_tokens: 3 });
  });

  it("folds the top-level system prompt into the upstream prompt", async () => {
    // Anthropic carries `system` outside `messages`; dropping it here would be
    // silent — the model just stops following instructions.
    await post(anthropicBody({ system: "You are a pirate." }));
    const chatCall = upstreamCalls.find((c) =>
      c.url.includes("/api/chat-with-ai"),
    );
    const prompt = (chatCall?.body as { promptObject: { prompt: string } })
      .promptObject.prompt;
    expect(prompt).toContain("You are a pirate.");
    expect(prompt).toContain("ping");
  });

  it("flattens text and tool_result content blocks", async () => {
    await post(
      anthropicBody({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "here is the tool output" },
              { type: "tool_result", content: "42" },
            ],
          },
        ],
      }),
    );
    const chatCall = upstreamCalls.find((c) =>
      c.url.includes("/api/chat-with-ai"),
    );
    const prompt = (chatCall?.body as { promptObject: { prompt: string } })
      .promptObject.prompt;
    expect(prompt).toContain("here is the tool output");
    expect(prompt).toContain("42");
  });

  // --- the Anthropic error-format branch -------------------------------
  // Everything else in this app answers in OpenAI's error shape. /v1/messages
  // must not, or an Anthropic SDK client sees an unparseable body instead of
  // the error. Each case below goes through a different throw site.

  async function expectAnthropicError(res: Response, type: string) {
    const body = (await res.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe(type);
    expect(typeof body.error.message).toBe("string");
    // Not the OpenAI shape.
    expect(body).not.toHaveProperty("error.code");
    expect(body).not.toHaveProperty("error.param");
    return body;
  }

  it("reports a missing max_tokens in Anthropic error shape", async () => {
    const res = await post({
      model: "open-mistral-nemo",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(res.status).toBe(400);
    await expectAnthropicError(res, "invalid_request_error");
  });

  it("reports missing messages in Anthropic error shape", async () => {
    const res = await post({ model: "open-mistral-nemo", max_tokens: 64 });
    expect(res.status).toBe(400);
    await expectAnthropicError(res, "invalid_request_error");
  });

  it("reports an auth failure in Anthropic error shape", async () => {
    const res = await app.fetch(
      new Request("https://relay.test/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(anthropicBody()),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    await expectAnthropicError(res, "authentication_error");
  });

  it("reports an unknown model in Anthropic error shape", async () => {
    const res = await post(anthropicBody({ model: "no-such-model" }));
    expect(res.status).toBe(404);
    await expectAnthropicError(res, "not_found_error");
  });

  it("reports invalid JSON in Anthropic error shape", async () => {
    const res = await call("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    await expectAnthropicError(res, "invalid_request_error");
  });

  it("rejects tools in Anthropic error shape", async () => {
    const res = await post(
      anthropicBody({ tools: [{ name: "get_weather", input_schema: {} }] }),
    );
    expect(res.status).toBe(400);
    const body = await expectAnthropicError(res, "invalid_request_error");
    expect(body.error.message).toMatch(/tool/i);
  });

  it("rejects image blocks with a pointer to the vision endpoint", async () => {
    const res = await post(
      anthropicBody({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "x" },
              },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = await expectAnthropicError(res, "invalid_request_error");
    expect(body.error.message).toContain("/v1/chat/completions");
  });
});

describe("POST /v1/images/generations", () => {
  it("returns fetchable URLs for every result", async () => {
    const res = await call("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "an apple", n: 2 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ url: string }> };
    expect(body.data.map((d) => d.url)).toEqual([
      "https://asset.1min.ai/images/first.png",
      "https://asset.1min.ai/images/second.png",
    ]);
  });

  it("sends `quality` for a model that requires it", async () => {
    await call("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1-mini", prompt: "an apple" }),
    });
    const featureCall = upstreamCalls.find((c) => c.url.includes("/features"));
    expect(
      (featureCall?.body as { promptObject: { quality?: string } }).promptObject
        .quality,
    ).toBe("low");
  });

  it("refuses a DISABLED model", async () => {
    const res = await call("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "black-forest-labs/flux-schnell",
        prompt: "an apple",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_supported");
  });
});

describe("POST /v1/audio/speech", () => {
  it("streams the generated audio back with an audio content type", async () => {
    const res = await call("/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "tts-1",
        input: "hello there",
        voice: "alloy",
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("maps the OpenAI field names onto the upstream ones", async () => {
    await call("/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "tts-1",
        input: "hello there",
        voice: "nova",
        response_format: "wav",
      }),
    });
    const ttsCall = upstreamCalls.find(
      (c) => (c.body as { type?: string })?.type === "TEXT_TO_SPEECH",
    );
    expect(ttsCall?.body).toMatchObject({
      type: "TEXT_TO_SPEECH",
      model: "tts-1",
      promptObject: {
        text: "hello there",
        voice: "nova",
        response_format: "wav",
      },
    });
  });

  it("rejects input that is too long", async () => {
    const res = await call("/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "x".repeat(5000) }),
    });
    expect(res.status).toBe(400);
  });
});

describe("404", () => {
  it("answers an unknown path", async () => {
    const res = await call("/v1/nonexistent");
    expect(res.status).toBe(404);
  });
});
