# eml2pdf

Dockerized microservice that converts Gmail raw or `.eml` emails to a ZIP containing one or both of:

- a long-page **PDF** rendering (Chromium headless), and/or
- an **LLM-friendly Markdown** rendering with inline images as `data:` URLs

plus **metadata.json** and extracted **attachments**.

Designed for [n8n](https://n8n.io) HTTP Request nodes.

## Quick Start

```bash
docker compose up -d --build
```

Service listens on **http://localhost:3005**.

## API

### `POST /convert`

#### JSON body (Gmail raw)

```bash
curl -X POST http://localhost:3005/convert \
  -H 'Content-Type: application/json' \
  -d '{
    "rawBase64Url": "RnJvbTog...",
    "messageId": "msg123",
    "options": {
      "widthPx": 900,
      "maxHeightPx": 30000,
      "loadRemoteImages": false,
      "timezone": "Europe/Berlin"
    }
  }' \
  --output result.zip
```

#### Multipart (EML file)

```bash
curl -X POST http://localhost:3005/convert \
  -F "file=@email.eml" \
  -F 'options={"timezone":"Europe/Berlin"}' \
  --output result.zip
```

#### Markdown for LLM consumption

```bash
curl -X POST http://localhost:3005/convert \
  -H 'Content-Type: application/json' \
  -d '{
    "rawBase64Url": "RnJvbTog...",
    "options": {
      "outputs": ["markdown"],
      "timezone": "Europe/Berlin"
    }
  }' \
  --output result.zip
```

### Response: `result.zip`

Contents depend on `options.outputs` (defaults to `["pdf"]`). Both PDF and
Markdown share a date-prefixed base name so a downstream pipeline can pair
them by filename stem.

`outputs: ["pdf"]` (default — back-compat with v1.0):

```
result.zip
├── 2025-01-15 10-30 email.pdf     # Long-page PDF rendering
├── 2025-01-15 10-30 email.json    # Structured email metadata
└── attachments/
    ├── contract.pdf
    └── photo.jpg
```

`outputs: ["markdown"]` (LLM consumption only — no Chromium render):

```
result.zip
├── 2025-01-15 10-30 email.md      # Markdown with inline data: image URLs
├── 2025-01-15 10-30 email.json
└── attachments/...
```

`outputs: ["pdf", "markdown"]` (both):

```
result.zip
├── 2025-01-15 10-30 email.pdf
├── 2025-01-15 10-30 email.md
├── 2025-01-15 10-30 email.json
└── attachments/...
```

> Filenames use the email's date formatted in the requested timezone. Stem format: `yyyy-mm-dd HH-MM email`.

### Markdown output

The `.md` file is designed for LLM consumption:

- Email metadata (subject / from / to / cc / date / message-id) is emitted
  as **YAML frontmatter** (`---`-delimited) so attacker-controlled fields
  can't inject Markdown structure into the document. Subject also appears
  as an escaped H1.
- Body is converted from sanitized HTML via [turndown](https://github.com/mixmark-io/turndown) + GFM.
- **Inline images become `![alt](data:image/...;base64,...)`** — vision-capable LLMs (Claude, GPT-4o, etc.) consume those natively.
- HTML tables become GFM tables; lists, links, bold/italic preserved.
- Remote URLs in the body honor the same policy as the PDF (`LOAD_REMOTE_IMAGES`
  env + per-host private/loopback/IMDS filter). Blocked URLs are stripped
  from `src=`/`background=`/`href=`/`url(...)` so the `.md` doesn't leak
  tracking pixels or SSRF-style URLs to the LLM consumer.
- Attachments listed by filename + content type + size in their own section (their bytes are still in `attachments/`).
- Conversion warnings (unresolved CIDs, stripped remote hosts, etc.) listed at the end.

### Performance note: markdown-only is cheap

Conversions with `outputs: ["markdown"]` (only) **skip Chromium entirely**.
They don't take a render-slot from the `MAX_CONCURRENT_RENDERS` semaphore
and don't queue against PDF requests under load. Only PDF conversions are
gated by the render queue.

### `GET /health`

```json
{"status":"ok"}
```

## Request Options

| Option | Default | Description |
|---|---|---|
| `outputs` | `["pdf"]` | Array. Subset of `["pdf", "markdown"]`. At least one required. Picking only `markdown` skips the Chromium render entirely. |
| `widthPx` | `900` | PDF width in pixels (ignored if PDF not requested) |
| `maxHeightPx` | `30000` | Max PDF height; taller emails get truncated + warning |
| `loadRemoteImages` | `LOAD_REMOTE_IMAGES` env | Allow loading external images. The env var is a **ceiling**: a request can opt out (`false`), but cannot opt in if the operator disabled it via env. |
| `timezone` | `UTC` | IANA timezone for date display in PDF header and filenames |
| `timeout` | `60000` | Per-conversion timeout in ms |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port (inside container) |
| `MAX_REQUEST_MB` | `50` | Max request body size in MB |
| `DEFAULT_WIDTH_PX` | `900` | Default PDF width |
| `DEFAULT_MAX_HEIGHT_PX` | `30000` | Default max PDF height |
| `LOAD_REMOTE_IMAGES` | `true` (in compose) / `false` (Dockerfile baseline) | Operator ceiling for remote image loading. When `true`, public-internet images load; private/loopback/IMDS hosts are still blocked at the network filter. When `false`, no http(s) request leaves the renderer. |
| `DEFAULT_TIMEZONE` | `UTC` | Default timezone for dates |
| `CONVERSION_TIMEOUT_MS` | `60000` | Default per-conversion timeout |
| `MAX_CONCURRENT_RENDERS` | `5` | Max simultaneous Chromium renders |
| `MAX_QUEUED_EML_MB` | `500` | Total bytes of queued (waiting) emails before returning 503 |
| `MAX_QUEUE_WAIT_MS` | `180000` | Max time a queued request waits for a render slot before 503 |
| `API_KEY` | _(empty)_ | If set, require this value in `X-API-Key` header |

## Backpressure

Renders run with a configurable concurrency limit. Excess requests wait in a
FIFO queue bounded by **bytes of queued payload** (not just count) so the
process memory footprint stays predictable.

- If the new request fits within `MAX_QUEUED_EML_MB`, it waits up to
  `MAX_QUEUE_WAIT_MS` for a slot. Good fit for n8n's HTTP Request retry semantics.
- If the queue is full, or if the wait deadline passes, the server returns
  **503** with `Retry-After: 10` and observability headers:
  - `X-Queue-Limit-MB`
  - `X-Queued-Bytes`
  - `X-In-Flight-Renders`

503 is meant to be exceptional. Tune `MAX_CONCURRENT_RENDERS` and
`MAX_QUEUED_EML_MB` so the steady state is "always queue, rarely reject".

### Measured behavior

100 concurrent conversions of ~2 MB synthetic emails against the default
config (`MAX_CONCURRENT_RENDERS=5`, `MAX_QUEUED_EML_MB=500`):

| Metric | Value |
|---|---|
| Wall time | ~15 s |
| CPU peak | ~200 % (2 cores) |
| RAM peak | ~553 MB |
| 503 responses | 0 |

Reproduce with [`test/load.js`](test/load.js):

```bash
docker compose up -d --build
BASE_URL=http://127.0.0.1:3005 N=100 SIZE_MB=2 node test/load.js
# in another terminal:
docker stats eml2pdf
```

## metadata.json

```json
{
  "messageId": "<abc@example.com>",
  "subject": "Quarterly Report",
  "from": "Alice <alice@example.com>",
  "to": ["Bob <bob@example.com>"],
  "cc": [],
  "date": "2025-01-15T08:30:00.000Z",
  "timezone": "Europe/Berlin",
  "inlineImagesResolved": 2,
  "attachments": [
    {
      "filename": "report.pdf",
      "contentType": "application/pdf",
      "size": 12345,
      "inline": false
    }
  ],
  "warnings": []
}
```

## n8n Integration

### Real-time (Gmail Trigger)

```
Gmail Trigger (new message)
  → Gmail → Get Message (format: RAW)
  → HTTP Request → POST http://eml2pdf:3000/convert
     Body: { rawBase64Url: "{{$json.raw}}", messageId: "{{$json.id}}", options: { timezone: "Europe/Berlin" } }
     Response Format: File
  → Extract File (unzip)
  → Google Drive → Upload File (PDF)
  → Google Drive → Upload Files (attachments/*)
  → Gmail → Add Label: processed-to-drive
```

### Batch (retroactive)

```
Gmail → Search Messages
  → For Each:
    → Same sub-workflow as above
```

> **Tip:** Set the HTTP Request response format to **File** to get the ZIP as binary, then use the **Extract File** node to split into individual files.

## How It Works

1. **Decode** — Gmail `rawBase64Url` → RFC 2822 MIME, or accept `.eml` directly
2. **Parse** — `mailparser` extracts headers, HTML body, inline images, attachments
3. **Inline images** — `cid:` references resolved to data URLs and embedded in HTML
4. **Render** — Playwright (Chromium headless) renders HTML to a single long-page PDF (no A4)
5. **Extract** — Non-inline attachments saved separately
6. **Timezone** — Dates in PDF header and filenames use the requested IANA timezone
7. **ZIP** — Everything packaged with timezone-aware filenames

## Security

- Configurable request size limit (default 50 MB)
- Per-conversion timeout (default 60s)
- HTML sanitized (no scripts/iframes/forms/object/embed/meta-refresh; pagination CSS stripped)
- JS disabled in the rendering BrowserContext
- Permissive CSP injected for the Chromium render
- Remote resources gated by `LOAD_REMOTE_IMAGES` env var (acts as a ceiling).
  When `true` (the compose default), the renderer will issue HTTP(S)
  requests to public hosts — **including any tracking pixels and
  beacons in the email**. The container's IP / TLS fingerprint will
  appear in those requests. Set to `false` (or run behind an outbound
  proxy you control) if that's a concern.
- Static URL filter applied to both PDF and Markdown output, with two
  separate policies:
  - **Auto-fetched** URLs (`src=`, `background=`, `srcset`, CSS `url(...)`)
    are gated by `LOAD_REMOTE_IMAGES` *and* host privacy. Stripped when
    blocked.
  - **Navigated** URLs (`href=`) are not auto-fetched, only clickable. They
    are kept regardless of `LOAD_REMOTE_IMAGES`, but private/loopback/IMDS
    hosts are always stripped (an LLM agent or recipient mailer may pre-
    fetch the URL — SSRF-adjacent).
- Bound queue (bytes-of-payload) with 503 + Retry-After when full
- Filenames sanitized
- Container runs as `pwuser`, `cap_drop: ALL`, `no-new-privileges`
- Logs without sensitive email content (only request id, sizes, durations)

### `API_KEY` authentication

If set, every `POST /convert` must carry an `X-API-Key: <value>` header
matching the env var (compared with `crypto.timingSafeEqual`). When unset,
`/convert` is open — only safe behind a trusted reverse proxy or on a
private Docker network.

Operational notes:

- **Use ≥32 random bytes** (e.g. `openssl rand -hex 32` or `head -c32
  /dev/urandom | base64`). Short or guessable keys defeat the protection.
- **Always run behind TLS** (reverse proxy or load balancer) when exposed
  beyond loopback. The default compose file binds `127.0.0.1:3005` only
  for that reason — moving to a public bind is opt-in and should be paired
  with TLS + this header.
- The key is logged on **invalid attempts** only as a 401, never with the
  attempted value. Don't echo `X-API-Key` in upstream debug logs.
- Rotate via env var update + restart; in-flight requests with the old key
  finish before the process exits.

## License

MIT
