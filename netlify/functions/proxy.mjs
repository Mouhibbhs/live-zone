// Netlify edge function that forwards live HLS/MPEG‑TS streams.
// ---------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  "Cache-Control": "no-cache, no-store, must-revalidate",
};

// Timeout for upstream fetches (in ms). Live streams may need up to 60 s.
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Simple whitelist – only allow http/https URLs.
 * Adjust the RegExp if you want to restrict to specific domains.
 */
function isAllowedTarget(urlStr) {
  try {
    const u = new URL(urlStr);
    return ["http:", "https:"].includes(u.protocol);
  } catch {
    return false;
  }
}

function getProxyEndpoint(requestUrl) {
  const url = new URL(requestUrl);
  return `${url.origin}${url.pathname}`;
}

/** Build headers for the upstream request, forwarding important ones. */
function buildUpstreamHeaders(request, targetUrl) {
  const target = new URL(targetUrl);
  const headers = new Headers();

  // Preserve UA when present; otherwise use a modern default UA.
  const ua = request.headers.get("user-agent");
  headers.set(
    "User-Agent",
    ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  );

  headers.set("Accept", request.headers.get("accept") || "*/*");
  headers.set(
    "Accept-Language",
    request.headers.get("accept-language") || "en-US,en;q=0.9"
  );
  headers.set("Referer", target.origin);
  // Keep‑alive helps live streams stay open.
  headers.set("Connection", "keep-alive");

  const range = request.headers.get("range");
  if (range) {
    headers.set("Range", range);
  }

  return headers;
}

/** Fetch with abort controller using the configured timeout. */
async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(id);
    return response;
  } finally {
    clearTimeout(id);
  }
}

/** Rewrite an HLS playlist so that every URI points back to the proxy. */
function rewritePlaylist(playlistText, targetUrl, requestUrl) {
  const proxyEndpoint = getProxyEndpoint(requestUrl);
  const target = new URL(targetUrl);
  const proxyUrl = (value) => {
    const resolved = new URL(value, target).toString();
    return `${proxyEndpoint}?url=${encodeURIComponent(resolved)}`;
  };

  // Preserve blank lines and comments; only rewrite URIs.
  return playlistText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();

      if (trimmed === "") {
        return line; // keep empty line exactly
      }

      // Do NOT strip #EXT-X-ENDLIST for live playlists – it would signal
      // premature end of the stream.
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_m, v) => `URI="${proxyUrl(v)}"`);
      }

      // Plain URI line – rewrite to go through the proxy.
      return proxyUrl(trimmed);
    })
    .join("\n");
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const requestUrl = new URL(request.url);
  const targetUrl = requestUrl.searchParams.get("url");

  if (!targetUrl) {
    return new Response("Missing url parameter", {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  if (!isAllowedTarget(targetUrl)) {
    return new Response("Forbidden target URL", {
      status: 403,
      headers: CORS_HEADERS,
    });
  }

  let upstream;
  try {
    upstream = await fetchWithTimeout(targetUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request, targetUrl),
      redirect: "follow",
    });
  } catch (error) {
    console.error("[iptv-proxy] fetch error:", error);
    return new Response(`Proxy error: ${error instanceof Error ? error.message : String(error)}`,
      {
        status: 502,
        headers: CORS_HEADERS,
      }
    );
  }

  // Log each request for debugging.
  console.log(`[iptv-proxy] ${request.method} ${requestUrl.href} → ${targetUrl} : ${upstream.status}`);

  if (!upstream.ok) {
    // Forward upstream status text for clearer UI errors.
    return new Response(upstream.statusText || "Upstream error", {
      status: upstream.status,
      headers: CORS_HEADERS,
    });
  }

  const contentType = upstream.headers.get("content-type") || "";
  const isPlaylist =
    contentType.includes("mpegurl") ||
    contentType.includes("m3u8") ||
    targetUrl.toLowerCase().includes(".m3u8");

  if (isPlaylist) {
    // Existing playlist handling (HLS)
    // Existing playlist handling (HLS)
    // Existing playlist handling (HLS)
    // Existing playlist handling (HLS)

    const playlistText = await upstream.text();
    const rewritten = rewritePlaylist(playlistText, targetUrl, request.url);
    return new Response(rewritten, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/vnd.apple.mpegurl",
      },
    });
  }

  // Handle raw .ts segment by synthesizing a live HLS playlist
    if (!isPlaylist && targetUrl.toLowerCase().endsWith('.ts')) {
      // Create a minimal live playlist that references the requested TS segment.
      // The player will treat this as a live HLS stream and keep the MediaSource open.
      const livePlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.000,
${targetUrl}`;
      return new Response(livePlaylist, {
        status: upstream.status,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/vnd.apple.mpegurl",
        },
      });
    }
    // Pass‑through for non‑playlist assets.

  const responseHeaders = new Headers(CORS_HEADERS);
  responseHeaders.set("Content-Type", contentType || "application/octet-stream");

  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) {
      responseHeaders.set(name, value);
    }
  }

  // Preserve upstream Cache‑Control if present.
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) {
    responseHeaders.set("Cache-Control", cacheControl);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
};
