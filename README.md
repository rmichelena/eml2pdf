# eml2pdf

Dockerized microservice that converts Gmail raw or `.eml` emails to a ZIP containing **PDF**, **metadata.json**, and extracted **attachments**.

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

### Response: `result.zip`

```
result.zip
├── 2025-01-15 10-30 email.pdf     # Long-page PDF rendering (date from email, timezone-aware)
├── 2025-01-15 10-30 email.json    # Structured email metadata
└── attachments/
    ├── contract.pdf
    └── photo.jpg
```

> Filenames use the email's date formatted in the requested timezone. Format: `yyyy-mm-dd HH-MM email.pdf`

### `GET /health`

```json
{"status":"ok"}
```

## Request Options

| Option | Default | Description |
|---|---|---|
| `widthPx` | `900` | PDF width in pixels |
| `maxHeightPx` | `30000` | Max PDF height; taller emails get truncated + warning |
| `loadRemoteImages` | `false` | Allow loading external images over the network |
| `timezone` | `UTC` | IANA timezone for date display in PDF header and filenames |
| `timeout` | `60000` | Per-conversion timeout in ms |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port (inside container) |
| `MAX_REQUEST_MB` | `50` | Max request body size in MB |
| `DEFAULT_WIDTH_PX` | `900` | Default PDF width |
| `DEFAULT_MAX_HEIGHT_PX` | `30000` | Default max PDF height |
| `LOAD_REMOTE_IMAGES` | `false` | Allow loading remote images by default |
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
- Remote resources blocked by default
- Filenames sanitized
- No unnecessary external JavaScript execution
- Logs without sensitive email content

## License

MIT
