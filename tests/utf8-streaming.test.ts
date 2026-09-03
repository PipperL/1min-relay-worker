/**
 * Multi-byte text across chunk boundaries.
 *
 * The upstream stream arrives as bytes, and a network read can land in the
 * middle of a UTF-8 sequence. Decoding each read independently turns the split
 * character into U+FFFD, which is invisible in ASCII testing and shows up as
 * "�" the moment anyone streams Chinese, Japanese or an emoji. These tests
 * split deliberately mid-character so a regression fails here rather than in
 * production.
 */

import { describe, expect, it } from "vitest";
import { executeStreamingPipeline } from "../src/utils/streaming";
import { SimpleUTF8Decoder } from "../src/utils/utf8-decoder";

const encoder = new TextEncoder();

/** Feed a body to the pipeline one byte at a time — worst-case fragmentation. */
function byteAtATime(body: string): Response {
  const bytes = encoder.encode(body);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(new Uint8Array([byte]));
        }
        controller.close();
      },
    }),
  );
}

async function collect(response: Response): Promise<{
  chunks: string[];
  accumulated: string;
}> {
  const chunks: string[] = [];
  let accumulated = "";
  const out = executeStreamingPipeline(response, {
    onChunk: async (_writer, chunk) => {
      chunks.push(chunk);
    },
    onEnd: async (writer, content) => {
      accumulated = content;
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    },
  });
  await out.text();
  return { chunks, accumulated };
}

describe("SimpleUTF8Decoder", () => {
  it("joins a 3-byte character split across two reads", () => {
    const decoder = new SimpleUTF8Decoder();
    const bytes = encoder.encode("你好"); // 6 bytes
    const first = decoder.decode(bytes.slice(0, 4)); // splits 好 after 1 byte
    const second = decoder.decode(bytes.slice(4));
    expect(first + second).toBe("你好");
    expect(first + second).not.toContain("�");
  });

  it("joins a 4-byte emoji split across two reads", () => {
    const decoder = new SimpleUTF8Decoder();
    const bytes = encoder.encode("🎉"); // 4 bytes
    const parts = [
      decoder.decode(bytes.slice(0, 1)),
      decoder.decode(bytes.slice(1, 3)),
      decoder.decode(bytes.slice(3)),
    ];
    expect(parts.join("")).toBe("🎉");
  });

  it("survives one byte at a time", () => {
    const decoder = new SimpleUTF8Decoder();
    const text = "中文 mixed with 日本語 and 🎉";
    let out = "";
    for (const byte of encoder.encode(text)) {
      out += decoder.decode(new Uint8Array([byte]));
    }
    expect(out).toBe(text);
  });

  it("forgets a dangling partial sequence after reset", () => {
    const decoder = new SimpleUTF8Decoder();
    const bytes = encoder.encode("你");
    decoder.decode(bytes.slice(0, 2)); // leaves the sequence open
    decoder.reset();
    // A fresh stream must not inherit the previous one's trailing bytes.
    expect(decoder.decode(encoder.encode("ok"))).toBe("ok");
  });
});

describe("executeStreamingPipeline with multi-byte content", () => {
  it("delivers Chinese deltas intact when every read splits a character", async () => {
    const body = [
      'event: content\ndata: {"content":"你好"}',
      'event: content\ndata: {"content":"世界"}',
      'event: done\ndata: {"message":"Stream completed"}',
    ].join("\n\n");

    const { chunks, accumulated } = await collect(byteAtATime(body));
    expect(chunks).toEqual(["你好", "世界"]);
    expect(accumulated).toBe("你好世界");
    expect(accumulated).not.toContain("�");
  });

  it("keeps an emoji whole across a read boundary", async () => {
    const body =
      'event: content\ndata: {"content":"done 🎉"}\n\nevent: done\ndata: {}\n\n';
    const { accumulated } = await collect(byteAtATime(body));
    expect(accumulated).toBe("done 🎉");
  });

  it("handles multi-byte text in raw (non-SSE) mode too", async () => {
    // No `data:`/`event:` lines, so the pipeline falls back to raw text.
    const { accumulated } = await collect(byteAtATime("純文字回應\n\n"));
    expect(accumulated).toContain("純文字回應");
    expect(accumulated).not.toContain("�");
  });

  it("reassembles an SSE event whose JSON is split mid-character", async () => {
    // Belt and braces: the split lands inside the JSON payload as well as
    // inside the character, so both the byte buffer and the line buffer have
    // to hold their partial state across reads.
    const body = 'event: content\ndata: {"content":"測試分割"}\n\n';
    const bytes = encoder.encode(body);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // `event: content\n` is 15 bytes and `data: {"content":"` is 18, so
          // the text starts at 33 and cutting at 34 splits 測 after one byte.
          const cut = 34;
          expect(bytes.slice(0, cut).at(-1)).toBeGreaterThan(0x7f);
          controller.enqueue(bytes.slice(0, cut));
          controller.enqueue(bytes.slice(cut));
          controller.close();
        },
      }),
    );
    const { chunks } = await collect(response);
    expect(chunks).toEqual(["測試分割"]);
  });
});
