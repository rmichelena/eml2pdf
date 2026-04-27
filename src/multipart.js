import Busboy from 'busboy';

export function parseMultipart(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: maxBytes, files: 1, fields: 20, fieldSize: 1 * 1024 * 1024 },
    });
    const result = { emlBuf: null, messageId: null, options: {} };
    let totalBytes = 0;
    let settled = false;

    const safeReject = (e) => {
      if (settled) return;
      settled = true;
      try { req.unpipe(bb); } catch { /* ignore */ }
      try { req.destroy(); } catch { /* ignore */ }
      reject(e);
    };
    const safeResolve = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    bb.on('file', (name, stream, info) => {
      if (name !== 'file') { stream.resume(); return; }
      const chunks = [];
      stream.on('limit', () => {
        safeReject(Object.assign(new Error('Request too large'), { status: 413 }));
      });
      stream.on('data', (c) => {
        if (settled) return;
        totalBytes += c.length;
        if (totalBytes > maxBytes) {
          safeReject(Object.assign(new Error('Request too large'), { status: 413 }));
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => {
        if (settled) return;
        result.emlBuf = Buffer.concat(chunks);
      });
      stream.on('error', safeReject);
    });

    bb.on('field', (name, val) => {
      if (settled) return;
      if (name === 'messageId') result.messageId = val;
      if (name === 'options') {
        try { result.options = JSON.parse(val); }
        catch { /* ignore */ }
      }
    });

    bb.on('finish', () => {
      if (settled) return;
      if (!result.emlBuf) {
        safeReject(Object.assign(new Error('No file field in multipart'), { status: 400 }));
      } else {
        safeResolve(result);
      }
    });

    bb.on('error', safeReject);
    req.on('aborted', () => safeReject(Object.assign(new Error('Request aborted'), { status: 400 })));
    req.pipe(bb);
  });
}
