import { describe, expect, it } from "vitest";
import type { SpeechRequest } from "../src/types/requests";
import { ValidationError } from "../src/utils/errors";
import { parseSpeechRequest, ttsContentType } from "../src/utils/speech";

describe("parseSpeechRequest", () => {
  it("maps an OpenAI-shaped request onto the upstream fields", () => {
    // OpenAI names the text `input`; the upstream names it `text`.
    expect(
      parseSpeechRequest({
        model: "tts-1",
        input: "Hello, this is a relay test.",
        voice: "nova",
        response_format: "wav",
        speed: 1.5,
      }),
    ).toEqual({
      model: "tts-1",
      text: "Hello, this is a relay test.",
      voice: "nova",
      responseFormat: "wav",
      speed: 1.5,
    });
  });

  it("applies defaults for the optional fields", () => {
    expect(parseSpeechRequest({ input: "hi" } as SpeechRequest)).toEqual({
      model: "tts-1",
      text: "hi",
      voice: "alloy",
      responseFormat: "mp3",
      speed: undefined,
    });
  });

  it("rejects a missing or empty input", () => {
    expect(() => parseSpeechRequest({} as SpeechRequest)).toThrow(
      ValidationError,
    );
    expect(() => parseSpeechRequest({ input: "   " } as SpeechRequest)).toThrow(
      /non-empty/,
    );
  });

  it("rejects input beyond the 4096 character limit", () => {
    expect(() =>
      parseSpeechRequest({ input: "x".repeat(4097) } as SpeechRequest),
    ).toThrow(/4096/);
    expect(() =>
      parseSpeechRequest({ input: "x".repeat(4096) } as SpeechRequest),
    ).not.toThrow();
  });

  it("rejects an unsupported response_format", () => {
    expect(() =>
      parseSpeechRequest({ input: "hi", response_format: "ogg" }),
    ).toThrow(/Unsupported response_format/);
  });

  it("accepts every supported response_format", () => {
    for (const format of ["mp3", "opus", "aac", "flac", "wav", "pcm"]) {
      expect(
        parseSpeechRequest({ input: "hi", response_format: format })
          .responseFormat,
      ).toBe(format);
    }
  });

  it("enforces the speed range", () => {
    expect(() => parseSpeechRequest({ input: "hi", speed: 0.1 })).toThrow(
      /speed/,
    );
    expect(() => parseSpeechRequest({ input: "hi", speed: 4.5 })).toThrow(
      /speed/,
    );
    expect(parseSpeechRequest({ input: "hi", speed: 0.25 }).speed).toBe(0.25);
    expect(parseSpeechRequest({ input: "hi", speed: 4 }).speed).toBe(4);
  });

  it("rejects a non-numeric speed", () => {
    expect(() =>
      parseSpeechRequest({ input: "hi", speed: "fast" as unknown as number }),
    ).toThrow(ValidationError);
  });
});

describe("ttsContentType", () => {
  it("maps formats to audio content types", () => {
    expect(ttsContentType("mp3")).toBe("audio/mpeg");
    expect(ttsContentType("wav")).toBe("audio/wav");
    expect(ttsContentType("flac")).toBe("audio/flac");
  });

  it("falls back for an unknown format", () => {
    expect(ttsContentType("unknown")).toBe("application/octet-stream");
  });
});
