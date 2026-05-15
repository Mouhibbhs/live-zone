export const HLS_MIME_TYPE = "application/vnd.apple.mpegurl";

const IPTV_PROXY_URL = process.env.NEXT_PUBLIC_IPTV_PROXY_URL?.trim().replace(/\/$/, "") || "";

const XTREAM_LIVE_STREAM_PATTERN =
  /^(https?:\/\/.+\/live\/[^/]+\/[^/]+\/[^/.?]+)(?:\.(?:m3u8|ts|m2ts|flv))?(\?.*)?$/i;

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function normalizeConfiguredProxyBase(proxyUrl: string): string {
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

  const localProxy3000 = isLocal ? "http://localhost:3000" : "";
  const localProxy8787 = isLocal ? "http://localhost:8787/proxy" : "";
  const standardProxy = `${origin}/api/proxy`;
  const netlifyFunctionProxy = host.endsWith(".netlify.app") ? `${origin}/.netlify/functions/proxy` : "";

  return [
    configuredProxy,
    localProxy3000,
    localProxy8787,
    standardProxy,
    netlifyFunctionProxy
  ].filter(Boolean);
}

export function getIptvProxyBase(): string {
  return getIptvProxyBases()[0] ?? "";
}

/**
 * Get MPEG-TS proxy URL for streaming
 * Always returns .ts format for mpegts.js player
 */
export function getMpegtsProxyUrl(streamUrl: string): string {
  const trimmed = streamUrl.trim();
  if (!trimmed) return "";

  // If already proxied, return as-is
  if (trimmed.includes('?url=')) {
    return trimmed;
  }

  const match = trimmed.match(XTREAM_LIVE_STREAM_PATTERN);
  const directUrl = match ? `${match[1]}.ts${match[2] ?? ""}` : trimmed;
  
  const proxyBase = getIptvProxyBase();
  if (proxyBase) {
    return `${proxyBase}?url=${encodeURIComponent(directUrl)}`;
  }

  return directUrl;
}

export function normalizeLiveStreamUrl(streamUrl: string, ext: "ts" | "m3u8" = "ts"): string {
  const trimmed = streamUrl.trim();
  if (!trimmed) return "";

  if (trimmed.includes('?url=')) {
    return trimmed;
  }

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
