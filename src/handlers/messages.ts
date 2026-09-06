/**
 * Anthropic Messages API endpoint handler
 * Handles requests in Anthropic SDK format and returns Anthropic-compatible responses
 */

import { DEFAULT_MODEL } from "../constants";
import type {
  AnthropicContentBlock,
  AnthropicImageContent,
  AnthropicMessage,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicTextContent,
  ImageContent,
  Message,
  MessageContent,
  OneMinChatResponse,
  TextContent,
} from "../types";
import {
  calculateTokens,
  estimateInputTokens,
  extractOneMinContent,
  extractOneMinUsage,
  ValidationError,
  validateModelAndMessages,
  type WebSearchConfig,
} from "../utils";
import { writeSSEEventWithType } from "../utils/sse";
import { executeStreamingPipeline } from "../utils/streaming";
import { BaseTextHandler } from "./base";

export class MessagesHandler extends BaseTextHandler {
  async handleMessages(
    requestBody: AnthropicMessageRequest,
    apiKey: string,
  ): Promise<Response> {
    // `tools` is accepted by the Anthropic schema but not forwarded upstream —
    // 1min.ai's Chat with AI API has no function-calling support. Rejecting it
    // outright broke the clients most likely to send it: the Anthropic SDK and
    // Claude Code attach `tools` to essentially every /v1/messages request, and
    // a conversation replaying a tool_result always resends the tools that
    // produced it. Silently ignoring `tools` is the answer real clients are
    // built against.

    // Validate required fields
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      throw new ValidationError("messages: Field required");
    }

    if (!requestBody.max_tokens || requestBody.max_tokens <= 0) {
      throw new ValidationError("max_tokens: Field required");
    }

    const rawModel = requestBody.model || DEFAULT_MODEL;

    // Convert Anthropic messages to internal format
    const internalMessages = this.convertToInternalMessages(
      requestBody.messages,
      requestBody.system,
    );

    const { cleanModel, webSearchConfig, processedMessages } =
      await validateModelAndMessages(rawModel, internalMessages, this.env);

    // Handle streaming vs non-streaming
    if (requestBody.stream) {
      return this.handleStreamingMessage(
        processedMessages,
        cleanModel,
        apiKey,
        webSearchConfig,
      );
    } else {
      return this.handleNonStreamingMessage(
        processedMessages,
        cleanModel,
        apiKey,
        webSearchConfig,
      );
    }
  }

  private convertToInternalMessages(
    messages: AnthropicMessage[],
    system?: string | AnthropicTextContent[],
  ): Message[] {
    const internalMessages: Message[] = [];

    // Add system message if present (Anthropic puts system at top-level)
    if (system) {
      const systemText =
        typeof system === "string"
          ? system
          : system.map((block) => block.text).join("\n");
      internalMessages.push({
        role: "system",
        content: systemText,
      });
    }

    // Convert each Anthropic message
    for (const msg of messages) {
      const content = this.extractAnthropicContent(msg.content);
      internalMessages.push({
        role: msg.role,
        content,
      });
    }

    return internalMessages;
  }

  private extractAnthropicContent(
    content: string | AnthropicContentBlock[],
  ): MessageContent {
    if (typeof content === "string") {
      return content;
    }

    const hasImages = content.some((block) => block.type === "image");
    if (!hasImages) {
      // No images: keep the original flattened-to-text behavior so plain
      // text/tool_result conversations are unaffected.
      const textParts: string[] = [];
      for (const block of content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_result") {
          const resultText =
            typeof block.content === "string"
              ? block.content
              : block.content.map((b) => b.text).join("\n");
          textParts.push(resultText);
        }
      }
      return textParts.join("\n");
    }

    // Images present: emit a MessageContent array so the shared vision
    // pipeline (isVisionModel gating, Asset API upload — see onemin-api.ts
    // and processMessagesWithImageCheck) handles it exactly like the OpenAI
    // Chat Completions path.
    const parts: (TextContent | ImageContent)[] = [];
    for (const block of content) {
      if (block.type === "text") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        parts.push({
          type: "image_url",
          image_url: { url: this.anthropicImageToUrl(block) },
        });
      } else if (block.type === "tool_result") {
        const resultText =
          typeof block.content === "string"
            ? block.content
            : block.content.map((b) => b.text).join("\n");
        parts.push({ type: "text", text: resultText });
      }
    }
    return parts;
  }

  /**
   * Anthropic's image source is either a base64 payload (turned into a
   * `data:` URL, the same shape `processImageUrl` already parses for the
   * OpenAI path) or a plain URL.
   */
  private anthropicImageToUrl(block: AnthropicImageContent): string {
    const { source } = block;
    if (source.type === "url" && source.url) {
      return source.url;
    }
    if (source.type === "base64" && source.data) {
      const mediaType = source.media_type || "image/png";
      return `data:${mediaType};base64,${source.data}`;
    }
    throw new ValidationError(
      "Image content block requires source.url (for type 'url') or source.data (for type 'base64')",
      "content",
      "invalid_image_source",
    );
  }

  private async handleNonStreamingMessage(
    messages: Message[],
    model: string,
    apiKey: string,
    webSearchConfig?: WebSearchConfig,
  ): Promise<Response> {
    const data = await this.sendNonStreamingRequest(
      messages,
      model,
      apiKey,
      webSearchConfig,
    );

    const anthropicResponse = this.transformToAnthropicFormat(
      data,
      model,
      messages,
    );

    return new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleStreamingMessage(
    messages: Message[],
    model: string,
    apiKey: string,
    webSearchConfig?: WebSearchConfig,
  ): Promise<Response> {
    const response = await this.sendStreamingRequest(
      messages,
      model,
      apiKey,
      webSearchConfig,
    );

    const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

    return executeStreamingPipeline(response, {
      onStart: async (writer) => {
        // Send message_start event
        const messageStart: AnthropicMessageResponse = {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: estimateInputTokens(messages),
            output_tokens: 0,
          },
        };
        await writeSSEEventWithType(writer, "message_start", {
          type: "message_start",
          message: messageStart,
        });

        // Send content_block_start
        await writeSSEEventWithType(writer, "content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });

        // Send ping
        await writeSSEEventWithType(writer, "ping", { type: "ping" });
      },
      onChunk: async (writer, chunk) => {
        await writeSSEEventWithType(writer, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: chunk },
        });
      },
      onEnd: async (writer, accumulatedContent) => {
        // Send content_block_stop
        await writeSSEEventWithType(writer, "content_block_stop", {
          type: "content_block_stop",
          index: 0,
        });

        // Send message_delta with stop reason and usage
        const outputTokens = calculateTokens(accumulatedContent, model);
        await writeSSEEventWithType(writer, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: outputTokens },
        });

        // Send message_stop
        await writeSSEEventWithType(writer, "message_stop", {
          type: "message_stop",
        });
      },
      onError: async (writer, error) => {
        await writeSSEEventWithType(writer, "error", {
          type: "error",
          error: { type: error.type, message: error.message },
        });
      },
    });
  }

  private transformToAnthropicFormat(
    data: OneMinChatResponse,
    model: string,
    messages: Message[],
  ): AnthropicMessageResponse {
    const content = extractOneMinContent(data);

    const usage = extractOneMinUsage(data);
    const inputTokens = usage?.promptTokens ?? estimateInputTokens(messages);
    const outputTokens =
      usage?.completionTokens ?? calculateTokens(content, model);

    return {
      id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: content }],
      model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    };
  }
}
