import dns from 'node:dns/promises';
import net from 'node:net';

// Hosts that always resolve to internal targets — block by name too,
// in case DNS is poisoned or the host file is hostile.
const HOSTNAME_DENYLIST = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
]);

const cache = new Map(); // host → { until: ms, private: bool }
const TTL_MS = 30_000;

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
    cache.set(lower, { until: Date.now() + TTL_MS, private: true });
    return true; // fail closed
  }

  // If ANY resolved address is private, treat the host as private.
  // This is conservative but defeats DNS rebinding/multi-A tricks.
  const isPriv = addrs.some(a => isPrivateIp(a.address));
  cache.set(lower, { until: Date.now() + TTL_MS, private: isPriv });
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
  if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;                         // ULA fc00::/7
  if (lower.startsWith('ff')) return true;                                    // multicast
  if (lower.startsWith('64:ff9b::')) return true;                             // NAT64
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    if (net.isIPv4(v4)) return isPrivateIp4(v4);
  }
  return false;
}
