// server.js – Deploy to Render.com as a web service
import http from 'http';

const PORT = process.env.PORT || 3000;

/**
 * Resolves a relative or absolute path against a base URL.
 */
function resolveUrl(uri, pathBase, origin) {
  if (uri.startsWith('http')) return uri;
  if (uri.startsWith('/')) return origin + uri;
  return pathBase + uri;
}

/**
 * Rewrites an HLS playlist so all segment URLs point back to this proxy.
 */
function rewritePlaylist(content, targetUrl, proxyBase, proxyPath) {
  const targetParsed = new URL(targetUrl);
  const targetOrigin = targetParsed.origin;
  const targetPathBase = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
  
  // Ensure we don't end up with // in the path
  const normalizedProxyPath = proxyPath.endsWith('/') ? proxyPath.slice(0, -1) : proxyPath;
  const fullProxyBase = proxyBase + normalizedProxyPath;

  return content.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      // Handle URI= in tags (like #EXT-X-KEY or #EXT-X-MAP)
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        const absoluteUri = resolveUrl(uri, targetPathBase, targetOrigin);
        return `URI="${fullProxyBase}?url=${encodeURIComponent(absoluteUri)}"`;
      });
    }

    // Rewrite segment URL
    const absoluteUri = resolveUrl(trimmed, targetPathBase, targetOrigin);
    return `${fullProxyBase}?url=${encodeURIComponent(absoluteUri)}`;
  }).join('\n');
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    res.writeHead(400, corsHeaders);
    res.end('Missing ?url= parameter');
    return;
  }

  console.log(`[PROXY] Request: ${targetUrl}`);

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': new URL(targetUrl).origin + '/',
        'Connection': 'keep-alive',
      },
      redirect: 'follow'
    });

    console.log(`[PROXY] Upstream: ${response.status} ${response.statusText} (${targetUrl})`);

    if (!response.ok) {
      res.writeHead(response.status, corsHeaders);
      res.end(`Upstream error: ${response.statusText}`);
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    const isM3u8 = targetUrl.toLowerCase().includes('.m3u8') || 
                   contentType.includes('mpegurl') || 
                   contentType.includes('m3u8');

    // Copy CORS and Cache headers
    Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (isM3u8) {
      const body = await response.text();
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const proxyBase = `${protocol}://${req.headers.host}`;
      const rewritten = rewritePlaylist(body, targetUrl, proxyBase, url.pathname);
      
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.writeHead(200);
      res.end(rewritten);
    } else {
      // Stream binary content
      if (contentType) res.setHeader('Content-Type', contentType);
      
      // Forward size/range headers if present
      ['content-length', 'content-range', 'accept-ranges'].forEach(h => {
        const val = response.headers.get(h);
        if (val) res.setHeader(h, val);
      });

      // If it's a live stream (no content-length or large), use chunked
      if (!response.headers.has('content-length')) {
        res.setHeader('Transfer-Encoding', 'chunked');
      }

      res.writeHead(response.status);
      
      // Convert Web Stream to Node Stream and pipe
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    }
  } catch (error) {
    console.error(`[PROXY] Fatal: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, corsHeaders);
      res.end(`Proxy connection failed: ${error.message}`);
    }
  }
});

server.listen(PORT, () => {
  console.log(`✅ Proxy running on port ${PORT}`);
});