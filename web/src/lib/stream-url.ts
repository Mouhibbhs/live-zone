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

  return `${window.location.origin}/api/proxy`;
}

function normalizeConfiguredProxyBase(proxyUrl: string): string {
  return proxyUrl;
}

export function getIptvProxyBases(): string[] {
  if (typeof window === "undefined") {
    return IPTV_PROXY_URL ? [normalizeConfiguredProxyBase(IPTV_PROXY_URL)] : [];
  }

  const host = window.location.hostname;

  if (isLocalHost(host)) {
    return ["http://localhost:8787/proxy"];
  }

  const bases = [
    IPTV_PROXY_URL ? normalizeConfiguredProxyBase(IPTV_PROXY_URL) : "",
    `${window.location.origin}/api/proxy`,
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
