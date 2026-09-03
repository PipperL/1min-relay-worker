/**
 * End-to-end behaviour of executeStreamingPipeline.
 *
 * parseSSEChunks is covered separately; what matters here is what the pipeline
 * *does* with an upstream error — the bug was that it ran to completion and
 * reported a successful, empty answer.
 */

import { describe, expect, it } from "vitest";
import { executeStreamingPipeline } from "../src/utils/streaming";

function upstreamResponse(body: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliver in a few pieces so the buffering logic is exercised
        for (const piece of body.match(/[\s\S]{1,17}/g) ?? []) {
          controller.enqueue(encoder.encode(piece));
        }
        controller.close();
      },
    }),
  );
}

interface Run {
  chunks: string[];
  ended: boolean;
  endedWith?: string;
  output: string;
}

async function run(body: string): Promise<Run> {
  const result: Run = { chunks: [], ended: false, output: "" };

  const response = executeStreamingPipeline(upstreamResponse(body), {
    onChunk: async (_writer, chunk) => {
      result.chunks.push(chunk);
    },
    onEnd: async (writer, accumulated) => {
      result.ended = true;
      result.endedWith = accumulated;
      await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
    },
  });

  result.output = await response.text();
  return result;
}

const HEALTHY = [
  'event: content\ndata: {"content":"Hel"}',
  'event: content\ndata: {"content":"lo"}',
  'event: result\ndata: {"aiRecord":{"status":"SUCCESS"}}',
  'event: done\ndata: {"message":"Stream completed"}',
].join("\n\n");

const FAILS_IMMEDIATELY =
  'event: error\ndata: {"error":"Model bogus-model is not supported"}\n\n';

const FAILS_MIDWAY = [
  'event: content\ndata: {"content":"Partial"}',
  'event: error\ndata: {"error":"upstream blew up"}',
].join("\n\n");

describe("executeStreamingPipeline", () => {
  it("streams a healthy response and finishes normally", async () => {
    const result = await run(HEALTHY);
    expect(result.chunks).toEqual(["Hel", "lo"]);
    expect(result.ended).toBe(true);
    expect(result.endedWith).toBe("Hello");
    expect(result.output).toContain("[DONE]");
  });

  it("does not report completion when the upstream errors", async () => {
    // This is the whole point: onEnd would have told the client the empty
    // answer was the finished answer.
    const result = await run(FAILS_IMMEDIATELY);
    expect(result.ended).toBe(false);
    expect(result.chunks).toEqual([]);
  });

  it("emits the upstream message as an SSE error payload", async () => {
    const result = await run(FAILS_IMMEDIATELY);
    expect(result.output).toContain("Model bogus-model is not supported");
    const payload = JSON.parse(
      result.output.replace(/^data: /, "").trim(),
    ) as { error: { message: string; code: string | null } };
    expect(payload.error.code).toBe("upstream_stream_error");
  });

  it("aborts mid-stream rather than passing off a truncated answer", async () => {
    const result = await run(FAILS_MIDWAY);
    expect(result.chunks).toEqual(["Partial"]);
    expect(result.ended).toBe(false);
    expect(result.output).toContain("upstream blew up");
  });

  it("still handles a non-SSE upstream body as raw text", async () => {
    const result = await run("plain text answer\n\n");
    expect(result.ended).toBe(true);
    expect(result.endedWith).toContain("plain text answer");
  });

  it("forwards a final chunk equal to the accumulated text mid-stream", async () => {
    // The dedup guard must not fire outside a terminal block: "ok" then "ok"
    // is a legitimate pair of deltas.
    const body = [
      'event: content\ndata: {"content":"ok"}',
      'event: content\ndata: {"content":"ok"}',
      'event: done\ndata: {"message":"Stream completed"}',
    ].join("\n\n");
    const result = await run(body);
    expect(result.chunks).toEqual(["ok", "ok"]);
    expect(result.endedWith).toBe("okok");
  });

  it("drops a repeated full answer that shares the terminal block", async () => {
    // Events are separated by a blank line, so this only happens when the
    // upstream packs the repeat and its terminator into one block.
    const body =
      'event: content\ndata: {"content":"Hello"}\n\n' +
      'event: content\ndata: {"content":"Hello"}\nevent: done\ndata: {"message":"Stream completed"}\n\n';
    const result = await run(body);
    expect(result.chunks).toEqual(["Hello"]);
    expect(result.endedWith).toBe("Hello");
  });

  it("forwards a repeat that arrives as its own event", async () => {
    // Documents the deliberate limit of the guard. If an upstream ever sends
    // the full answer again as a separate content event, it is duplicated
    // rather than dropped — the alternative (comparing every delta) silently
    // truncated legitimate output, and a visible duplicate beats a silent
    // truncation. The current upstream does neither: it puts the full text in
    // `event: result`, which is ignored.
    const body = [
      'event: content\ndata: {"content":"Hello"}',
      'event: content\ndata: {"content":"Hello"}',
      'event: done\ndata: {"message":"Stream completed"}',
    ].join("\n\n");
    const result = await run(body);
    expect(result.chunks).toEqual(["Hello", "Hello"]);
  });
});
