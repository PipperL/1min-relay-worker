/**
 * Response utilities for consistent API responses
 *
 * CORS headers are handled globally by the Hono CORS middleware (src/middleware/cors.ts).
 * Response utilities should NOT add CORS headers manually.
 */

import type { OneMinChatResponse } from "../types";
import { ApiError, ValidationError } from "./errors";

export interface OneMinFailure {
  message: string;
  code?: string;
}

const MAX_FAILURE_MESSAGE_LENGTH = 500;

/**
 * Detect a record the upstream marked as failed.
 *
 * Some failures arrive as HTTP 200: the moderation check that runs before
 * every chat answers with `aiRecord.status: "FAILURE"` and puts the error
 * object where the answer would be —
 *
 *   "resultObject": {"code":"OPEN_AI_CONTENT_POLICY_VIOLATION",
 *                    "name":"ValidationError","message":"The input content…"}
 *
 * — so `resultObject[0]` is undefined and the request looked like an empty
 * success. Streaming is no different: no `event: error`, just an
 * `event: result` carrying this same record.
 */
export function extractOneMinFailure(data: unknown): OneMinFailure | null {
  if (!data || typeof data !== "object") return null;
  const record = (data as { aiRecord?: unknown }).aiRecord;
  if (!record || typeof record !== "object") return null;

  const { status, aiRecordDetail } = record as {
    status?: unknown;
    aiRecordDetail?: { resultObject?: unknown };
  };
  const result = aiRecordDetail?.resultObject;
  const errorObject =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;

  if (status !== "FAILURE" && !errorObject) return null;

  const rawMessage =
    typeof errorObject?.message === "string" && errorObject.message.trim()
      ? errorObject.message.trim()
      : "1min.ai reported the request as failed";
  const message =
    rawMessage.length > MAX_FAILURE_MESSAGE_LENGTH
      ? `${rawMessage.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1)}…`
      : rawMessage;
  const code =
    typeof errorObject?.code === "string" ? errorObject.code : undefined;

  return { message, code };
}

/**
 * The error to raise for a failed record. A moderation rejection is the
 * caller's input, so it maps to what OpenAI's own endpoint answers (400
 * `content_policy_violation`); anything else is the upstream's fault.
 */
export function oneMinFailureError(
  failure: OneMinFailure,
): ValidationError | ApiError {
  if (failure.code?.includes("CONTENT_POLICY")) {
    return new ValidationError(
      failure.message,
      "messages",
      "content_policy_violation",
    );
  }
  return new ApiError(failure.message, 502, failure.code ?? "upstream_error");
}

/**
 * Extract text content from a 1min.ai response, with consistent fallback logic.
 * Throws when the upstream marked the record as failed.
 */
export function extractOneMinContent(data: OneMinChatResponse): string {
  const failure = extractOneMinFailure(data);
  if (failure) throw oneMinFailureError(failure);

  const content =
    data.aiRecord?.aiRecordDetail?.resultObject?.[0] || data.content;
  if (!content) {
    console.warn(
      "Empty response from 1min.ai — no resultObject or content field",
    );
    return "";
  }
  return content;
}

export interface OneMinUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  finishReason?: string;
}

/**
 * Read token accounting out of a 1min.ai response.
 *
 * The upstream reports usage as `aiRecord.metadata.{inputToken,outputToken,
 * totalToken}` and has no OpenAI-style `usage` object at all, so reading
 * `data.usage` (as this relay used to) always yielded zeroes.
 *
 * Returns null when the record carries no token counts — image and
 * text-to-speech records, for instance, put other things in `metadata` — so
 * callers can fall back to a local estimate.
 */
export function extractOneMinUsage(
  data: OneMinChatResponse,
): OneMinUsage | null {
  const metadata = data.aiRecord?.metadata;
  if (!metadata) return null;

  const { inputToken, outputToken, totalToken, finishReason } = metadata;
  if (typeof inputToken !== "number" && typeof outputToken !== "number") {
    return null;
  }

  const promptTokens = inputToken ?? 0;
  const completionTokens = outputToken ?? 0;

  // Observed in production: the upstream occasionally returns metadata whose
  // token counts are all zero for a request that plainly consumed tokens. A
  // real exchange is never 0/0 — the prompt alone costs something — so treat
  // that as "not accounted for" and let the caller estimate locally, rather
  // than reporting a confident zero to a client that meters on it.
  if (promptTokens === 0 && completionTokens === 0) return null;

  return {
    promptTokens,
    completionTokens,
    totalTokens: totalToken ?? promptTokens + completionTokens,
    finishReason,
  };
}

/** OpenAI's `finish_reason` is a closed set; anything else breaks strict SDKs. */
const FINISH_REASONS: Record<string, OpenAIFinishReason> = {
  length: "length",
  max_tokens: "length",
  max_output_tokens: "length",
  truncated: "length",
  content_filter: "content_filter",
  safety: "content_filter",
  recitation: "content_filter",
  prohibited_content: "content_filter",
  tool_calls: "tool_calls",
  tool_use: "tool_calls",
  function_call: "tool_calls",
};

export type OpenAIFinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "tool_calls";

/**
 * Map the upstream's `finishReason` onto OpenAI's closed set.
 *
 * 1min.ai fronts many providers and passes their reason through verbatim, so
 * the value is provider-shaped: Cohere answers "complete", others uppercase it
 * or omit it entirely. Returning that raw makes a strictly-typed client fail
 * to parse a response that is otherwise fine, so anything unrecognised — an
 * ordinary completion by any other name — becomes "stop".
 *
 * Read straight off the record rather than from `extractOneMinUsage`, which
 * reports null whenever the token counts are missing or zero: that is exactly
 * when the reason matters most.
 */
export function extractFinishReason(
  data: OneMinChatResponse,
): OpenAIFinishReason {
  const reason = data.aiRecord?.metadata?.finishReason;
  if (typeof reason !== "string") return "stop";
  return FINISH_REASONS[reason.trim().toLowerCase()] ?? "stop";
}

export function createSuccessResponse<T = unknown>(
  data: T,
  status: number = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
