const http = require("http");
const https = require("https");

const PORT = Number(process.env.PORT || 8787);
const MAX_REDIRECTS = 5;

// Strictly force the Render URL to avoid relative path issues or Mixed Content
const PROXY_BASE_URL = "https://livezone-proxy.onrender.com/proxy";

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

const FORBIDDEN_CLIENT_HEADERS = new Set([
  "www-authenticate",
  "set-cookie",
  "content-security-policy",
  "strict-transport-security",
  "x-frame-options",
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

const DEFAULT_UPSTREAM_HEADER_PROFILES = [
  { userAgent: "VLC/3.0.20 LibVLC/3.0.20" },
  { userAgent: "IPTVSmartersPlayer" },
  { userAgent: "TiviMate/4.7.0 (Linux; Android 11)" },
  { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range, User-Agent",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "X-Accel-Buffering": "no", // Disables buffering on Nginx/Render for smoother streaming
  };
}

function getContentType(pathname) {
  const dotIndex = pathname.lastIndexOf(".");
  const extension = dotIndex >= 0 ? pathname.slice(dotIndex).toLowerCase() : "";
  return MIME_TYPES[extension] || "application/octet-stream";
}

function proxyUrl(value, target) {
  try {
    const resolved = new URL(value, target).toString();
    return `${PROXY_BASE_URL}?url=${encodeURIComponent(resolved)}`;
  } catch (e) {
    return value;
  }
}

function rewritePlaylist(playlistText, targetUrl) {
  const target = new URL(targetUrl);
  return playlistText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Handle Tag attributes like URI="segment.ts"
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, value) => `URI="${proxyUrl(value, target)}"`);
      }

      // Handle the actual URL lines
      return proxyUrl(trimmed, target);
    })
    .join("\n");
}

function getUpstreamHeaderProfiles() {
  return DEFAULT_UPSTREAM_HEADER_PROFILES;
}

function buildUpstreamHeaders(req, target, profile) {
  const headers = {
    Host: target.host,
    "User-Agent": profile.userAgent,
    Accept: "*/*",
    Connection: "keep-alive",
  };

  if (req.headers.range) headers.Range = req.headers.range;
  return headers;
}

function writeProxyHeaders(res, upstream, target) {
  const headers = corsHeaders();

  for (const [name, value] of Object.entries(upstream.headers)) {
    const lowerName = name.toLowerCase();
    // Filter out dangerous headers that cause 401s or security blocks on Netlify
    if (!HOP_BY_HOP_HEADERS.has(lowerName) && !FORBIDDEN_CLIENT_HEADERS.has(lowerName) && lowerName !== "content-length") {
      headers[name] = value;
    }
  }

  if (!headers["content-type"]) {
    headers["content-type"] = getContentType(target.pathname);
  }

  res.writeHead(upstream.statusCode || 200, headers);
}

function pipeBinary(req, res, upstream, target, firstChunk) {
  writeProxyHeaders(res, upstream, target);
  if (firstChunk && req.method !== "HEAD") res.write(firstChunk);
  upstream.pipe(res);
}

function handlePlaylist(req, res, upstream, targetUrl, firstChunk) {
  const chunks = [];
  if (firstChunk) chunks.push(firstChunk);

  upstream.on("data", (chunk) => chunks.push(chunk));
  upstream.on("end", () => {
    const playlist = Buffer.concat(chunks).toString("utf8");
    const rewritten = rewritePlaylist(playlist, targetUrl);

    res.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "application/vnd.apple.mpegurl",
    });

    res.end(rewritten);
  });
}

function proxyRequest(req, res, targetUrl, redirectCount = 0, userAgentIndex = 0) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    res.writeHead(400, { ...corsHeaders() });
    return res.end("Invalid URL");
  }

  const client = target.protocol === "https:" ? https : http;
  const profile = getUpstreamHeaderProfiles()[userAgentIndex];

  const upstreamReq = client.request(
    {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: "GET",
      headers: buildUpstreamHeaders(req, target, profile),
      timeout: 10000,
    },
    (upstream) => {
      // Handle Redirects
      if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
        if (redirectCount >= MAX_REDIRECTS) {
          res.writeHead(508, corsHeaders());
          return res.end("Too many redirects");
        }
        const redirectedUrl = new URL(upstream.headers.location, targetUrl).toString();
        return proxyRequest(req, res, redirectedUrl, redirectCount + 1, userAgentIndex);
      }

      // Handle Auth Failure (Retry with different User-Agent)
      if ((upstream.statusCode === 401 || upstream.statusCode === 403) && userAgentIndex < DEFAULT_UPSTREAM_HEADER_PROFILES.length - 1) {
        return proxyRequest(req, res, targetUrl, redirectCount, userAgentIndex + 1);
      }

      const contentType = String(upstream.headers["content-type"] || "").toLowerCase();
      const isPlaylist = contentType.includes("mpegurl") || contentType.includes("m3u8") || target.pathname.endsWith(".m3u8");

      if (!isPlaylist) {
        return pipeBinary(req, res, upstream, target);
      }

      // Read first chunk to verify it's actually an M3U8 file
      upstream.once("data", (chunk) => {
        const content = chunk.toString();
        if (content.includes("#EXTM3U")) {
          handlePlaylist(req, res, upstream, targetUrl, chunk);
        } else {
          pipeBinary(req, res, upstream, target, chunk);
        }
      });
    }
  );

  upstreamReq.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, corsHeaders());
    res.end(`Proxy Error: ${err.message}`);
  });

  upstreamReq.end();
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const requestUrl = new URL(req.url || "/", `http://${req.headers.host}`);

  if (requestUrl.pathname === "/health") {
    res.writeHead(200, corsHeaders());
    return res.end(JSON.stringify({ status: "ok" }));
  }

  const targetUrl = requestUrl.searchParams.get("url");
  if (requestUrl.pathname === "/proxy" && targetUrl) {
    return proxyRequest(req, res, targetUrl);
  }

  res.writeHead(404, corsHeaders());
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`Stream Proxy running on port ${PORT}`);
});
