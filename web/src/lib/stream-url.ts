export const HLS_MIME_TYPE = "application/vnd.apple.mpegurl";

const IPTV_PROXY_URL = normalizeConfiguredProxyBase(process.env.NEXT_PUBLIC_IPTV_PROXY_URL || "");
const LIVEZONE_PROXY_BASE = normalizeConfiguredProxyBase("https://live-zone.onrender.com");

const XTREAM_LIVE_STREAM_PATTERN =
  /^(https?:\/\/.+\/live\/[^/]+\/[^/]+\/[^/.?]+)(?:\.(?:m3u8|ts|m2ts|flv))?(\?.*)?$/i;

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function getProductionProxyBase(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return `${window.location.origin}/api/proxy`;
}

function normalizeConfiguredProxyBase(proxyUrl: string): string {
  const normalized = proxyUrl.trim().replace(/\/$/, "");

  if (!normalized) {
    return "";
  }

  if (
    normalized.endsWith("/proxy") ||
    normalized.endsWith("/api/proxy") ||
    normalized.endsWith("/.netlify/functions/proxy")
  ) {
    return normalized;
  }

  return `${normalized}/proxy`;
}

export function proxy(url: string): string {
  const proxyBase = getIptvProxyBase() || LIVEZONE_PROXY_BASE;
  return `${proxyBase}?url=${encodeURIComponent(url)}`;
}

export function getFinalUrl(url: string): string {
  if (url.startsWith("http://")) {
    return proxy(url);
  }

  return url;
}

function unwrapProxyUrl(streamUrl: string): string {
  try {
    const parsed = new URL(streamUrl);
    return parsed.searchParams.get("url") || streamUrl;
  } catch {
    return streamUrl;
  }
}

export function buildXtreamDirectUrl(streamUrl: string, ext: "m3u8" | "ts"): string {
  const trimmed = unwrapProxyUrl(streamUrl.trim());
  const match = trimmed.match(XTREAM_LIVE_STREAM_PATTERN);

  if (!match) {
    return trimmed;
  }

  return `${match[1]}.${ext}${match[2] ?? ""}`;
}

export function getClapprSourceUrl(streamUrl: string): string {
  const directHls = buildXtreamDirectUrl(streamUrl, "m3u8");
  return getFinalUrl(directHls);
}

export function getClapprSourceCandidates(streamUrl: string): string[] {
  const directHls = buildXtreamDirectUrl(streamUrl, "m3u8");
  const proxiedSources = getIptvProxyBases().map(
    (proxyBase) => `${proxyBase}?url=${encodeURIComponent(directHls)}`,
  );
  const directSources =
    typeof window !== "undefined" && isLocalHost(window.location.hostname) ? [directHls] : [];

  return [...proxiedSources, ...directSources].filter(
    (value, index, items) => value && items.indexOf(value) === index,
  );
}

export function getIptvProxyBases(): string[] {
  if (typeof window === "undefined") {
    return [IPTV_PROXY_URL, LIVEZONE_PROXY_BASE].filter(Boolean);
  }

  const host = window.location.hostname;

  if (isLocalHost(host)) {
    return ["http://localhost:8787/proxy", IPTV_PROXY_URL, LIVEZONE_PROXY_BASE].filter(Boolean);
  }

  const bases = [
    IPTV_PROXY_URL,
    getProductionProxyBase(),
    `${window.location.origin}/.netlify/functions/proxy`,
    LIVEZONE_PROXY_BASE,
  ];

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
