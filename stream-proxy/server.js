// server.js – Deploy to Render.com as a web service
import http from 'http';

const PORT = process.env.PORT || 3000;

/**
 * Resolves a relative or absolute path against a base URL.
 * Now handles query parameters correctly by stripping them from the base path.
 */
function resolveUrl(uri, targetUrl) {
  if (uri.startsWith('http')) return uri;
  
  const url = new URL(targetUrl);
  if (uri.startsWith('/')) return url.origin + uri;
  
  // For relative paths, use the directory of the current URL
  const basePath = url.origin + url.pathname.substring(0, url.pathname.lastIndexOf('/') + 1);
  return basePath + uri;
}

/**
 * Rewrites an HLS playlist so all segment URLs point back to this proxy.
 */
function rewritePlaylist(content, targetUrl, proxyBase, proxyPath) {
  // Ensure we don't end up with // in the path
  const normalizedProxyPath = proxyPath.endsWith('/') ? proxyPath.slice(0, -1) : proxyPath;
  const fullProxyBase = proxyBase + (normalizedProxyPath || '/proxy');

  return content.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      // Handle URI= in tags (like #EXT-X-STREAM-INF, #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA)
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        const absoluteUri = resolveUrl(uri, targetUrl);
        return `URI="${fullProxyBase}?url=${encodeURIComponent(absoluteUri)}"`;
      });
    }

    // Rewrite plain URL line (segments or variant playlists)
    const absoluteUri = resolveUrl(trimmed, targetUrl);
    return `${fullProxyBase}?url=${encodeURIComponent(absoluteUri)}`;
  }).join('\n');
}

const server = http.createServer(async (req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent, Referer, Origin',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/' || req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain', ...corsHeaders });
    res.end('Proxy Alive');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  let targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    res.writeHead(400, corsHeaders);
    res.end('Missing ?url= parameter');
    return;
  }

  // Double-check encoding - some clients might double-encode
  if (targetUrl.startsWith('http%3A')) {
    targetUrl = decodeURIComponent(targetUrl);
  }

  console.log(`[PROXY] Req: ${targetUrl}`);

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    const target = new URL(targetUrl);
    
    // Transparently forward headers to mimic a browser/player
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'Referer': target.origin + '/',
      'Connection': 'keep-alive',
    };

    // If the browser provided an Origin, forward it (mapped to the target)
    if (req.headers['origin']) {
        headers['Origin'] = target.origin;
    }

    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: abortController.signal
    });

    console.log(`[PROXY] Upstream: ${response.status} (${targetUrl})`);

    if (!response.ok) {
      // Forward upstream errors precisely
      res.writeHead(response.status, corsHeaders);
      const errBody = await response.text().catch(() => 'No error body');
      console.error(`[PROXY] Provider error body: ${errBody.substring(0, 100)}`);
      res.end(`Provider error ${response.status}: ${response.statusText}`);
      return;
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const isM3u8 = targetUrl.toLowerCase().includes('.m3u8') || 
                   contentType.includes('mpegurl') || 
                   contentType.includes('m3u8');

    // Apply response headers
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
      // Binary stream branch (TS segments)
      if (contentType) res.setHeader('Content-Type', contentType);
      
      ['content-length', 'content-range', 'accept-ranges'].forEach(h => {
        const val = response.headers.get(h);
        if (val) res.setHeader(h, val);
      });

      if (!response.headers.has('content-length')) {
        res.setHeader('Transfer-Encoding', 'chunked');
      }

      res.writeHead(response.status);
      
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
      res.end();
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error(`[PROXY] Fatal: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, corsHeaders);
      res.end(`Proxy connection failed: ${error.message}`);
    }
  }
});

server.listen(PORT, () => {
  console.log(`✅ LiveZone Proxy ready on port ${PORT}`);
});
