# 1min-relay Cloudflare Worker

![GitHub package.json version](https://img.shields.io/github/package-json/v/7a6163/1min-relay-worker)
[![codecov](https://codecov.io/gh/7a6163/1min-relay-worker/graph/badge.svg)](https://codecov.io/gh/7a6163/1min-relay-worker)

A TypeScript implementation of the 1min.ai API relay service, designed to run on Cloudflare Workers with distributed rate limiting and accurate token counting.

## Features

- **Complete API Relay**: Full compatibility with 1min.ai chat completions, responses, image generation, and audio transcription/translation endpoints
- **OpenAI Responses API**: Structured outputs with JSON objects, JSON schema, and reasoning effort control
- **Distributed Rate Limiting**: Uses Cloudflare KV for consistent rate limiting across multiple worker instances
- **Accurate Token Counting**: Integrated with `gpt-tokenizer` for precise token calculation across all models
- **Dynamic Model List**: Model data fetched live from the 1min.ai API with two-tier caching (in-memory + KV), always up to date
- **Streaming Support**: Real-time streaming responses for chat completions
- **TypeScript**: Full type safety and modern development experience
- **Vision Support**: Supports image input for vision models
- **File Attachments**: `input_file` parts on `/v1/responses` are uploaded and attached
- **Audio Transcription & Translation**: OpenAI Whisper-compatible speech-to-text and audio translation endpoints
- **Text to Speech**: OpenAI-compatible `/v1/audio/speech` returning audio bytes

## Supported Models

Model data is fetched dynamically from the 1min.ai API and cached with a two-tier strategy (in-memory 5 min, KV 1 hr). The `GET /v1/models` endpoint always returns the latest available models. Use it to see the full list:

```bash
curl https://your-worker.your-subdomain.workers.dev/v1/models
```

Capabilities such as vision, code interpreter, and web search are derived automatically from the API response — no hardcoded model lists.

## Authentication

Every endpoint except `GET /` requires a key, supplied either way:

```bash
-H "Authorization: Bearer YOUR_API_KEY"   # OpenAI style
-H "x-api-key: YOUR_API_KEY"              # Anthropic style
```

The key is forwarded upstream to 1min.ai as the `API-KEY` header, so it must
be a valid 1min.ai key.

Set the optional `AUTH_TOKEN` secret to gate the relay itself:

```bash
wrangler secret put AUTH_TOKEN
```

With `AUTH_TOKEN` set, the incoming key must equal it exactly or the request
is rejected with 401. With it unset, any key is accepted and passed straight
through.

## Model Names

### Web Search: the `:online` suffix

Append `:online` to any chat model to run the request with 1min.ai web
search enabled:

```json
{ "model": "gpt-4o:online", "messages": [{"role": "user", "content": "..."}] }
```

Tune it with the `WEB_SEARCH_NUM_OF_SITE` (default `1`) and
`WEB_SEARCH_MAX_WORD` (default `500`) environment variables. Any other colon
suffix is rejected with a 400.

## API Endpoints

### Chat Completions

```
POST /v1/chat/completions
```

OpenAI-compatible. Supports `stream`, multi-turn conversations, and image
input on vision models.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messages` | array | Yes | OpenAI-format messages. Content may be a string or a text/`image_url` part array |
| `model` | string | No | Defaults to `open-mistral-nemo`. Append `:online` for web search |
| `stream` | boolean | No | SSE streaming |

> **`temperature` and `max_tokens` are accepted but ignored.** The 1min.ai
> Chat with AI API exposes no sampling parameters, so there is nowhere to
> forward them. They are tolerated so the OpenAI SDKs do not error, but they
> have no effect on the response. `tools` is likewise ignored — the upstream
> has no tool-calling mechanism.

### Responses (Structured Outputs)

```
POST /v1/responses
```

#### Vision Support Example

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "What do you see in this image?"
          },
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ..."
            }
          }
        ]
      }
    ]
  }'
```

#### Responses API Examples

The Responses API supports structured outputs and reasoning control. It accepts two input formats:

**Simple Input Format:**

```bash
curl -X POST http://localhost:8787/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4.1",
    "input": "Tell me a three sentence bedtime story about a unicorn.",
    "reasoning_effort": "medium"
  }'
```

**Messages Format (for conversations):**

```bash
curl -X POST http://localhost:8787/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4.1",
    "messages": [
      {
        "role": "user",
        "content": "Analyze the pros and cons of remote work"
      }
    ],
    "reasoning_effort": "high"
  }'
```

**Structured Input Format (array of input items):**

```bash
curl -X POST http://localhost:8787/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4.1",
    "input": [
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": "Can I use LINE in a browser?" }
        ]
      }
    ]
  }'
```

##### Accepted shapes for `input`

`input` accepts a plain prompt string or an array of input items. For the
array form:

- `type` on an input item is **optional**. Per the OpenAI Responses API spec,
  `type: "message"` is the default, and many clients (the n8n OpenAI node
  among them) send only `role` + `content`. Both spellings are accepted.
  Items of any other type (`function_call`, `item_reference`, ...) are
  skipped.
- `content` may be a string or an array of content parts. Text parts are
  accepted as `text`, `input_text` or `output_text` — the Responses API uses
  different names for what the client sends and for assistant turns replayed
  into a follow-up request.
- `input_file` parts are supported (see **File attachments** below).
  Other non-text parts (`input_image`, ...) are rejected with a `400
  unsupported_content_type` error rather than being dropped. Use
  `/v1/chat/completions` for vision requests.
- A request whose `input` yields neither text nor an attachment is rejected
  with a `400 empty_input` error, instead of forwarding an empty prompt
  upstream.

##### File attachments

An `input_file` part attaches a document (PDF, DOCX, TXT, CSV, JSON, ...) to
the request. Identify the file in one of three ways:

| Field | Meaning |
|---|---|
| `file_data` | Base64 payload, bare or as a `data:` URI. Uploaded for you. |
| `file_url` | HTTPS URL. Fetched and uploaded for you. |
| `file_id` | An id already returned by the 1min.ai Asset API — used as-is. |

```bash
curl -X POST http://localhost:8787/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4.1",
    "input": [
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": "Summarise this document." },
          {
            "type": "input_file",
            "filename": "memo.txt",
            "file_data": "SGVsbG8sIHdvcmxkLg=="
          }
        ]
      }
    ]
  }'
```

Uploads are capped at 50MB, the Asset API's limit. An attachment with no
prompt text of its own is fine.

Note for maintainers: uploaded files are referenced upstream by the Asset
API's `fileContent.uuid`, **not** by the `path` used for images. Passing a
path does not fail — the upstream accepts the request, attaches nothing, and
the model answers from thin air.

**JSON Object Response:**

```bash
curl -X POST http://localhost:8787/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4.1",
    "input": "Analyze the benefits of exercise",
    "response_format": {
      "type": "json_object"
    },
    "reasoning_effort": "high"
  }'
```

**JSON Schema Response:**

```bash
curl -X POST http://localhost:8787/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4.1",
    "input": "Create a user profile for John Doe, age 30, software engineer",
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "user_profile",
        "description": "A user profile object",
        "schema": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "age": {"type": "number"},
            "profession": {"type": "string"},
            "skills": {"type": "array", "items": {"type": "string"}},
            "experience_years": {"type": "number"}
          },
          "required": ["name", "age", "profession"]
        }
      }
    }
  }'
```

**Responses API Features:**

- **Structured Outputs**: JSON objects and JSON schema validation
- **Reasoning Effort**: Control reasoning depth (low, medium, high)
- **Text only**: unlike Chat Completions, `/v1/responses` rejects non-text
  content parts (`input_image`, `input_file`) with a 400. Use
  `/v1/chat/completions` for vision requests.
- **Streaming Support**: Full OpenAI-compatible SSE streaming with `response.completed` terminal event
- **Enhanced Prompting**: Automatically optimizes prompts for structured responses

### Image Generation

```
POST /v1/images/generations
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | Image prompt |
| `model` | string | No | Defaults to `gpt-image-1-mini` |
| `n` | number | No | Defaults to `1` |
| `size` | string | No | Defaults to `1024x1024` |
| `quality` | string | No | Forwarded when given; defaults to `low` for the models that require it |
| `response_format` | string | No | Only `url` is supported |

> `response_format: "b64_json"` is rejected with a 400. The upstream returns
> stored image assets rather than inline data, so results always come back as
> URLs on the 1min.ai asset CDN.

### Audio Transcription (Speech-to-Text)

```
POST /v1/audio/transcriptions
```

Transcribe audio to text using Whisper or Google Speech models. Accepts `multipart/form-data`.

```bash
curl -X POST http://localhost:8787/v1/audio/transcriptions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@audio.mp3" \
  -F "model=whisper-1"
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | Audio file (mp3, mp4, m4a, wav, webm, ogg, flac). Max 25MB. |
| `model` | string | Yes | Model ID (e.g., `whisper-1`, `latest_long`, `latest_short`) |
| `language` | string | No | Language hint (ISO-639-1 for Whisper, BCP-47 for Google Speech) |
| `prompt` | string | No | Prompt to guide transcription style |
| `response_format` | string | No | `json` (default), `text`, `verbose_json`, `srt`, `vtt` |
| `temperature` | number | No | 0–1 sampling temperature |

**OpenAI SDK:**

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/v1", api_key="YOUR_API_KEY")
transcript = client.audio.transcriptions.create(
    model="whisper-1",
    file=open("audio.mp3", "rb"),
)
print(transcript.text)
```

### Audio Translation

```
POST /v1/audio/translations
```

Translate audio to English text. Same parameters as transcription, except
`language` (which does not apply) and `model`: **only `whisper-1` is
supported here.** The Google Speech models valid for transcription
(`latest_long`, `latest_short`, …) are rejected with a 400.

```bash
curl -X POST http://localhost:8787/v1/audio/translations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@foreign-audio.mp3" \
  -F "model=whisper-1"
```

### Text to Speech

```
POST /v1/audio/speech
```

Generate speech from text. Returns the audio bytes with the matching
`Content-Type`, the same as the OpenAI endpoint.

```bash
curl -X POST http://localhost:8787/v1/audio/speech \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"model":"tts-1","input":"Hello there","voice":"alloy"}' \
  --output speech.mp3
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `input` | string | Yes | Text to speak. Max 4096 characters. |
| `model` | string | No | TTS model ID (default `tts-1`). |
| `voice` | string | No | Voice name (default `alloy`). Supported voices depend on the model. |
| `response_format` | string | No | `mp3` (default), `opus`, `aac`, `flac`, `wav`, `pcm` |
| `speed` | number | No | 0.25–4.0 |

**Currently supported TTS models:** `tts-1` and `tts-1-hd` are OpenAI-compatible
and use the parameters above as-is. `elevenlabs-tts` and `qwen3-tts-flash` are
different backends behind the same endpoint and get the per-model field
handling described below. Any other model ID (including `google-tts`, for
which no upstream documentation could be found) is sent in the plain OpenAI
shape unchanged; if a future model turns out to be OpenAI-compatible or needs
its own mapping, it can be added the same way.

**Per-model field handling (elevenlabs-tts / qwen3-tts-flash):**

Fields that exist under different names on both sides are translated
automatically — the model's own native field name wins if you send it
directly, otherwise the OpenAI-shaped name is mapped onto it. Values are
never rewritten or validated by the relay; an unsupported voice or format is
left for the upstream to reject.

| OpenAI-shaped field | elevenlabs-tts native field | qwen3-tts-flash native field |
|---|---|---|
| `voice` | `voice_id` | `voice` (same name, no mapping needed) |
| `response_format` | `output_format` | *(not supported — see below)* |
| `speed` | *(not supported — see below)* | *(not supported — see below)* |

Fields the relay recognizes but the model can't honor under any name are
rejected with a 400 rather than silently dropped, since the upstream itself
has no way to reject them:

- `speed` — neither ElevenLabs nor Qwen3 has an equivalent.
- `response_format` / `output_format` — Qwen3 always returns WAV and has no
  such field at all.

Everything else is passed straight through to the upstream unvalidated —
for example ElevenLabs' `model_id`, `voice_settings`, `optimize_streaming_latency`,
`language_code`, or Qwen3's `language_type`. Send these under their native
names and they'll reach the upstream as-is; see each model's docs on
[docs.1min.ai](https://docs.1min.ai/docs/api/ai-for-audio/text-to-speech) for
the full set. The response `Content-Type` always reflects what the model
actually returns (ElevenLabs is mp3-family audio, Qwen3 is always wav)
rather than echoing the requested `response_format`.

> This endpoint is a fork-only addition — not part of the upstream project.

### Messages (Anthropic-compatible)

```
POST /v1/messages
```

Accepts Anthropic Messages API requests and answers in Anthropic format,
including the `x-api-key` header, top-level `system` prompts, and the
`message_start` / `content_block_delta` / `message_stop` streaming events.
Errors on this path are shaped as `{"type": "error", "error": {...}}` rather
than the OpenAI envelope.

```bash
curl -X POST http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "system": "You are concise.",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messages` | array | Yes | Anthropic messages; `text` and `tool_result` blocks are flattened into the prompt |
| `max_tokens` | number | Yes | Required by the Anthropic schema; not forwarded upstream |
| `model` | string | No | Defaults to `open-mistral-nemo` |
| `system` | string \| array | No | String or `text` block array |
| `stream` | boolean | No | Anthropic SSE event stream |

> **`image` content blocks are rejected with a 400.** Use
> `/v1/chat/completions` for vision. `tools` is accepted by the schema but
> ignored.

### List Models

```
GET /v1/models
```

Only models the upstream reports as `status: "ACTIVE"` are listed — the
models API also returns disabled entries, which are rejected with
`400 UNSUPPORTED_MODEL` if used. `deprecationDate` is not treated as an end
of life: measured against the live API, dated entries are batch renewal
markers still served normally on their listed date, not a per-model cutoff.

### Retrieve Model

```
GET /v1/models/{model}
```

Returns a single model object, or `404 model_not_found`. Model ids containing
a slash work either raw or percent-encoded:

```bash
curl http://localhost:8787/v1/models/gpt-4o -H "Authorization: Bearer YOUR_API_KEY"
curl http://localhost:8787/v1/models/black-forest-labs/flux-dev -H "Authorization: Bearer YOUR_API_KEY"
```

### Health Check

```
GET /
```

Returns a plain-text greeting listing the main endpoints:

- Chat Completions: `/v1/chat/completions`
- Responses: `/v1/responses`
- Image Generation: `/v1/images/generations`
- Audio Transcription: `/v1/audio/transcriptions`
- Audio Translation: `/v1/audio/translations`
- Text to Speech: `/v1/audio/speech`
- Models: `/v1/models`

## Rate Limiting

The worker implements distributed rate limiting with the following limits:

- **Requests per minute**: 180
- **Tokens per minute**: 100,000

Both budgets are per **API key** — the bucket is keyed on a SHA-256 hash of
the `Authorization` header, falling back to `CF-Connecting-IP` or
`X-Forwarded-For` only when no key is present. One budget is shared across
every endpoint; it is not per-endpoint.

Rate limits are enforced using Cloudflare KV storage, ensuring consistency
across all worker instances. Exceeding either budget returns HTTP 429; the
response carries no `X-RateLimit-*` headers.

If the `RATE_LIMIT_STORE` KV binding is absent, rate limiting is disabled
rather than failing closed.

## Setup

### Prerequisites

- Node.js 22.12+ (an active or maintenance LTS line: 22, 24 or 26)
- Wrangler CLI
- Cloudflare account with Workers and KV enabled

### Installation

1. Clone the repository:

```bash
git clone https://github.com/7a6163/1min-relay-worker.git
cd 1min-relay-worker
```

2. Install dependencies:

```bash
npm install
```

3. Configure environment variables in `wrangler.jsonc`:

```jsonc
"vars": {
  "ONE_MIN_CHAT_API_URL": "https://api.1min.ai/api/chat-with-ai",
  "ONE_MIN_API_URL": "https://api.1min.ai/api/features",
  "ONE_MIN_ASSET_URL": "https://api.1min.ai/api/assets",
  "ONE_MIN_MODELS_API_URL": "https://api.1min.ai/models"
}
```

4. Create KV namespaces:

```bash
wrangler kv namespace create "RATE_LIMIT_STORE"
wrangler kv namespace create "MODEL_CACHE"
```

5. After running the commands above, you'll receive a KV namespace ID for each. Copy the IDs and update `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "RATE_LIMIT_STORE",
    "id": "your-rate-limit-kv-id-here"
  },
  {
    "binding": "MODEL_CACHE",
    "id": "your-model-cache-kv-id-here"
  }
]
```

### Development

Start the development server:

```bash
npm run dev
```

### Testing

Unit tests run with [Vitest](https://vitest.dev/):

```bash
npm test          # single run
npm run test:watch
```

Tests live in `tests/` and cover the pure request/response conversion
helpers, so they need no Worker runtime or upstream API key.

### Deployment

#### Quick Deployment

The fastest way to deploy is using the Cloudflare Deploy button at the top of this README:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/7a6163/1min-relay-worker)

#### Manual Deployment

1. Make sure you've completed all the setup steps above, including creating and configuring the KV namespace.

2. Build the project:

```bash
npm run build
```

3. Deploy to Cloudflare Workers:

```bash
npm run deploy
```

4. After successful deployment, you'll receive a URL for your worker (typically `https://1min-relay.your-subdomain.workers.dev`).

#### Custom Domain Configuration

To use a custom domain with your worker:

1. Log in to the Cloudflare dashboard.

2. Navigate to the Workers & Pages section.

3. Select your deployed worker.

4. Click on "Triggers" tab.

5. Under "Custom Domains", click "Add Custom Domain" and follow the instructions.

#### Deployment Troubleshooting

If you encounter issues during deployment:

1. **Authentication errors**: Run `wrangler login` to authenticate with your Cloudflare account.

2. **KV binding errors**: Ensure your KV namespace is correctly configured in `wrangler.jsonc`.

3. **Build errors**: Make sure all dependencies are installed with `npm install`.

4. **Rate limit errors**: If you're hitting Cloudflare's deployment rate limits, wait a few minutes before trying again.

5. **Environment variable issues**: Verify all required environment variables are set in `wrangler.jsonc`.

## Configuration

### Environment Variables

The following environment variables are configured in `wrangler.jsonc`:

Required, set in the `vars` block of `wrangler.jsonc`:

- `ONE_MIN_CHAT_API_URL`: 1min.ai unified chat endpoint (`/api/chat-with-ai`)
- `ONE_MIN_API_URL`: 1min.ai features endpoint for non-chat features like image generation (`/api/features`)
- `ONE_MIN_ASSET_URL`: 1min.ai asset upload endpoint
- `ONE_MIN_MODELS_API_URL`: 1min.ai models API endpoint (for dynamic model list)

Optional:

- `ONE_MIN_ASSET_CDN_URL`: base URL used to build image result URLs (defaults to `https://asset.1min.ai`)
- `WEB_SEARCH_NUM_OF_SITE`: sites consulted for a `:online` request (default `1`)
- `WEB_SEARCH_MAX_WORD`: word budget for `:online` search results (default `500`)

Secret, set with `wrangler secret put`:

- `AUTH_TOKEN`: if set, the incoming API key must match it exactly

### KV Namespaces

- `RATE_LIMIT_STORE`: Used for distributed rate limiting storage
- `MODEL_CACHE`: Used for caching model data fetched from the 1min.ai API (1 hour TTL)

## Usage Examples

### Chat Completion

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Responses (Structured Output)

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4.1",
    "input": "Analyze the benefits of renewable energy",
    "response_format": {
      "type": "json_object"
    },
    "reasoning_effort": "high"
  }'
```

### Image Generation

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-image-1-mini",
    "prompt": "A beautiful sunset over mountains",
    "n": 1,
    "size": "1024x1024"
  }'
```

### Audio Transcription

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/v1/audio/transcriptions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@recording.mp3" \
  -F "model=whisper-1" \
  -F "response_format=text"
```

### Streaming Chat

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Tell me a story"}],
    "stream": true
  }'
```

## Architecture

The worker is built with:

- **TypeScript**: For type safety and better development experience
- **Cloudflare Workers**: Serverless edge computing platform
- **Cloudflare KV**: Distributed key-value storage for rate limiting and model data caching
- **gpt-tokenizer**: Accurate token counting for all supported models

## Rate Limiting Implementation

The distributed rate limiting system:

1. Keys the bucket on a hash of the API key (IP headers are the fallback)
2. Tracks both request count and token count in a 1-minute sliding window
3. Stores data in Cloudflare KV with TTL
4. Returns HTTP 429 once either budget is spent
5. Ensures consistency across all worker instances globally

The counter is a read-modify-write against KV, which has no atomic
increment, so concurrent requests for the same key can overshoot the limit
slightly.

## Token Counting

Accurate token counting is implemented using the `gpt-tokenizer` library, which provides good approximations for all supported models including GPT, Claude, Mistral, and others. A character-based fallback is used if tokenization fails.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests — `npm test` must pass and coverage must stay at or above 80%
   (`npm run test:coverage`)
5. Run `npm run format` and `npm run check`
6. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:

- Create an issue in the repository
- Check the Cloudflare Workers documentation
- Review the 1min.ai API documentation
