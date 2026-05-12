// server.js – CommonJS version for Render.com
const http = require('http');

const PORT = process.env.PORT || 3000;

/**
 * Resolve relative URIs against a base URL.
 */
function resolveUrl(uri, targetUrl) {
  if (uri.startsWith('http')) return uri;
  const url = new URL(targetUrl);
  if (uri.startsWith('/')) return url.origin + uri;
  const basePath = url.origin + url.pathname.substring(0, url.pathname.lastIndexOf('/') + 1);
  return basePath + uri;
}

/**
 * Rewrite HLS playlist to route all segments through the proxy.
 */
function rewritePlaylist(content, targetUrl, proxyBase, proxyPath) {
  const normalizedProxyPath = proxyPath.endsWith('/') ? proxyPath.slice(0, -1) : proxyPath;
  const fullProxyBase = proxyBase + (normalizedProxyPath || '/proxy');

  return content.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        const absoluteUri = resolveUrl(uri, targetUrl);
        return `URI="${fullProxyBase}?url=${encodeURIComponent(absoluteUri)}"`;
      });
    }

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
    'Connection': 'keep-alive',
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

  // Fix double‑encoding
  if (targetUrl.startsWith('http%3A')) {
    targetUrl = decodeURIComponent(targetUrl);
  }

  console.log(`[PROXY] Request: ${targetUrl}`);

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    const target = new URL(targetUrl);
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'Referer': target.origin + '/',
      'Connection': 'keep-alive',
    };
    if (req.headers['origin']) headers['Origin'] = target.origin;

    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: abortController.signal
    });

    console.log(`[PROXY] Upstream status: ${response.status}`);

    if (!response.ok) {
      res.writeHead(response.status, corsHeaders);
      const errBody = await response.text().catch(() => '');
      res.end(`Provider error ${response.status}: ${response.statusText}`);
      return;
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const isM3u8 = targetUrl.toLowerCase().includes('.m3u8') ||
                   contentType.includes('mpegurl') ||
                   contentType.includes('m3u8');

    // Apply common headers
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
      // Binary stream (MPEG‑TS) – INFINITE LIVE STREAM
      if (contentType) res.setHeader('Content-Type', contentType);
      res.setHeader('Transfer-Encoding', 'chunked');
      res.removeHeader('Content-Length');

      res.writeHead(response.status);

      const reader = response.body.getReader();
      let reading = true;
      req.on('close', () => { reading = false; reader.cancel(); });

      try {
        while (reading) {
          const { done, value } = await reader.read();
          if (done) {
            console.log('[PROXY] Upstream ended – keeping connection open');
            break; // DO NOT end response – socket stays alive
          }
          const canContinue = res.write(value);
          if (!canContinue) await new Promise(resolve => res.once('drain', resolve));
        }
      } catch (err) {
        if (err.name !== 'AbortError') console.error('[PROXY] Stream error', err);
      } finally {
        reader.releaseLock();
        // NEVER call res.end() – live stream continues
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error(`[PROXY] Fatal: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, corsHeaders);
      res.end(`Proxy error: ${error.message}`);
    }
  }
});

server.listen(PORT, () => {
  console.log(`✅ LiveZone proxy listening on port ${PORT}`);
});