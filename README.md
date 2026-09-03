# 1min-relay Cloudflare Worker

![GitHub package.json version](https://img.shields.io/github/package-json/v/7a6163/1min-relay-worker)

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
- **Audio Transcription & Translation**: OpenAI Whisper-compatible speech-to-text and audio translation endpoints
- **Text to Speech**: OpenAI-compatible `/v1/audio/speech` returning audio bytes

## Supported Models

Model data is fetched dynamically from the 1min.ai API and cached with a two-tier strategy (in-memory 5 min, KV 1 hr). The `GET /v1/models` endpoint always returns the latest available models. Use it to see the full list:

```bash
curl https://your-worker.your-subdomain.workers.dev/v1/models
```

Capabilities such as vision, code interpreter, and web search are derived automatically from the API response — no hardcoded model lists.

## API Endpoints

### Chat Completions

```
POST /v1/chat/completions
```

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
- Non-text content parts (`input_image`, `input_file`, ...) are **not**
  supported on this endpoint and are rejected with a `400
  unsupported_content_type` error rather than being dropped. Use
  `/v1/chat/completions` for vision requests.
- A request whose `input` yields no non-empty message content is rejected
  with a `400 empty_input` error, instead of forwarding an empty prompt
  upstream.

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
- **Vision Support**: Same image input capabilities as Chat Completions
- **Streaming Support**: Full OpenAI-compatible SSE streaming with `response.completed` terminal event
- **Enhanced Prompting**: Automatically optimizes prompts for structured responses

### Image Generation

```
POST /v1/images/generations
```

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

Translate audio to English text. Same parameters as transcription (except `language`).

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
| `model` | string | No | TTS model ID (default `tts-1`; also `tts-1-hd`, `elevenlabs-tts`, `google-tts`, ...) |
| `voice` | string | No | Voice name (default `alloy`). Supported voices depend on the model. |
| `response_format` | string | No | `mp3` (default), `opus`, `aac`, `flac`, `wav`, `pcm` |
| `speed` | number | No | 0.25–4.0 |

### List Models

```
GET /v1/models
```

Only models the upstream reports as `ACTIVE` (and not past their deprecation
date) are listed — the models API also returns disabled entries, which are
rejected with `400 UNSUPPORTED_MODEL` if used.

### Health Check

```
GET /
```

Returns information about all available endpoints:

- Chat Completions: `/v1/chat/completions`
- Responses: `/v1/responses`
- Image Generation: `/v1/images/generations`
- Audio Transcription: `/v1/audio/transcriptions`
- Audio Translation: `/v1/audio/translations`
- Text to Speech: `/v1/audio/speech`
- Models: `/v1/models`

## Rate Limiting

The worker implements distributed rate limiting with the following limits:

- **Requests per minute**: 180 per IP address
- **Tokens per minute**: 100,000 per IP address

Rate limits are enforced using Cloudflare KV storage, ensuring consistency across all worker instances.

## Setup

### Prerequisites

- Node.js 18+
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
wrangler kv:namespace create "RATE_LIMIT_STORE"
wrangler kv:namespace create "MODEL_CACHE"
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

- `ONE_MIN_CHAT_API_URL`: 1min.ai unified chat endpoint (`/api/chat-with-ai`)
- `ONE_MIN_API_URL`: 1min.ai features endpoint for non-chat features like image generation (`/api/features`)
- `ONE_MIN_ASSET_URL`: 1min.ai asset upload endpoint
- `ONE_MIN_MODELS_API_URL`: 1min.ai models API endpoint (for dynamic model list)

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
    "model": "dall-e-3",
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

1. Uses IP address + endpoint as the key
2. Tracks both request count and token count per minute
3. Stores data in Cloudflare KV with TTL
4. Returns proper HTTP 429 responses with rate limit headers
5. Ensures consistency across all worker instances globally

## Token Counting

Accurate token counting is implemented using the `gpt-tokenizer` library, which provides good approximations for all supported models including GPT, Claude, Mistral, and others. A character-based fallback is used if tokenization fails.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:

- Create an issue in the repository
- Check the Cloudflare Workers documentation
- Review the 1min.ai API documentation
