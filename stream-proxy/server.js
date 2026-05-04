const http = require("http");
const https = require("https");

const PORT = Number(process.env.PORT || 8787);
// CRITICAL: Ensure this matches your actual Render service URL
const PROXY_BASE_URL = "https://live-zone.onrender.com/proxy";

/**
 * Headers that cause browsers to trigger Auth prompts or block content.
 * These are stripped from the IPTV provider's response.
 */
const FORBIDDEN_HEADERS = [
  "www-authenticate",
  "set-cookie",
  "content-security-policy",
  "x-frame-options",
  "strict-transport-security",
  "content-length", // Let Node handle length for rewritten playlists
  "connection",
  "transfer-encoding"
];

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "X-Accel-Buffering": "no" // Prevents Render/Nginx from buffering video chunks
  };
}

const server = http.createServer((req, res) => {
  // 1. Handle CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, getCorsHeaders());
    return res.end();
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const targetUrl = requestUrl.searchParams.get("url");

  // 2. Health Check
  if (requestUrl.pathname === "/health") {
    res.writeHead(200, getCorsHeaders());
    return res.end("OK");
  }

  if (requestUrl.pathname !== "/proxy" || !targetUrl) {
    res.writeHead(404, getCorsHeaders());
    return res.end("Direct access not allowed. Use /proxy?url=...");
  }

  let target;
  try {
    target = new URL(targetUrl);
  } catch (e) {
    res.writeHead(400, getCorsHeaders());
    return res.end("Invalid target URL");
  }

  const client = target.protocol === "https:" ? https : http;

  const upstreamReq = client.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    method: "GET",
    headers: {
      "User-Agent": "VLC/3.0.20 LibVLC/3.0.20", // Impersonate a real player
      "Host": target.hostname,
      "Range": req.headers.range || ""
    }
  }, (upstream) => {
    const finalHeaders = { ...getCorsHeaders() };

    // 3. Header Scrubbing Logic
    Object.keys(upstream.headers).forEach(key => {
      if (!FORBIDDEN_HEADERS.includes(key.toLowerCase())) {
        finalHeaders[key] = upstream.headers[key];
      }
    });

    const contentType = (upstream.headers["content-type"] || "").toLowerCase();
    const isPlaylist = target.pathname.endsWith(".m3u8") || contentType.includes("mpegurl");

    if (isPlaylist) {
      let body = "";
      upstream.on("data", chunk => body += chunk);
      upstream.on("end", () => {
        // 4. Playlist URL Rewriting
        const rewritten = body.replace(/^(https?:\/\/.*|[^#].*)$/gm, (match) => {
          const trimmed = match.trim();
          if (!trimmed || trimmed.startsWith("#")) return match;
          try {
            const absolute = new URL(trimmed, targetUrl).toString();
            return `${PROXY_BASE_URL}?url=${encodeURIComponent(absolute)}`;
          } catch (e) { return match; }
        });

        finalHeaders["Content-Type"] = "application/vnd.apple.mpegurl";
        res.writeHead(upstream.statusCode, finalHeaders);
        res.end(rewritten);
      });
    } else {
      // 5. Stream Binary (Video Chunks)
      res.writeHead(upstream.statusCode, finalHeaders);
      upstream.pipe(res);
    }
  });

  upstreamReq.on("error", (err) => {
    console.error("Proxy Error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, getCorsHeaders());
      res.end("Stream provider unreachable");
    }
  });

  upstreamReq.end();
});

server.listen(PORT, () => {
  console.log(`Perfect Proxy running on port ${PORT}`);
});
