export const HLS_MIME_TYPE = "application/vnd.apple.mpegurl";

const IPTV_PROXY_URL = process.env.NEXT_PUBLIC_IPTV_PROXY_URL?.trim().replace(/\/$/, "") || "";

const XTREAM_LIVE_STREAM_PATTERN =
  /^(https?:\/\/.+\/live\/[^/]+\/[^/]+\/[^/.?]+)(?:\.(?:m3u8|ts|m2ts|flv))?(\?.*)?$/i;

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function normalizeConfiguredProxyBase(proxyUrl: string): string {
  // Ensure the URL ends with /proxy so the proxy endpoint is used correctly
  return proxyUrl.replace(/\/+$/,'').replace(/(\/proxy)?$/,'/proxy');
}

export function getIptvProxyBases(): string[] {
  const configuredProxy = IPTV_PROXY_URL ? normalizeConfiguredProxyBase(IPTV_PROXY_URL) : "";

  if (typeof window === "undefined") {
    return configuredProxy ? [configuredProxy] : [];
  }

  const host = window.location.hostname;
  const isLocal = isLocalHost(host);
  const origin = window.location.origin;

  // 1. User-configured proxy (highest priority)
  // 2. Standard proxy path (Netlify edge function or local Next.js route)
  // 3. Local standalone proxy (for dev)
  const standardProxy = `${origin}/api/proxy`;
  const localProxy = isLocal ? "http://localhost:8787/proxy" : "";
  const netlifyFunctionProxy = host.endsWith(".netlify.app") ? `${origin}/.netlify/functions/proxy` : "";

  return [
    configuredProxy,
    standardProxy,
    localProxy,
    netlifyFunctionProxy
  ].filter(Boolean);
}

export function getIptvProxyBase(): string {
  return getIptvProxyBases()[0] ?? "";
}

export function normalizeLiveStreamUrl(streamUrl: string, ext: "ts" | "m3u8" = "ts"): string {
  const trimmed = streamUrl.trim();
  if (!trimmed) return "";

  const match = trimmed.match(XTREAM_LIVE_STREAM_PATTERN);
  if (!match) return trimmed;

  const directUrl = `${match[1]}.${ext}${match[2] ?? ""}`;
  const proxyBase = getIptvProxyBase();

  if (proxyBase) {
    return `${proxyBase}?url=${encodeURIComponent(directUrl)}`;
  }

  return directUrl;
}

export function isHlsPlaylistUrl(streamUrl: string): boolean {
  // The player may receive a proxied URL (e.g. http://site/.netlify/functions/proxy?url=...)
  // In that case we need to inspect the original `url` query parameter to determine the
  // actual media type. If the URL is not proxied we fall back to a simple extension check.
  try {
    const u = new URL(streamUrl);
    const real = u.searchParams.get('url') ?? streamUrl;
    return real.split('?')[0].trim().toLowerCase().endsWith('.m3u8');
  } catch {
    return streamUrl.split('?')[0].trim().toLowerCase().endsWith('.m3u8');
  }
}

export function isMpegTsUrl(streamUrl: string): boolean {
  return streamUrl.split("?")[0].trim().toLowerCase().endsWith(".ts");
}
