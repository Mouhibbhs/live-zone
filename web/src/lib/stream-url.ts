export const HLS_MIME_TYPE = "application/vnd.apple.mpegurl";

const IPTV_PROXY_URL = process.env.NEXT_PUBLIC_IPTV_PROXY_URL?.trim().replace(/\/$/, "") || "";

const XTREAM_LIVE_STREAM_PATTERN =
  /^(https?:\/\/.+\/live\/[^/]+\/[^/]+\/[^/.?]+)(?:\.(?:m3u8|ts|m2ts|flv))?(\?.*)?$/i;

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function getProductionProxyBase(): string {
  if (typeof window === "undefined") {
    return "";
  }

  // When deployed on Netlify, use the Netlify function proxy path.
  // Netlify functions are accessible under `/.netlify/functions/<function-name>`.
  // The original server proxy was mounted at `/api/proxy` in the Next.js app.
  // Netlify creates a function named `proxy` that mirrors this endpoint.
  // Detect Netlify deployment via the hostname pattern (ends with `.netlify.app`).
  const host = window.location.hostname;
  if (host.endsWith(".netlify.app")) {
    return `${window.location.origin}/.netlify/functions/proxy`;
  }

  // Default to the Next.js API route when not on Netlify.
  return `${window.location.origin}/api/proxy`;
}

function normalizeConfiguredProxyBase(proxyUrl: string): string {
  // Ensure the URL ends with /proxy so the proxy endpoint is used correctly
  return proxyUrl.replace(/\/+$/,'').replace(/(\/proxy)?$/,'/proxy');
}

export function getIptvProxyBases(): string[] {
  if (typeof window === "undefined") {
    // Server‑side: only use the configured proxy URL if present.
    return IPTV_PROXY_URL ? [normalizeConfiguredProxyBase(IPTV_PROXY_URL)] : [];
  }

  const host = window.location.hostname;

  const bases: string[] = [];

  // Netlify deployment – use the Netlify function proxy.
  if (host.endsWith('.netlify.app')) {
    const netlifyProxy = getProductionProxyBase();
    if (netlifyProxy) bases.push(netlifyProxy);
  }

  // Always include the Next.js API proxy as a fallback.
  const nextJsProxy = `${window.location.origin}/api/proxy`;
  if (nextJsProxy) bases.push(nextJsProxy);

  // Remove duplicates and empty entries.
  return bases.filter((base, index, array) => base && array.indexOf(base) === index);
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
  return streamUrl.split("?")[0].trim().toLowerCase().endsWith(".m3u8");
}

export function isMpegTsUrl(streamUrl: string): boolean {
  return streamUrl.split("?")[0].trim().toLowerCase().endsWith(".ts");
}
