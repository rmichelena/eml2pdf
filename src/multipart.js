import Busboy from 'busboy';

export function parseMultipart(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: maxBytes },
    });
    const result = { emlBuf: null, messageId: null, options: {} };
    let totalBytes = 0;

    bb.on('file', (name, stream, info) => {
      if (name !== 'file') { stream.resume(); return; }
      const chunks = [];
      stream.on('data', (c) => {
        totalBytes += c.length;
        if (totalBytes > maxBytes) {
          reject(Object.assign(new Error('Request too large'), { status: 413 }));
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => {
        result.emlBuf = Buffer.concat(chunks);
      });
    });

    bb.on('field', (name, val) => {
      if (name === 'messageId') result.messageId = val;
      if (name === 'options') {
        try { result.options = JSON.parse(val); }
        catch { /* ignore */ }
      }
    });

    bb.on('finish', () => {
      if (!result.emlBuf) {
        reject(Object.assign(new Error('No file field in multipart'), { status: 400 }));
      } else {
        resolve(result);
      }
    });

    bb.on('error', reject);
    req.pipe(bb);
  });
}
