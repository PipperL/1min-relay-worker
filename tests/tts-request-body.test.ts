/**
 * OneMinApiService.buildTextToSpeechRequestBody — the per-model promptObject
 * assembly that sits between parseSpeechRequest's validation and the actual
 * upstream call. Exercised directly (rather than only through the route)
 * because its most important guarantee — `extra` can never shadow an
 * explicit field — has no other test covering it.
 */

import { describe, expect, it } from "vitest";

import { OneMinApiService } from "../src/services/onemin-api";
import type { Env } from "../src/types";
import type { ParsedSpeechRequest } from "../src/utils/speech";

const service = new OneMinApiService({} as Env);

function parsed(
  overrides: Partial<ParsedSpeechRequest> = {},
): ParsedSpeechRequest {
  return {
    model: "tts-1",
    text: "hello",
    voice: "alloy",
    responseFormat: "mp3",
    extra: {},
    ...overrides,
  };
}

describe("buildTextToSpeechRequestBody — default (OpenAI-shaped) path", () => {
  it("builds the OpenAI-shaped promptObject", () => {
    expect(
      service.buildTextToSpeechRequestBody(
        parsed({ model: "tts-1", speed: 1.5 }),
      ),
    ).toEqual({
      type: "TEXT_TO_SPEECH",
      model: "tts-1",
      promptObject: {
        text: "hello",
        voice: "alloy",
        response_format: "mp3",
        speed: 1.5,
      },
    });
  });

  it("omits speed entirely when not given", () => {
    const { promptObject } = service.buildTextToSpeechRequestBody(parsed());
    expect(promptObject).not.toHaveProperty("speed");
  });

  it("does not let a passthrough extra field override text/voice/response_format", () => {
    const { promptObject } = service.buildTextToSpeechRequestBody(
      parsed({
        extra: {
          text: "smuggled",
          voice: "smuggled",
          response_format: "smuggled",
        },
      }),
    );
    expect(promptObject).toMatchObject({
      text: "hello",
      voice: "alloy",
      response_format: "mp3",
    });
  });
});

describe("buildTextToSpeechRequestBody — elevenlabs-tts", () => {
  it("sends voice_id (not voice) and output_format (not response_format)", () => {
    expect(
      service.buildTextToSpeechRequestBody(
        parsed({
          model: "elevenlabs-tts",
          voice: "Rachel",
          responseFormat: "mp3_44100_192",
        }),
      ),
    ).toEqual({
      type: "TEXT_TO_SPEECH",
      model: "elevenlabs-tts",
      promptObject: {
        text: "hello",
        voice_id: "Rachel",
        output_format: "mp3_44100_192",
      },
    });
  });

  it("omits output_format when parseSpeechRequest resolved none", () => {
    const { promptObject } = service.buildTextToSpeechRequestBody(
      parsed({ model: "elevenlabs-tts", responseFormat: undefined }),
    );
    expect(promptObject).not.toHaveProperty("output_format");
  });

  it("spreads native extras alongside the mapped fields", () => {
    const { promptObject } = service.buildTextToSpeechRequestBody(
      parsed({
        model: "elevenlabs-tts",
        extra: {
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5 },
        },
      }),
    );
    expect(promptObject).toMatchObject({
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5 },
      voice_id: "alloy",
    });
  });

  it("does not let a passthrough extra field override text/voice_id/output_format", () => {
    const { promptObject } = service.buildTextToSpeechRequestBody(
      parsed({
        model: "elevenlabs-tts",
        responseFormat: "mp3_44100_128",
        extra: {
          text: "smuggled",
          voice_id: "smuggled",
          output_format: "smuggled",
        },
      }),
    );
    expect(promptObject).toMatchObject({
      text: "hello",
      voice_id: "alloy",
      output_format: "mp3_44100_128",
    });
  });

  it("never sends a top-level voice or response_format key", () => {
    const { promptObject } = service.buildTextToSpeechRequestBody(
      parsed({ model: "elevenlabs-tts" }),
    );
    expect(promptObject).not.toHaveProperty("voice");
    expect(promptObject).not.toHaveProperty("response_format");
  });
});

describe("buildTextToSpeechRequestBody — qwen3-tts-flash", () => {
  it("sends voice as-is and never a format/speed field", () => {
    expect(
      service.buildTextToSpeechRequestBody(
        parsed({
          model: "qwen3-tts-flash",
          voice: "Dylan",
          responseFormat: undefined,
        }),
      ),
    ).toEqual({
      type: "TEXT_TO_SPEECH",
      model: "qwen3-tts-flash",
      promptObject: {
        text: "hello",
        voice: "Dylan",
      },
    });
  });

  it("spreads native extras alongside text/voice", () => {
    const { promptObject } = service.buildTextToSpeechRequestBody(
      parsed({
        model: "qwen3-tts-flash",
        responseFormat: undefined,
        extra: { language_type: "Chinese" },
      }),
    );
    expect(promptObject).toEqual({
      language_type: "Chinese",
      text: "hello",
      voice: "alloy",
    });
  });

  it("does not let a passthrough extra field override text/voice", () => {
    const { promptObject } = service.buildTextToSpeechRequestBody(
      parsed({
        model: "qwen3-tts-flash",
        responseFormat: undefined,
        extra: { text: "smuggled", voice: "smuggled" },
      }),
    );
    expect(promptObject).toEqual({
      text: "hello",
      voice: "alloy",
    });
  });
});
