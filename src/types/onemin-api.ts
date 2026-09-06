/**
 * 1min.ai API specific types
 */

export interface WebSearchSettings {
  webSearch: boolean;
  numOfSite?: number;
  maxWord?: number;
}

export interface HistorySettings {
  isMixed: boolean;
  historyMessageLimit?: number;
}

export interface PromptSettings {
  webSearchSettings?: WebSearchSettings;
  historySettings?: HistorySettings;
  withMemories?: boolean;
}

export interface PromptAttachments {
  images?: string[];
  files?: string[];
}

export interface OneMinPromptObject {
  /** Required by chat and image features; text-to-speech uses `text` instead */
  prompt?: string;
  settings?: PromptSettings;
  attachments?: PromptAttachments;
  conversationId?: string;
  // Legacy fields used by non-chat features (image generation)
  n?: number;
  size?: string;
  quality?: string;
  // Audio (Speech-to-Text / Audio Translator) fields
  audioUrl?: string;
  response_format?: string; // snake_case: matches 1min.ai API field name
  temperature?: number;
  language?: string;
  // Text-to-Speech fields
  text?: string;
  voice?: string;
  speed?: number;
  /** ElevenLabs native voice field (used instead of `voice`) */
  voice_id?: string;
  /** ElevenLabs native format field (used instead of `response_format`) */
  output_format?: string;
  // Arbitrary vendor-native passthrough fields (ElevenLabs' `model_id`,
  // `voice_settings`, `optimize_streaming_latency`, `language_code`; Qwen3's
  // `language_type`; etc.) — forwarded to the upstream unvalidated.
  [key: string]: unknown;
}

export interface OneMinRequestBody {
  type: string;
  model: string;
  promptObject: OneMinPromptObject;
  brandVoiceId?: string;
  metadata?: Record<string, unknown>;
}
