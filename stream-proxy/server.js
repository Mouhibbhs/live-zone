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



const DEFAULT_UPSTREAM_HEADER_PROFILES = [

  {

    userAgent: "VLC/3.0.20 LibVLC/3.0.20",

  },

  {

    userAgent: "IPTVSmartersPlayer",

  },

  {

    userAgent: "TiviMate/4.7.0 (Linux; Android 11)",

  },

  {

    userAgent: "Lavf/60.16.100",

  },

  {

    userAgent:

      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",

    referer: "origin",

  },

];



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



function getUpstreamHeaderProfiles() {

  const configured = process.env.UPSTREAM_USER_AGENT || process.env.UPSTREAM_USER_AGENTS || "";

  const configuredUserAgents = configured

    .split(",")

    .map((value) => value.trim())

    .filter(Boolean);



  if (configuredUserAgents.length > 0) {

    return configuredUserAgents.map((userAgent) => ({

      userAgent,

      referer: process.env.UPSTREAM_REFERER || "",

    }));

  }



  return DEFAULT_UPSTREAM_HEADER_PROFILES;

}



function buildUpstreamHeaders(req, target, profile) {

  const headers = {

    Host: target.host,

    "User-Agent": profile.userAgent,

    Accept: "*/*",

    "Icy-MetaData": "1",

    "Cache-Control": "no-cache",

    Pragma: "no-cache",

  };



  const referer = profile.referer === "origin" ? target.origin : profile.referer;



  if (referer) {

    headers.Referer = referer;

  }



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



function proxyRequest(req, res, targetUrl, redirectCount = 0, userAgentIndex = 0) {

  let target;



  try {

    target = new URL(targetUrl);

  } catch {

    res.writeHead(400, { ...corsHeaders(), "Content-Type": "text/plain" });

    res.end("Invalid url parameter");

    return;

  }



  const client = target.protocol === "https:" ? https : http;

  const headerProfiles = getUpstreamHeaderProfiles();

  const headerProfile = headerProfiles[userAgentIndex] || headerProfiles[0];

  const upstreamReq = client.request(

    {

      protocol: target.protocol,

      hostname: target.hostname,

      port: target.port || (target.protocol === "https:" ? 443 : 80),

      path: `${target.pathname}${target.search}`,

      method: req.method,

      headers: buildUpstreamHeaders(req, target, headerProfile),

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

        proxyRequest(req, res, redirectedUrl, redirectCount + 1, userAgentIndex);

        return;

      }



      if ((upstream.statusCode === 401 || upstream.statusCode === 403) && userAgentIndex < headerProfiles.length - 1) {

        upstream.resume();

        proxyRequest(req, res, targetUrl, redirectCount, userAgentIndex + 1);

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



  upstreamReq.end();

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



  if (req.method !== "GET" && req.method !== "HEAD") {

    res.writeHead(405, { ...corsHeaders(), "Content-Type": "text/plain" });

    res.end("Method not allowed");

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
