/**
 * Message types for chat completions
 */

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

/**
 * A file attachment carried through from a Responses API `input_file` part.
 * Exactly one of file_id / file_data / file_url identifies the file.
 */
export interface FileContent {
  type: "input_file";
  /** An asset id already returned by the Asset API (its fileContent.uuid) */
  file_id?: string;
  /** Base64 payload, bare or as a data: URI */
  file_data?: string;
  file_url?: string;
  filename?: string;
}

export type MessageContent =
  | string
  | (TextContent | ImageContent | FileContent)[];

export interface Message {
  role: "system" | "user" | "assistant";
  content: MessageContent;
  name?: string;
}
