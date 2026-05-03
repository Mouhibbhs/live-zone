/**
 * Simple CORS Proxy Server for IPTV streams
 * Run: node proxy-server.js
 * Then open http://localhost:8787 in your browser
 */

const http = require('http');
const url = require('url');

const PROXY_PORT = Number(process.env.PROXY_PORT || 8787);
const MAX_REDIRECTS = 5;

// MIME type mapping for common stream formats
const MIME_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
};

function getContentType(path) {
  const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function pipeRequest(clientReq, clientRes, targetUrl, redirectCount = 0) {
  const parsed = url.parse(targetUrl);
  const isHttps = parsed.protocol === 'https:';
  const httpModule = isHttps ? require('https') : require('http');

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.path,
    method: clientReq.method,
    headers: {
      'User-Agent': clientReq.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': clientReq.headers['accept'] || '*/*',
      'Accept-Language': clientReq.headers['accept-language'] || 'en-US,en;q=0.9',
      'Referer': clientReq.headers['referer'] || parsed.protocol + '//' + parsed.host,
    },
    timeout: 30000,
  };

  const proxyReq = httpModule.request(options, (proxyRes) => {
    if (
      proxyRes.statusCode &&
      proxyRes.statusCode >= 300 &&
      proxyRes.statusCode < 400 &&
      proxyRes.headers.location
    ) {
      if (redirectCount >= MAX_REDIRECTS) {
        clientRes.writeHead(508, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        clientRes.end('Proxy redirect limit exceeded');
        return;
      }

      const redirectTarget = new URL(proxyRes.headers.location, targetUrl).toString();
      proxyRes.resume();
      pipeRequest(clientReq, clientRes, redirectTarget, redirectCount + 1);
      return;
    }

    // Add CORS headers
    clientRes.setHeader('Access-Control-Allow-Origin', '*');
    clientRes.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    clientRes.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    clientRes.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

    // Set content type if not present
    const contentType = proxyRes.headers['content-type'];
    if (!contentType) {
      clientRes.setHeader('Content-Type', getContentType(parsed.pathname || ''));
    }

    clientRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(clientRes, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error('[PROXY] Error:', err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      clientRes.end('Proxy error: ' + err.message);
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!clientRes.headersSent) {
      clientRes.writeHead(504, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      clientRes.end('Proxy timeout');
    }
  });

  clientReq.pipe(proxyReq, { end: true });
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.writeHead(204);
    res.end();
    return;
  }

  // Proxy endpoint: /proxy?url=ENCODED_URL
  if (parsedUrl.pathname === '/proxy') {
    const targetUrl = parsedUrl.query.url;
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Missing url parameter');
      return;
    }
    const decodedUrl = decodeURIComponent(targetUrl);
    console.log('[PROXY] ' + decodedUrl);
    pipeRequest(req, res, decodedUrl);
    return;
  }

  // Serve static files for everything else
  const path = require('path');
  const fs = require('fs');
  let filePath = path.join(__dirname, parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname);
  
  const ext = path.extname(filePath).toLowerCase();
  const staticMimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + parsedUrl.pathname);
      return;
    }
    res.writeHead(200, { 'Content-Type': staticMimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[PROXY] Port ${PROXY_PORT} is already in use.`);
    console.error(`[PROXY] Reuse the existing proxy, stop the old process, or start a new one with PROXY_PORT=8788 node proxy-server.js`);
    return;
  }

  console.error('[PROXY] Server error:', err);
});

server.listen(PROXY_PORT, () => {
  console.log(`CORS Proxy + Static Server running at http://localhost:${PROXY_PORT}/`);
  console.log('Open http://localhost:' + PROXY_PORT + ' in your browser');
});
