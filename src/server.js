import http from 'node:http';
import { convertEmail } from './convert.js';
import { parseMultipart } from './multipart.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_REQUEST_MB = parseInt(process.env.MAX_REQUEST_MB || '50', 10);
const MAX_REQUEST_BYTES = MAX_REQUEST_MB * 1024 * 1024;
const DEFAULT_WIDTH_PX = parseInt(process.env.DEFAULT_WIDTH_PX || '900', 10);
const DEFAULT_MAX_HEIGHT_PX = parseInt(process.env.DEFAULT_MAX_HEIGHT_PX || '30000', 10);
const LOAD_REMOTE_IMAGES = process.env.LOAD_REMOTE_IMAGES === 'true';
const CONVERSION_TIMEOUT_MS = parseInt(process.env.CONVERSION_TIMEOUT_MS || '60000', 10);
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'UTC';

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  if (req.method === 'POST' && req.url === '/convert') {
    return handleConvert(req, res);
  }

  res.writeHead(404);
  res.end('Not found');
});

async function handleConvert(req, res) {
  const contentType = req.headers['content-type'] || '';
  let emlBuf, messageId, options;

  try {
    if (contentType.includes('multipart/form-data')) {
      ({ emlBuf, messageId, options } = await parseMultipart(req, MAX_REQUEST_BYTES));
    } else {
      // JSON body
      const body = await readJsonBody(req, MAX_REQUEST_BYTES);
      if (!body.rawBase64Url && !body.emlBase64) {
        return jsonError(res, 400, 'Provide rawBase64Url (Gmail) or emlBase64, or use multipart with file field');
      }
      messageId = body.messageId || undefined;
      options = body.options || {};
      if (body.rawBase64Url) {
        emlBuf = decodeBase64Url(body.rawBase64Url);
      } else {
        emlBuf = Buffer.from(body.emlBase64, 'base64');
      }
    }

    const opts = {
      widthPx: options?.widthPx || DEFAULT_WIDTH_PX,
      maxHeightPx: options?.maxHeightPx || DEFAULT_MAX_HEIGHT_PX,
      loadRemoteImages: options?.loadRemoteImages ?? LOAD_REMOTE_IMAGES,
      timeout: options?.timeout || CONVERSION_TIMEOUT_MS,
      timezone: options?.timezone || DEFAULT_TIMEZONE,
    };

    const result = await convertEmail(emlBuf, { messageId, ...opts });

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="result.zip"',
    });
    res.end(result.zipBuffer);
  } catch (err) {
    console.error('[convert error]', err.message);
    const status = err.status || 500;
    jsonError(res, status, err.message);
  }
}

function decodeBase64Url(raw) {
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function jsonError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

server.listen(PORT, () => {
  console.log(`mail-to-pdf listening on :${PORT} (max ${MAX_REQUEST_MB}MB)`);
});
