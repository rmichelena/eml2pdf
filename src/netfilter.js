import dns from 'node:dns/promises';
import net from 'node:net';

// Network-policy gate for the renderer. Resolves a hostname / IP and
// reports whether it points at a private/internal/IMDS target.
//
// LIMITATIONS:
// - We do a `dns.lookup()` here, but Chromium's runtime fetch path uses
//   its own resolver. A malicious authoritative DNS server can answer
//   "good IP" to us and "bad IP" (or change between resolutions) to
//   Chromium — the classic DNS rebinding window. To close this fully you
//   need to either fetch the resource yourself with the resolved IP
//   forced, or front the renderer with an outbound proxy that pins
//   resolution. We DON'T currently do that; this filter is mitigation,
//   not enforcement. See the README "Security" section.
// - We don't follow HTTP redirects ourselves; Chromium does. Each redirect
//   hop reaches the route handler again, so a redirect to a private host
//   is also blocked at fetch time — but a Markdown-only conversion (which
//   uses the static URL filter, not the route handler) doesn't see the
//   redirect target. This is acceptable because we strip the original
//   URL whose host check already covers it.
//
// Hosts that always resolve to internal targets — block by name too,
// in case DNS is poisoned or the host file is hostile.
const HOSTNAME_DENYLIST = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
]);

// Bounded LRU-ish DNS-result cache. A single bad email could otherwise
// reference thousands of unique hosts and grow the map unbounded.
const cache = new Map(); // host → { until: ms, private: bool }
const TTL_MS = 30_000;
const MAX_DNS_CACHE_SIZE = parseInt(process.env.MAX_DNS_CACHE_SIZE || '5000', 10);

function cacheSet(host, value) {
  if (cache.size >= MAX_DNS_CACHE_SIZE) {
    // FIFO eviction — Map preserves insertion order, so the first key is
    // the oldest. Evict ~10% to amortize the cleanup cost.
    const toEvict = Math.max(1, Math.floor(MAX_DNS_CACHE_SIZE * 0.1));
    const it = cache.keys();
    for (let i = 0; i < toEvict; i++) {
      const k = it.next();
      if (k.done) break;
      cache.delete(k.value);
    }
  }
  cache.set(host, value);
}

export async function isPrivateHost(host) {
  if (!host) return true;
  const lower = host.toLowerCase();

  if (HOSTNAME_DENYLIST.has(lower)) return true;
  if (lower.endsWith('.localhost') || lower.endsWith('.local')) return true;

  // Literal IPs — check directly without DNS
  if (net.isIP(lower)) return isPrivateIp(lower);

  const cached = cache.get(lower);
  if (cached && cached.until > Date.now()) return cached.private;

  let addrs;
  try {
    addrs = await dns.lookup(lower, { all: true, verbatim: true });
  } catch {
    cacheSet(lower, { until: Date.now() + TTL_MS, private: true });
    return true; // fail closed
  }

  // If ANY resolved address is private, treat the host as private.
  // This is conservative but defeats DNS rebinding/multi-A tricks.
  const isPriv = addrs.some(a => isPrivateIp(a.address));
  cacheSet(lower, { until: Date.now() + TTL_MS, private: isPriv });
  return isPriv;
}

export function isPrivateIp(ip) {
  if (!ip) return true;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4)
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return isPrivateIp4(mapped[1]);

  if (net.isIPv4(ip)) return isPrivateIp4(ip);
  if (net.isIPv6(ip)) return isPrivateIp6(ip);
  return true;
}

function isPrivateIp4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local (AWS/Azure/GCP IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
  if (a === 192 && b === 168) return true;           // 192.168/16
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;    // benchmark
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true;  // TEST-NET-3
  if (a >= 224) return true;                         // multicast + reserved + 255.255.255.255
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIp6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // Link-local is the entire fe80::/10 range, not just fe80::/16. The first
  // 10 bits are 1111 1110 10, so the first hextet covers fe80–febf.
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;                         // ULA fc00::/7
  if (lower.startsWith('ff')) return true;                                    // multicast
  if (lower.startsWith('64:ff9b::')) return true;                             // NAT64
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    if (net.isIPv4(v4)) return isPrivateIp4(v4);
  }
  return false;
}
