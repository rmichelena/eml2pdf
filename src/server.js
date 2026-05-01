import http from 'node:http';
import crypto from 'node:crypto';
import { convertEmail, shutdownBrowser } from './convert.js';
import { parseMultipart } from './multipart.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_REQUEST_MB = parseInt(process.env.MAX_REQUEST_MB || '50', 10);
const MAX_REQUEST_BYTES = MAX_REQUEST_MB * 1024 * 1024;
const DEFAULT_WIDTH_PX = parseInt(process.env.DEFAULT_WIDTH_PX || '900', 10);
const DEFAULT_MAX_HEIGHT_PX = parseInt(process.env.DEFAULT_MAX_HEIGHT_PX || '30000', 10);
const LOAD_REMOTE_IMAGES = process.env.LOAD_REMOTE_IMAGES === 'true';
const CONVERSION_TIMEOUT_MS = parseInt(process.env.CONVERSION_TIMEOUT_MS || '60000', 10);
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'UTC';
const MAX_CONCURRENT_RENDERS = parseInt(process.env.MAX_CONCURRENT_RENDERS || '5', 10);
const MAX_QUEUED_EML_MB = parseInt(process.env.MAX_QUEUED_EML_MB || '500', 10);
const MAX_QUEUED_EML_BYTES = MAX_QUEUED_EML_MB * 1024 * 1024;
const MAX_QUEUE_WAIT_MS = parseInt(process.env.MAX_QUEUE_WAIT_MS || '180000', 10);
const API_KEY = process.env.API_KEY || '';

// Bounds for client-supplied options (DoS protection)
const WIDTH_MIN = 200, WIDTH_MAX = 2400;
const HEIGHT_MIN = 200, HEIGHT_MAX = 200_000;
const TIMEOUT_MIN = 1_000, TIMEOUT_MAX = 5 * 60_000;

const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : def;
};

// Render-slot semaphore with byte-bounded backlog.
// We hold the eml buffer in memory while queued, so bound the total queued bytes,
// not just the slot count. Requests that fit in the queue wait (good for n8n);
// requests that don't get an immediate 503 + Retry-After.
let inFlight = 0;
let queuedBytes = 0;
const queue = [];

function acquire(bytes) {
  if (inFlight < MAX_CONCURRENT_RENDERS) {
    inFlight++;
    return Promise.resolve();
  }

  if (queuedBytes + bytes > MAX_QUEUED_EML_BYTES) {
    return Promise.reject(Object.assign(new Error('Conversion queue full'), {
      status: 503,
      retryAfter: 10,
    }));
  }

  queuedBytes += bytes;

  return new Promise((resolve, reject) => {
    const item = { bytes, resolve, reject, timer: null };

    item.timer = setTimeout(() => {
      const idx = queue.indexOf(item);
      if (idx !== -1) {
        queue.splice(idx, 1);
        queuedBytes -= bytes;
      }
      reject(Object.assign(new Error('Conversion queue timeout'), {
        status: 503,
        retryAfter: 10,
      }));
    }, MAX_QUEUE_WAIT_MS);

    queue.push(item);
  });
}

function release() {
  inFlight = Math.max(0, inFlight - 1);

  const next = queue.shift();
  if (next) {
    clearTimeout(next.timer);
    queuedBytes -= next.bytes;
    inFlight++;
    next.resolve();
  }
}

export function _queueStateForTests() {
  return { inFlight, queuedBytes, queueLength: queue.length };
}

function checkAuth(req) {
  if (!API_KEY) return true;
  const supplied = req.headers['x-api-key'] || '';
  if (typeof supplied !== 'string' || supplied.length !== API_KEY.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(API_KEY));
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  if (req.method === 'POST' && req.url === '/convert') {
    if (!checkAuth(req)) {
      return jsonError(res, 401, 'Unauthorized');
    }
    return handleConvert(req, res, requestId);
  }

  res.writeHead(404);
  res.end('Not found');
});

// Hardening against slow-loris and stuck connections
server.headersTimeout = 30_000;
server.requestTimeout = 5 * 60_000;
server.keepAliveTimeout = 5_000;

