import { describe, expect, it } from "vitest";

import type { SpeechRequest } from "../src/types/requests";
import { ValidationError } from "../src/utils/errors";
import {
  parseSpeechRequest,
  resolveTtsContentType,
  ttsContentType,
} from "../src/utils/speech";

describe("parseSpeechRequest — default (OpenAI-shaped) path", () => {
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
      extra: {},
    });
  });

  it("applies defaults for the optional fields", () => {
    expect(parseSpeechRequest({ input: "hi" } as SpeechRequest)).toEqual({
      model: "tts-1",
      text: "hi",
      voice: "alloy",
      responseFormat: "mp3",
      speed: undefined,
      extra: {},
    });
  });

  it("behaves the same way for a model this fix doesn't special-case (google-tts)", () => {
    expect(
      parseSpeechRequest({ model: "google-tts", input: "hi" } as SpeechRequest),
    ).toEqual({
      model: "google-tts",
      text: "hi",
      voice: "alloy",
      responseFormat: "mp3",
      speed: undefined,
      extra: {},
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

  it("passes unrecognized fields through via extra", () => {
    expect(
      parseSpeechRequest({
        input: "hi",
        some_future_field: "x",
      } as SpeechRequest).extra,
    ).toEqual({ some_future_field: "x" });
  });
});

describe("parseSpeechRequest — elevenlabs-tts", () => {
  const base = { model: "elevenlabs-tts", input: "hi" } as SpeechRequest;

  it("defaults voice_id to DEFAULT_TTS_VOICE when nothing is given", () => {
    expect(parseSpeechRequest(base).voice).toBe("alloy");
  });

  it("uses the OpenAI-shaped voice when voice_id is absent", () => {
    expect(parseSpeechRequest({ ...base, voice: "nova" }).voice).toBe("nova");
  });

  it("prefers the native voice_id over voice when both are given", () => {
    expect(
      parseSpeechRequest({ ...base, voice: "nova", voice_id: "Rachel" }).voice,
    ).toBe("Rachel");
  });

  it("leaves responseFormat unset when neither output_format nor response_format is given", () => {
    expect(parseSpeechRequest(base).responseFormat).toBeUndefined();
  });

  it("maps response_format onto output_format when only the OpenAI name is given", () => {
    expect(
      parseSpeechRequest({ ...base, response_format: "mp3_44100_128" })
        .responseFormat,
    ).toBe("mp3_44100_128");
  });

  it("prefers the native output_format over response_format when both are given", () => {
    expect(
      parseSpeechRequest({
        ...base,
        response_format: "wav",
        output_format: "mp3_44100_192",
      }).responseFormat,
    ).toBe("mp3_44100_192");
  });

  it("rejects speed — ElevenLabs has no equivalent field", () => {
    expect(() => parseSpeechRequest({ ...base, speed: 1.5 })).toThrow(/speed/);
  });

  it("passes ElevenLabs-native extras through unvalidated", () => {
    expect(
      parseSpeechRequest({
        ...base,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5 },
        optimize_streaming_latency: 2,
        language_code: "en",
      } as SpeechRequest).extra,
    ).toEqual({
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5 },
      optimize_streaming_latency: 2,
      language_code: "en",
    });
  });
});

describe("parseSpeechRequest — qwen3-tts-flash", () => {
  const base = { model: "qwen3-tts-flash", input: "hi" } as SpeechRequest;

  it("uses the voice field as-is (same field name upstream)", () => {
    expect(parseSpeechRequest({ ...base, voice: "Dylan" }).voice).toBe("Dylan");
  });

  it("defaults voice to DEFAULT_TTS_VOICE when omitted", () => {
    expect(parseSpeechRequest(base).voice).toBe("alloy");
  });

  it("never resolves a responseFormat — Qwen3 always returns wav", () => {
    expect(parseSpeechRequest(base).responseFormat).toBeUndefined();
  });

  it("rejects response_format — Qwen3 has no such field", () => {
    expect(() =>
      parseSpeechRequest({ ...base, response_format: "wav" }),
    ).toThrow(/response_format/);
  });

  it("rejects output_format — Qwen3 has no such field either", () => {
    expect(() =>
      parseSpeechRequest({ ...base, output_format: "wav" } as SpeechRequest),
    ).toThrow(/response_format/);
  });

  it("rejects speed — Qwen3 has no equivalent field", () => {
    expect(() => parseSpeechRequest({ ...base, speed: 1.5 })).toThrow(/speed/);
  });

  it("passes Qwen3-native extras through unvalidated", () => {
    expect(
      parseSpeechRequest({ ...base, language_type: "Chinese" } as SpeechRequest)
        .extra,
    ).toEqual({ language_type: "Chinese" });
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

describe("resolveTtsContentType", () => {
  it("always answers audio/mpeg for elevenlabs-tts regardless of the requested format", () => {
    expect(resolveTtsContentType("elevenlabs-tts", undefined)).toBe(
      "audio/mpeg",
    );
    expect(resolveTtsContentType("elevenlabs-tts", "mp3_44100_192")).toBe(
      "audio/mpeg",
    );
  });

  it("always answers audio/wav for qwen3-tts-flash", () => {
    expect(resolveTtsContentType("qwen3-tts-flash", undefined)).toBe(
      "audio/wav",
    );
  });

  it("falls back to the responseFormat mapping for other models", () => {
    expect(resolveTtsContentType("tts-1", "flac")).toBe("audio/flac");
    expect(resolveTtsContentType("tts-1-hd", undefined)).toBe("audio/mpeg");
  });
});
