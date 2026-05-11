/**
 * Advanced CORS Proxy Server for IPTV streams
 * Supports HLS (.m3u8) playlist rewriting for full CORS bypass
 * Run: node proxy-server.js
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PROXY_PORT = Number(process.env.PROXY_PORT || 8787);
const MAX_REDIRECTS = 5;

// MIME type mapping
const MIME_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

function getContentType(path) {
  const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Rewrites an HLS playlist so all segment URLs point back to this proxy.
 */
function rewritePlaylist(content, targetUrl, proxyBase) {
  const targetParsed = new URL(targetUrl);
  const targetOrigin = targetParsed.origin;
  const targetPathBase = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

  return content.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      // Handle URI= in tags (like #EXT-X-KEY or #EXT-X-MAP)
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        const absoluteUri = resolveUrl(uri, targetPathBase, targetOrigin);
        return `URI="${proxyBase}/proxy?url=${encodeURIComponent(absoluteUri)}"`;
      });
    }

    // Rewrite segment URL
    const absoluteUri = resolveUrl(trimmed, targetPathBase, targetOrigin);
    return `${proxyBase}/proxy?url=${encodeURIComponent(absoluteUri)}`;
  }).join('\n');
}

function resolveUrl(uri, pathBase, origin) {
  if (uri.startsWith('http')) return uri;
  if (uri.startsWith('/')) return origin + uri;
  return pathBase + uri;
}

function pipeRequest(clientReq, clientRes, targetUrl, redirectCount = 0) {
  const parsed = url.parse(targetUrl);
  const isHttps = parsed.protocol === 'https:';
  const httpModule = isHttps ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.path,
    method: 'GET', // IPTV streams are usually GET
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Referer': parsed.protocol + '//' + parsed.host,
      'Connection': 'keep-alive',
    },
    timeout: 60000,
  };

  const proxyReq = httpModule.request(options, (proxyRes) => {
    // Handle redirects
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      if (redirectCount >= MAX_REDIRECTS) {
        clientRes.writeHead(508);
        clientRes.end('Too many redirects');
        return;
      }
      const redirectUrl = new URL(proxyRes.headers.location, targetUrl).toString();
      return pipeRequest(clientReq, clientRes, redirectUrl, redirectCount + 1);
    }

    const contentType = proxyRes.headers['content-type'] || '';
    const isM3u8 = targetUrl.toLowerCase().includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('m3u8');

    // Add CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    };

    if (isM3u8) {
      // Read and rewrite playlist
      let body = '';
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        const proxyBase = `${clientReq.headers.protocol || 'http'}://${clientReq.headers.host}`;
        const rewritten = rewritePlaylist(body, targetUrl, proxyBase);
        headers['Content-Type'] = 'application/vnd.apple.mpegurl';
        clientRes.writeHead(proxyRes.statusCode, headers);
        clientRes.end(rewritten);
      });
    } else {
      // Pipe binary stream (TS segments)
      headers['Content-Type'] = contentType || getContentType(parsed.pathname || '');
      // Copy vital headers
      if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range'];
      if (proxyRes.headers['accept-ranges']) headers['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

      clientRes.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(clientRes);
    }
  });

  proxyReq.on('error', (err) => {
    console.error('[PROXY] Error:', err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end(`Proxy error: ${err.message}`);
    }
  });

  proxyReq.end();
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (parsedUrl.pathname === '/proxy') {
    const targetUrl = parsedUrl.query.url;
    if (!targetUrl) {
      res.writeHead(400);
      res.end('Missing url');
      return;
    }
    const decodedUrl = decodeURIComponent(targetUrl);
    console.log(`[PROXY] Fetching: ${decodedUrl}`);
    pipeRequest(req, res, decodedUrl);
  } else {
    res.writeHead(404);
    res.end('Use /proxy?url=...');
  }
});

server.listen(PROXY_PORT, () => {
  console.log(`✅ Proxy running at http://localhost:${PROXY_PORT}/proxy`);
});
