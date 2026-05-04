export const HLS_MIME_TYPE = "application/vnd.apple.mpegurl";

const IPTV_PROXY_URL = process.env.NEXT_PUBLIC_IPTV_PROXY_URL?.trim().replace(/\/$/, "") || "";

const XTREAM_LIVE_STREAM_PATTERN =
  /^(https?:\/\/.+\/live\/[^/]+\/[^/]+\/[^/.?]+)(?:\.(?:m3u8|ts|m2ts|flv))?(\?.*)?$/i;

export function getIptvProxyBase(): string {
  if (IPTV_PROXY_URL) {
    return IPTV_PROXY_URL;
  }

  if (typeof window === "undefined") {
    return "";
  }

  const host = window.location.hostname;

  if (host === "localhost" || host === "127.0.0.1") {
    return "http://localhost:8787/proxy";
  }

  return `${window.location.origin}/.netlify/functions/proxy`;
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
