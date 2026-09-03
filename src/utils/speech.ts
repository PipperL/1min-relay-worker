/**
 * Request parsing for the text-to-speech endpoint (/v1/audio/speech).
 *
 * OpenAI names the text `input`; the upstream names it `text`. Kept separate
 * from the handler so the validation can be unit tested.
 */

import {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_RESPONSE_FORMAT,
  DEFAULT_TTS_VOICE,
  MAX_TTS_INPUT_LENGTH,
  TTS_CONTENT_TYPES,
} from "../constants/config";
import type { SpeechRequest } from "../types";
import { ValidationError } from "./errors";

export interface ParsedSpeechRequest {
  model: string;
  text: string;
  voice: string;
  responseFormat: string;
  speed?: number;
}

const MIN_SPEED = 0.25;
const MAX_SPEED = 4.0;

export function parseSpeechRequest(body: SpeechRequest): ParsedSpeechRequest {
  const text = typeof body.input === "string" ? body.input : "";
  if (!text.trim()) {
    throw new ValidationError(
      "input: Field required and must be a non-empty string",
      "input",
    );
  }
  if (text.length > MAX_TTS_INPUT_LENGTH) {
    throw new ValidationError(
      `input exceeds the maximum length of ${MAX_TTS_INPUT_LENGTH} characters`,
      "input",
    );
  }

  const responseFormat = body.response_format ?? DEFAULT_TTS_RESPONSE_FORMAT;
  if (!(responseFormat in TTS_CONTENT_TYPES)) {
    const supported = Object.keys(TTS_CONTENT_TYPES).join(", ");
    throw new ValidationError(
      `Unsupported response_format '${responseFormat}'. Supported: ${supported}`,
      "response_format",
    );
  }

  let speed: number | undefined;
  if (body.speed !== undefined) {
    if (
      typeof body.speed !== "number" ||
      Number.isNaN(body.speed) ||
      body.speed < MIN_SPEED ||
      body.speed > MAX_SPEED
    ) {
      throw new ValidationError(
        `speed must be a number between ${MIN_SPEED} and ${MAX_SPEED}`,
        "speed",
      );
    }
    speed = body.speed;
  }

  return {
    model: body.model || DEFAULT_TTS_MODEL,
    text,
    voice: body.voice || DEFAULT_TTS_VOICE,
    responseFormat,
    speed,
  };
}

export function ttsContentType(responseFormat: string): string {
  return TTS_CONTENT_TYPES[responseFormat] ?? "application/octet-stream";
}
