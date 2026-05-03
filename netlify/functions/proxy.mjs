const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  "Cache-Control": "no-cache, no-store, must-revalidate",
};

function getProxyEndpoint(requestUrl) {
  const url = new URL(requestUrl);
  return `${url.origin}${url.pathname}`;
}

function rewritePlaylist(playlistText, targetUrl, requestUrl) {
  const proxyEndpoint = getProxyEndpoint(requestUrl);
  const target = new URL(targetUrl);
  const proxyUrl = (value) => {
    const resolved = new URL(value, target).toString();
    return `${proxyEndpoint}?url=${encodeURIComponent(resolved)}`;
  };

  return playlistText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        return line;
      }

      if (trimmed === "#EXT-X-ENDLIST") {
        return "";
      }

      try {
        if (trimmed.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/g, (_match, value) => `URI="${proxyUrl(value)}"`);
        }

        return proxyUrl(trimmed);
      } catch {
        return line;
      }
    })
    .join("\n");
}

function buildUpstreamHeaders(request, targetUrl) {
  const target = new URL(targetUrl);
  const headers = new Headers();

  headers.set(
    "User-Agent",
    request.headers.get("user-agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  );
  headers.set("Accept", request.headers.get("accept") || "*/*");
  headers.set("Accept-Language", request.headers.get("accept-language") || "en-US,en;q=0.9");
  headers.set("Referer", target.origin);

  const range = request.headers.get("range");
  if (range) {
    headers.set("Range", range);
  }

  return headers;
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

  let upstream;

  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request, targetUrl),
      redirect: "follow",
    });
  } catch (error) {
    return new Response(`Proxy error: ${error instanceof Error ? error.message : String(error)}`, {
      status: 502,
      headers: CORS_HEADERS,
    });
  }

  if (!upstream.ok) {
    return new Response("Stream unavailable", {
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

  const responseHeaders = new Headers(CORS_HEADERS);
  responseHeaders.set("Content-Type", contentType || "application/octet-stream");

  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) {
      responseHeaders.set(name, value);
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
};
