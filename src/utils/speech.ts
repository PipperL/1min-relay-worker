/**
 * Request parsing for the text-to-speech endpoint (/v1/audio/speech).
 *
 * OpenAI names the text `input`; the upstream names it `text`. Kept separate
 * from the handler so the validation can be unit tested.
 *
 * The upstream `TEXT_TO_SPEECH` feature fans out to three different backend
 * shapes depending on `model`: OpenAI-compatible (tts-1/tts-1-hd), ElevenLabs
 * (elevenlabs-tts) and Qwen3 (qwen3-tts-flash). Only OpenAI's shape is
 * documented as the request envelope, so the other two need per-model field
 * handling:
 *
 * - Known-overlapping fields that differ only in name (`voice`/`voice_id`,
 *   `response_format`/`output_format`) are translated: the vendor-native name
 *   wins when present, otherwise the OpenAI-shaped name is mapped onto it.
 *   Values are never validated or rewritten — an unsupported voice/format is
 *   left for the upstream to reject.
 * - Known fields the target model cannot honor under any name (`speed` for
 *   ElevenLabs and Qwen3; `response_format`/`output_format` for Qwen3, which
 *   always returns WAV) are rejected here, because the upstream has no field
 *   to forward them to and would otherwise silently ignore them.
 * - Everything else (ElevenLabs' `model_id`/`voice_settings`/
 *   `optimize_streaming_latency`/`language_code`, Qwen3's `language_type`,
 *   and any future vendor-specific field) is passed straight through,
 *   unvalidated — see README's TTS parameter table.
 *
 * Any model outside these two — including google-tts and unrecognized ids —
 * keeps the original OpenAI-shaped behavior unchanged.
 */

import {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_RESPONSE_FORMAT,
  DEFAULT_TTS_VOICE,
  ELEVENLABS_TTS_MODEL_ID,
  MAX_TTS_INPUT_LENGTH,
  QWEN3_TTS_MODEL_ID,
  TTS_CONTENT_TYPES,
} from "../constants/config";
import type { SpeechRequest } from "../types";
import { ValidationError } from "./errors";

export interface ParsedSpeechRequest {
  model: string;
  text: string;
  voice: string;
  /**
   * Omitted when no format was resolved for this model: ElevenLabs' native
   * `output_format` is optional upstream, so it's left unset rather than
   * defaulted when the caller doesn't supply one; Qwen3 has no such field at
   * all.
   */
  responseFormat?: string;
  speed?: number;
  /** Vendor-native fields with no OpenAI-shaped equivalent, forwarded as-is. */
  extra: Record<string, unknown>;
}

const MIN_SPEED = 0.25;
const MAX_SPEED = 4.0;

// Fields the relay understands by name. Anything else on the body is
// collected into `extra` and passed straight through to the upstream.
const KNOWN_FIELDS = new Set([
  "model",
  "input",
  "voice",
  "voice_id",
  "response_format",
  "output_format",
  "speed",
]);

function collectExtra(body: SpeechRequest): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (!KNOWN_FIELDS.has(key)) {
      extra[key] = body[key];
    }
  }
  return extra;
}

function parseText(body: SpeechRequest): string {
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
  return text;
}

function parseSpeed(body: SpeechRequest): number | undefined {
  if (body.speed === undefined) return undefined;
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
  return body.speed;
}

function parseElevenLabs(
  body: SpeechRequest,
  model: string,
  text: string,
  extra: Record<string, unknown>,
): ParsedSpeechRequest {
  // ElevenLabs has no `speed` equivalent under any field name — the upstream
  // has no way to reject it, so the relay must.
  if (body.speed !== undefined) {
    throw new ValidationError(
      "Model 'elevenlabs-tts' does not support the 'speed' parameter " +
        "(ElevenLabs has no equivalent). Remove it, or use the passthrough " +
        "'voice_settings' field to adjust delivery natively.",
      "speed",
    );
  }

  // `voice_id` is ElevenLabs' native field and wins when present; otherwise
  // the OpenAI-shaped `voice` is mapped onto it, unvalidated.
  const voice = body.voice_id || body.voice || DEFAULT_TTS_VOICE;

  // `output_format` is ElevenLabs' native field; `response_format` is
  // accepted as an OpenAI-shaped alias. Both are optional upstream (it
  // defaults to mp3_44100_128), so when neither is given we send nothing.
  const responseFormat =
    body.output_format || body.response_format || undefined;

  return { model, text, voice, responseFormat, extra };
}

function parseQwen3(
  body: SpeechRequest,
  model: string,
  text: string,
  extra: Record<string, unknown>,
): ParsedSpeechRequest {
  // Qwen3 always returns WAV and has no `response_format`/`output_format`
  // concept at all — the upstream has no field to forward this to, so the
  // relay must reject it rather than silently drop it.
  if (body.response_format !== undefined || body.output_format !== undefined) {
    throw new ValidationError(
      "Model 'qwen3-tts-flash' does not support 'response_format' / " +
        "'output_format' (it always returns WAV audio). Omit it from the request.",
      "response_format",
    );
  }
  // Nor does it support `speed`.
  if (body.speed !== undefined) {
    throw new ValidationError(
      "Model 'qwen3-tts-flash' does not support the 'speed' parameter.",
      "speed",
    );
  }

  // Qwen3's native voice field happens to also be named `voice`, so no
  // mapping is needed — the value (one of its 49 native voice names) is
  // forwarded unvalidated.
  const voice = body.voice || DEFAULT_TTS_VOICE;

  return { model, text, voice, responseFormat: undefined, extra };
}

export function parseSpeechRequest(body: SpeechRequest): ParsedSpeechRequest {
  const text = parseText(body);
  const model = body.model || DEFAULT_TTS_MODEL;
  const extra = collectExtra(body);

  if (model === ELEVENLABS_TTS_MODEL_ID) {
    return parseElevenLabs(body, model, text, extra);
  }
  if (model === QWEN3_TTS_MODEL_ID) {
    return parseQwen3(body, model, text, extra);
  }

  // Default path: tts-1 / tts-1-hd, google-tts, and any future/unrecognized
  // model id — unchanged OpenAI-shaped behavior.
  const responseFormat = body.response_format ?? DEFAULT_TTS_RESPONSE_FORMAT;
  if (!(responseFormat in TTS_CONTENT_TYPES)) {
    const supported = Object.keys(TTS_CONTENT_TYPES).join(", ");
    throw new ValidationError(
      `Unsupported response_format '${responseFormat}'. Supported: ${supported}`,
      "response_format",
    );
  }
  const speed = parseSpeed(body);
  const voice = body.voice || DEFAULT_TTS_VOICE;

  return { model, text, voice, responseFormat, speed, extra };
}

export function ttsContentType(responseFormat: string): string {
  return TTS_CONTENT_TYPES[responseFormat] ?? "application/octet-stream";
}

/**
 * The Content-Type to answer with. ElevenLabs (via 1min.ai) only ever
 * returns mp3-family audio and Qwen3 always returns wav, regardless of what
 * was requested, so those two are hardcoded rather than echoing the
 * (possibly irrelevant) requested response_format.
 */
export function resolveTtsContentType(
  model: string,
  responseFormat?: string,
): string {
  if (model === ELEVENLABS_TTS_MODEL_ID) return "audio/mpeg";
  if (model === QWEN3_TTS_MODEL_ID) return "audio/wav";
  return ttsContentType(responseFormat ?? DEFAULT_TTS_RESPONSE_FORMAT);
}
