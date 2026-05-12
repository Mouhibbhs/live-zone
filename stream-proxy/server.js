// server.js – Deploy to Render.com as a web service
import http from 'http';

const PORT = process.env.PORT || 3000;

function resolveUrl(uri, targetUrl) {
  if (uri.startsWith('http')) return uri;
  const url = new URL(targetUrl);
  if (uri.startsWith('/')) return url.origin + uri;
  const basePath = url.origin + url.pathname.substring(0, url.pathname.lastIndexOf('/') + 1);
  return basePath + uri;
}

function rewritePlaylist(content, targetUrl, proxyBase, proxyPath) {
  const normalizedProxyPath = proxyPath.endsWith('/') ? proxyPath.slice(0, -1) : proxyPath;
  const fullProxyBase = proxyBase + (normalizedProxyPath || '/proxy');

  return content.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        let modifiedUri = uri;
        if (modifiedUri.startsWith('/serve/')) {
          modifiedUri = modifiedUri.replace('/serve/', '/live/');
        }
        const absoluteUri = resolveUrl(modifiedUri, targetUrl);
        return `URI="${fullProxyBase}?url=${encodeURIComponent(absoluteUri)}"`;
      });
    }
    let modifiedTrimmed = trimmed;
    if (modifiedTrimmed.startsWith('/serve/')) {
      modifiedTrimmed = modifiedTrimmed.replace('/serve/', '/live/');
    }
    const absoluteUri = resolveUrl(modifiedTrimmed, targetUrl);
    return `${fullProxyBase}?url=${encodeURIComponent(absoluteUri)}`;
  }).join('\n');
}

const server = http.createServer(async (req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

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

  if (targetUrl.startsWith('http%3A')) targetUrl = decodeURIComponent(targetUrl);

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    const target = new URL(targetUrl);
    
    // 🛡️ TRANSPARENT PROXY: Mirror all headers from browser to provider
    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['connection'];
    
    // Ensure Referer and Origin match the target
    headers['referer'] = target.origin + '/';
    if (req.headers['origin']) headers['origin'] = target.origin;
    
    // Fallback User-Agent if browser didn't provide one
    if (!headers['user-agent']) {
        headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    }

    console.log(`[PROXY] Fetching: ${targetUrl}`);

    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: abortController.signal
    });

    console.log(`[PROXY] Upstream Status: ${response.status} (${targetUrl})`);

    if (!response.ok) {
      res.writeHead(response.status, corsHeaders);
      res.end(`Upstream Error: ${response.statusText}`);
      return;
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const isM3u8 = targetUrl.toLowerCase().includes('.m3u8') || 
                   contentType.includes('mpegurl') || 
                   contentType.includes('m3u8');

    // Copy essential security headers to browser
    Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (isM3u8) {
      const body = await response.text();
      console.log(`[PROXY] Original M3U8 Target URL: ${targetUrl}`);
      console.log(`[PROXY] Original M3U8 Body:\n${body}`);
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const proxyBase = `${protocol}://${req.headers.host}`;
      const rewritten = rewritePlaylist(body, targetUrl, proxyBase, url.pathname);
      console.log(`[PROXY] Rewritten M3U8 Body:\n${rewritten}`);
      
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.writeHead(200);
      res.end(rewritten);
    } else {
      if (contentType) res.setHeader('Content-Type', contentType);
      
      // Forward segment-specific headers
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
    console.error(`[PROXY] Error: ${error.message} for ${targetUrl}`);
    if (!res.headersSent) {
      res.writeHead(502, corsHeaders);
      res.end(`Proxy Error: ${error.message}`);
    }
  }
});

server.listen(PORT, () => {
  console.log(`✅ Proxy running on port ${PORT}`);
});
