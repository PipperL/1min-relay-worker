/**
 * Audio endpoint handler: transcription, translation and text-to-speech
 */

import { ONE_MIN_ASSET_CDN_URL } from "../constants/config";
import {
  isAudioTranslationModel,
  isSpeechModel,
  isTextToSpeechModel,
} from "../services/model-registry";
import type {
  AudioResponseFormat,
  OneMinChatResponse,
  SpeechRequest,
} from "../types";
import {
  type AudioData,
  audioMimeToExtension,
  parseAudioFormData,
  uploadAudioToAsset,
  validateAudioFile,
} from "../utils/audio";
import { ApiError, ValidationError } from "../utils/errors";
import { createSuccessResponse, extractOneMinContent } from "../utils/response";
import { parseSpeechRequest, ttsContentType } from "../utils/speech";
import { BaseTextHandler } from "./base";
import { toAssetUrl } from "./images";

export class AudioHandler extends BaseTextHandler {
  async handleTranscription(
    request: Request,
    apiKey: string,
  ): Promise<Response> {
    const parsed = await parseAudioFormData(request);

    await validateAudioFile(parsed.file);

    if (!(await isSpeechModel(parsed.model, this.env))) {
      throw new ValidationError(
        `Model '${parsed.model}' does not support speech-to-text`,
        "model",
        "model_not_supported",
      );
    }

    const audioUrl = await this.uploadAudio(parsed.file, apiKey);

    const requestBody = this.apiService.buildSpeechToTextRequestBody(
      audioUrl,
      parsed.model,
      parsed.language,
      parsed.responseFormat,
      parsed.prompt,
      parsed.temperature,
    );

    const data = await this.apiService.sendAudioRequest(requestBody, apiKey);

    return this.formatResponse(data, parsed.responseFormat, "transcribe");
  }

  async handleTranslation(request: Request, apiKey: string): Promise<Response> {
    const parsed = await parseAudioFormData(request);

    await validateAudioFile(parsed.file);

    if (!isAudioTranslationModel(parsed.model)) {
      throw new ValidationError(
        `Model '${parsed.model}' does not support audio translation. Only whisper-1 is supported for translation.`,
        "model",
        "model_not_supported",
      );
    }

    const audioUrl = await this.uploadAudio(parsed.file, apiKey);

    const requestBody = this.apiService.buildAudioTranslatorRequestBody(
      audioUrl,
      parsed.model,
      parsed.responseFormat,
      parsed.temperature,
      parsed.prompt,
    );

    const data = await this.apiService.sendAudioRequest(requestBody, apiKey);

    return this.formatResponse(data, parsed.responseFormat, "translate");
  }

  /**
   * OpenAI-compatible text-to-speech (/v1/audio/speech).
   *
   * The upstream stores the generated file and answers with a signed
   * `temporaryUrl`, so the relay fetches that and streams the bytes back —
   * callers of this endpoint expect audio, not a link.
   */
  async handleSpeech(request: Request, apiKey: string): Promise<Response> {
    const body = (await request.json()) as SpeechRequest;
    const parsed = parseSpeechRequest(body);

    if (!(await isTextToSpeechModel(parsed.model, this.env))) {
      throw new ValidationError(
        `Model '${parsed.model}' does not support text-to-speech`,
        "model",
        "model_not_supported",
      );
    }

    const requestBody = this.apiService.buildTextToSpeechRequestBody(
      parsed.text,
      parsed.model,
      parsed.voice,
      parsed.responseFormat,
      parsed.speed,
    );

    const data = await this.apiService.sendAudioRequest(requestBody, apiKey);

    const audioUrl = this.resolveAudioUrl(data);
    if (!audioUrl) {
      throw new ApiError("No audio result found in API response", 502);
    }

    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok || !audioResponse.body) {
      console.error(
        `Failed to fetch generated audio: ${audioResponse.status} ${audioResponse.statusText}`,
      );
      throw new ApiError("Failed to retrieve the generated audio", 502);
    }

    return new Response(audioResponse.body, {
      status: 200,
      headers: {
        "Content-Type": ttsContentType(parsed.responseFormat),
        "Cache-Control": "no-store",
      },
    });
  }

  /**
   * Prefer the signed URL; fall back to the public asset CDN when the record
   * carries only a storage path.
   */
  private resolveAudioUrl(data: OneMinChatResponse): string | null {
    const signed = data.aiRecord?.temporaryUrl;
    if (signed) return signed;

    const path = data.aiRecord?.aiRecordDetail?.resultObject?.[0];
    if (!path) return null;

    const cdnBaseUrl = this.env.ONE_MIN_ASSET_CDN_URL || ONE_MIN_ASSET_CDN_URL;
    return toAssetUrl(path, cdnBaseUrl);
  }

  private async uploadAudio(file: File, apiKey: string): Promise<string> {
    const mimeType = file.type || "audio/mpeg";
    const ext = audioMimeToExtension(mimeType);
    const filename = `audio-${crypto.randomUUID()}${ext}`;
    const arrayBuffer = await file.arrayBuffer();

    const audioData: AudioData = {
      data: arrayBuffer,
      mimeType,
      filename,
    };

    return uploadAudioToAsset(audioData, apiKey, this.env.ONE_MIN_ASSET_URL);
  }

  private formatResponse(
    data: OneMinChatResponse,
    responseFormat: AudioResponseFormat,
    task: "transcribe" | "translate",
  ): Response {
    const text = extractOneMinContent(data);

    if (responseFormat === "vtt") {
      return new Response(text, {
        headers: { "Content-Type": "text/vtt; charset=utf-8" },
      });
    }

    if (responseFormat === "srt" || responseFormat === "text") {
      return new Response(text, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (responseFormat === "verbose_json") {
      // 1min.ai does not return segment/duration data;
      // return best-effort response with available fields
      return createSuccessResponse({
        task,
        language: "",
        duration: 0,
        text,
        segments: [],
      });
    }

    // Default: json format
    return createSuccessResponse({ text });
  }
}
