const http = require("http");
const https = require("https");

const PORT = Number(process.env.PORT || process.env.PROXY_PORT || 8787);
const MAX_REDIRECTS = 5;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const MIME_TYPES = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".mp4": "video/mp4",
  ".m4s": "video/iso.segment",
  ".aac": "audio/aac",
  ".mp3": "audio/mpeg",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Cache-Control": "no-cache, no-store, must-revalidate, no-transform",
    "X-Accel-Buffering": "no",
  };
}

function getContentType(pathname) {
  const dotIndex = pathname.lastIndexOf(".");
  const extension = dotIndex >= 0 ? pathname.slice(dotIndex).toLowerCase() : "";
  return MIME_TYPES[extension] || "application/octet-stream";
}

function getProxyEndpoint(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const rawProtocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || "https";
  const protocol = String(rawProtocol).split(",")[0].trim() || "https";
  return `${protocol}://${req.headers.host}/proxy`;
}

function proxyUrl(req, value, target) {
  const resolved = new URL(value, target).toString();
  return `${getProxyEndpoint(req)}?url=${encodeURIComponent(resolved)}`;
}

function rewritePlaylist(req, playlistText, targetUrl) {
  const target = new URL(targetUrl);

  return playlistText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed || trimmed === "#EXT-X-ENDLIST") {
        return "";
      }

      try {
        if (trimmed.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/g, (_match, value) => `URI="${proxyUrl(req, value, target)}"`);
        }

        return proxyUrl(req, trimmed, target);
      } catch {
        return line;
      }
    })
    .join("\n");
}

function buildUpstreamHeaders(req, target) {
  const headers = {
    "User-Agent":
      req.headers["user-agent"] ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: req.headers.accept || "*/*",
    "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
    Referer: target.origin,
  };

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  return headers;
}

function writeProxyHeaders(res, upstream, target) {
  const headers = corsHeaders();

  for (const [name, value] of Object.entries(upstream.headers)) {
    const lowerName = name.toLowerCase();

    if (!HOP_BY_HOP_HEADERS.has(lowerName) && lowerName !== "content-length") {
      headers[name] = value;
    }
  }

  if (!headers["content-type"] && !headers["Content-Type"]) {
    headers["Content-Type"] = getContentType(target.pathname);
  }

  res.writeHead(upstream.statusCode || 200, headers);
}

function pipeBinary(req, res, upstream, target, firstChunk) {
  writeProxyHeaders(res, upstream, target);

  if (firstChunk && req.method !== "HEAD") {
    res.write(firstChunk);
  }

  upstream.pipe(res, { end: true });
}

function handlePlaylist(req, res, upstream, targetUrl, firstChunk) {
  const chunks = [];

  if (firstChunk) {
    chunks.push(firstChunk);
  }

  upstream.on("data", (chunk) => chunks.push(chunk));
  upstream.on("end", () => {
    const playlist = Buffer.concat(chunks).toString("utf8");
    const rewritten = rewritePlaylist(req, playlist, targetUrl);

    res.writeHead(upstream.statusCode || 200, {
      ...corsHeaders(),
      "Content-Type": "application/vnd.apple.mpegurl",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    res.end(rewritten);
  });
}

function proxyRequest(req, res, targetUrl, redirectCount = 0) {
  let target;

  try {
    target = new URL(targetUrl);
  } catch {
    res.writeHead(400, { ...corsHeaders(), "Content-Type": "text/plain" });
    res.end("Invalid url parameter");
    return;
  }

  const client = target.protocol === "https:" ? https : http;
  const upstreamReq = client.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: buildUpstreamHeaders(req, target),
      timeout: 0,
    },
    (upstream) => {
      if (
        upstream.statusCode &&
        upstream.statusCode >= 300 &&
        upstream.statusCode < 400 &&
        upstream.headers.location
      ) {
        if (redirectCount >= MAX_REDIRECTS) {
          upstream.resume();
          res.writeHead(508, { ...corsHeaders(), "Content-Type": "text/plain" });
          res.end("Proxy redirect limit exceeded");
          return;
        }

        const redirectedUrl = new URL(upstream.headers.location, targetUrl).toString();
        upstream.resume();
        proxyRequest(req, res, redirectedUrl, redirectCount + 1);
        return;
      }

      if (!upstream.statusCode || upstream.statusCode >= 400) {
        writeProxyHeaders(res, upstream, target);
        upstream.pipe(res, { end: true });
        return;
      }

      const contentType = String(upstream.headers["content-type"] || "").toLowerCase();
      const maybePlaylist = contentType.includes("mpegurl") || contentType.includes("m3u8") || target.pathname.endsWith(".m3u8");
      let receivedData = false;

      if (!maybePlaylist) {
        pipeBinary(req, res, upstream, target);
        return;
      }

      upstream.once("data", (firstChunk) => {
        receivedData = true;
        const looksLikePlaylist = firstChunk.toString("utf8", 0, Math.min(firstChunk.length, 32)).includes("#EXTM3U");

        if (contentType.includes("mpegurl") || contentType.includes("m3u8") || looksLikePlaylist) {
          handlePlaylist(req, res, upstream, targetUrl, firstChunk);
          return;
        }

        pipeBinary(req, res, upstream, target, firstChunk);
      });

      upstream.once("end", () => {
        if (!receivedData && !res.headersSent) {
          res.writeHead(upstream.statusCode || 200, {
            ...corsHeaders(),
            "Content-Type": "application/vnd.apple.mpegurl",
          });
          res.end("");
        }
      });
    },
  );

  upstreamReq.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { ...corsHeaders(), "Content-Type": "text/plain" });
    }
    res.end(`Proxy error: ${error.message}`);
  });

  req.pipe(upstreamReq, { end: true });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...corsHeaders(),
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/health") {
    res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (requestUrl.pathname !== "/proxy") {
    res.writeHead(404, { ...corsHeaders(), "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const targetUrl = requestUrl.searchParams.get("url");

  if (!targetUrl) {
    res.writeHead(400, { ...corsHeaders(), "Content-Type": "text/plain" });
    res.end("Missing url parameter");
    return;
  }

  proxyRequest(req, res, targetUrl);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

server.listen(PORT, () => {
  console.log(`LiveZone stream proxy listening on port ${PORT}`);
});
