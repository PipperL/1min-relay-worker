/**
 * Input conversion for the OpenAI Responses API (/v1/responses)
 *
 * Turns the `input` field of a Responses API request into the internal
 * `Message[]` format. Kept separate from the handler so the conversion can be
 * unit tested without a Worker runtime.
 */

import type {
  FileContent,
  Message,
  MessageContent,
  ResponseInputItem,
} from "../types";
import { ValidationError } from "./errors";

/**
 * Content part types that carry plain text.
 *
 * The Responses API names text parts differently depending on direction:
 * `input_text` for what the client sends, `output_text` for assistant turns
 * echoed back into a follow-up request. Some clients simply send `text`.
 */
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);

interface ExtractedContent {
  text: string;
  files: FileContent[];
}

/**
 * Split an input item's content into its text and its file attachments.
 *
 * Anything else (`input_image`, ...) is rejected rather than silently dropped:
 * dropping it would send a truncated prompt upstream and produce a
 * confidently wrong answer.
 */
function extractInputItemContent(
  content: string | Array<Record<string, unknown>>,
): ExtractedContent {
  if (typeof content === "string") {
    return { text: content, files: [] };
  }

  const textParts: string[] = [];
  const files: FileContent[] = [];
  const unsupportedTypes = new Set<string>();

  for (const part of content) {
    const type = typeof part.type === "string" ? part.type : "";
    if (TEXT_PART_TYPES.has(type)) {
      if (typeof part.text === "string" && part.text) {
        textParts.push(part.text);
      }
    } else if (type === "input_file") {
      files.push({ ...(part as unknown as FileContent), type: "input_file" });
    } else {
      unsupportedTypes.add(type);
    }
  }

  if (unsupportedTypes.size > 0) {
    const listed = Array.from(unsupportedTypes).sort().join(", ");
    throw new ValidationError(
      `Unsupported content part type(s) in "input": ${listed}. ` +
        "Supported parts are text (text, input_text, output_text) and " +
        "input_file. Use the OpenAI Chat Completions API " +
        "(/v1/chat/completions) for vision requests.",
      "input",
      "unsupported_content_type",
    );
  }

  return { text: textParts.join("\n"), files };
}

/**
 * Convert a Responses API `input` field into internal messages.
 *
 * @param input      Either a bare prompt string or an array of input items.
 * @param instructions Optional system prompt, prepended as a system message.
 */
export function convertInputToMessages(
  input: string | ResponseInputItem[],
  instructions?: string,
): Message[] {
  const messages: Message[] = [];

  // Instructions map onto a leading system message
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else {
    for (const item of input) {
      // `type` is optional in the Responses API spec: an item carrying only
      // `role` + `content` is a message item. Items of any other type
      // (function_call, item_reference, ...) are not supported and skipped.
      if (item.type && item.type !== "message") {
        continue;
      }

      const { text, files } = extractInputItemContent(
        item.content as string | Array<Record<string, unknown>>,
      );

      // Keep the structured form only when there is something to attach;
      // a plain string stays a plain string for every other code path.
      const content: MessageContent =
        files.length > 0
          ? [...(text ? [{ type: "text" as const, text }] : []), ...files]
          : text;

      messages.push({ role: item.role, content });
    }
  }

  // Guard against silently forwarding an empty prompt: upstream would answer
  // with a generic greeting instead of an error, which is very hard to debug.
  // An attachment on its own counts as content — "summarise this file" is a
  // legitimate request with no prompt text of its own. That is measured, not
  // assumed: the prompt we forward in that case is literally "Human: \n\n",
  // and against the live upstream it reads the attached file and answers from
  // it, while the same empty prompt with no attachment gets back "your message
  // got cut off". The attachment carries the request; the guard only needs to
  // catch the genuinely empty case.
  const hasPrompt = messages.some((message) => {
    if (message.role === "system") return false;
    if (typeof message.content === "string") {
      return message.content.trim() !== "";
    }
    return message.content.some(
      (part) =>
        (part.type === "text" && part.text.trim() !== "") ||
        part.type === "input_file",
    );
  });
  if (!hasPrompt) {
    throw new ValidationError(
      'No usable message content found in "input". Provide at least one ' +
        "message item with non-empty text content.",
      "input",
      "empty_input",
    );
  }

  return messages;
}
