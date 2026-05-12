// server.js – Deploy to Render.com as a web service
import http from 'http';
import https from 'https';

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
  const fullProxyBase = proxyBase + (proxyPath.startsWith('/') ? proxyPath : '/' + proxyPath);

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

const server = http.createServer((req, res) => {
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

    // Parse the target stream URL from query parameter
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const targetUrl = requestUrl.searchParams.get('url');

    if (!targetUrl || typeof targetUrl !== 'string') {
        res.writeHead(400, corsHeaders);
        res.end('Missing ?url= parameter');
        return;
    }

    let target;
    try {
      target = new URL(targetUrl);
    } catch (e) {
      res.writeHead(400, corsHeaders);
      res.end('Invalid target URL');
      return;
    }

    const protocol = target.protocol === 'https:' ? https : http;

    console.log(`[PROXY] Fetching: ${targetUrl}`);

    const upstreamReq = protocol.request(
        {
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Encoding': 'identity',
                'Referer': target.origin + '/',
                'Connection': 'keep-alive',
            },
        },
        (upstreamRes) => {
            console.log(`[PROXY] Upstream Status: ${upstreamRes.statusCode} (${targetUrl})`);
            
            const contentType = upstreamRes.headers['content-type'] || '';
            const isM3u8 = targetUrl.toLowerCase().includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('m3u8');

            // Copy essential headers
            Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

            if (isM3u8) {
                let body = '';
                upstreamRes.on('data', chunk => body += chunk);
                upstreamRes.on('end', () => {
                    const protocol = req.headers['x-forwarded-proto'] || 'http';
                    const proxyBase = `${protocol}://${req.headers.host}`;
                    const rewritten = rewritePlaylist(body, targetUrl, proxyBase, requestUrl.pathname);
                    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                    res.writeHead(upstreamRes.statusCode || 200);
                    res.end(rewritten);
                });
            } else {
                if (contentType) res.setHeader('Content-Type', contentType);
                res.setHeader('Transfer-Encoding', 'chunked');
                
                // Copy segment-specific headers
                ['content-range', 'accept-ranges', 'content-length'].forEach(h => {
                  if (upstreamRes.headers[h]) res.setHeader(h, upstreamRes.headers[h]);
                });

                res.writeHead(upstreamRes.statusCode || 200);
                upstreamRes.pipe(res);
            }
        }
    );

    upstreamReq.on('error', (err) => {
        console.error(`[PROXY] Error for ${targetUrl}:`, err.message);
        if (!res.headersSent) {
            res.writeHead(502);
            res.end(`Proxy error: ${err.message}`);
        }
    });

    // If client disconnects, stop upstream request
    req.on('close', () => {
        upstreamReq.destroy();
    });

    upstreamReq.end();
});

server.listen(PORT, () => {
    console.log(`✅ Live streaming proxy running on port ${PORT}`);
});