async function handleConvert(req, res, requestId) {
  const started = Date.now();
  let acquired = false;
  let emlBuf, messageId, options;

  try {
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
      ({ emlBuf, messageId, options } = await parseMultipart(req, MAX_REQUEST_BYTES));
    } else {
      const body = await readJsonBody(req, MAX_REQUEST_BYTES);
      if (!body.rawBase64Url && !body.emlBase64) {
        return jsonError(res, 400, 'Provide rawBase64Url (Gmail) or emlBase64, or use multipart with file field');
      }
      messageId = body.messageId || undefined;
      options = body.options || {};
      try {
        emlBuf = body.rawBase64Url
          ? decodeBase64Url(body.rawBase64Url)
          : decodeBase64Strict(body.emlBase64);
      } catch (e) {
        return jsonError(res, 400, 'Invalid base64 payload');
      }
    }

    if (typeof messageId === 'string') {
      messageId = messageId.replace(/[\x00-\x1f]/g, '').slice(0, 998);
    }

    // Env acts as a ceiling: client cannot ELEVATE remote-image loading above
    // the operator setting. Track WHY remote was disabled so the warning we
    // emit later is actionable (env vs client choice).
    const clientWantsRemote = options?.loadRemoteImages !== false;
    const loadRemoteImages = LOAD_REMOTE_IMAGES && clientWantsRemote;
    const remoteDisabledReason = loadRemoteImages
      ? null
      : (!LOAD_REMOTE_IMAGES ? 'env' : 'client');

    // outputs: array of formats to produce. Default ['pdf'] for backward
    // compatibility. Validate here (not just in convertEmail) so we know
    // upfront whether we need a render slot — markdown-only conversions
    // skip Chromium and therefore don't need to wait in the render queue.
    const ALLOWED_OUTPUTS = new Set(['pdf', 'markdown']);
    let requestedOutputs = ['pdf'];
    if (options?.outputs !== undefined) {
      if (!Array.isArray(options.outputs)) {
        return jsonError(res, 400, 'options.outputs must be an array of strings ("pdf", "markdown")');
      }
      if (options.outputs.length === 0) {
        return jsonError(res, 400, 'options.outputs cannot be empty');
      }
      const normalized = [...new Set(options.outputs.map(s => String(s).toLowerCase()))];
      for (const o of normalized) {
        if (!ALLOWED_OUTPUTS.has(o)) {
          return jsonError(res, 400, `Invalid output format "${o}". Allowed: pdf, markdown`);
        }
      }
      requestedOutputs = normalized;
    }
    const needsRenderSlot = requestedOutputs.includes('pdf');

    const opts = {
      widthPx: clamp(options?.widthPx, WIDTH_MIN, WIDTH_MAX, DEFAULT_WIDTH_PX),
      maxHeightPx: clamp(options?.maxHeightPx, HEIGHT_MIN, HEIGHT_MAX, DEFAULT_MAX_HEIGHT_PX),
      loadRemoteImages,
      remoteDisabledReason,
      timeout: clamp(options?.timeout, TIMEOUT_MIN, TIMEOUT_MAX, CONVERSION_TIMEOUT_MS),
      timezone: typeof options?.timezone === 'string' ? options.timezone : DEFAULT_TIMEZONE,
      outputs: requestedOutputs,
    };

    // Only acquire the render-slot semaphore for conversions that actually
    // need Chromium. Markdown-only is parse + sanitize + turndown — light
    // CPU work that shouldn't queue behind heavyweight PDF renders.
    if (needsRenderSlot) {
      await acquire(emlBuf.length);
      acquired = true;
    }

    const result = await convertEmail(emlBuf, { messageId, ...opts });

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="result.zip"',
    });
    res.end(result.zipBuffer);

    console.log(JSON.stringify({
      level: 'info', requestId,
      durationMs: Date.now() - started,
      emlBytes: emlBuf?.length || 0,
      zipBytes: result.zipBuffer?.length || 0,
      attachments: result.metadata?.attachments?.length || 0,
      warnings: result.metadata?.warnings?.length || 0,
    }));
  } catch (err) {
    const status = err.status || 500;
    // Backpressure errors (queue full / queue timeout) keep their original message —
    // it's useful for the client to know why it got 503.
    const isBackpressure = status === 503 && err.retryAfter;
    const clientMsg = (status >= 500 && !isBackpressure) ? 'Internal error' : err.message;
    console.error(JSON.stringify({
      level: 'error', requestId,
      durationMs: Date.now() - started,
      status,
      error: err.message,
      queuedBytes,
      inFlight,
    }));
    if (!res.headersSent) {
      if (err.retryAfter) {
        res.setHeader('Retry-After', String(err.retryAfter));
        res.setHeader('X-Queue-Limit-MB', String(MAX_QUEUED_EML_MB));
        res.setHeader('X-Queued-Bytes', String(queuedBytes));
        res.setHeader('X-In-Flight-Renders', String(inFlight));
      }
      jsonError(res, status, clientMsg);
    }
  } finally {
    if (acquired) release();
  }
}

function decodeBase64Url(raw) {
  if (typeof raw !== 'string') throw new Error('rawBase64Url must be string');
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  return decodeBase64Strict(normalized);
}

function decodeBase64Strict(s) {
  if (typeof s !== 'string') throw new Error('emlBase64 must be string');
  // Strip whitespace; reject anything that isn't base64
  const trimmed = s.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*=*$/.test(trimmed)) throw new Error('Invalid base64');
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length === 0) throw new Error('Empty payload');
  return buf;
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    const safeReject = (e) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      reject(e);
    };
    const safeResolve = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        safeReject(Object.assign(new Error('Request too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        safeResolve(JSON.parse(text));
      } catch {
        safeReject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', safeReject);
    req.on('aborted', () =>
      safeReject(Object.assign(new Error('Request aborted'), { status: 400 })));
  });
}

function jsonError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

server.listen(PORT, () => {
  console.log(`mail-to-pdf listening on :${PORT} (max ${MAX_REQUEST_MB}MB/req, concurrency ${MAX_CONCURRENT_RENDERS}, queue ${MAX_QUEUED_EML_MB}MB/${MAX_QUEUE_WAIT_MS}ms, auth ${API_KEY ? 'on' : 'off'})`);
});

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${sig}] shutting down`);
  server.close(() => { /* stop accepting */ });
  // give in-flight some time
  const deadline = Date.now() + 30_000;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }
  await shutdownBrowser();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
