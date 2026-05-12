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
        return `URI="${proxyBase}/?url=${encodeURIComponent(absoluteUri)}"`;
      });
    }

    // Rewrite segment URL
    const absoluteUri = resolveUrl(trimmed, targetPathBase, targetOrigin);
    return `${proxyBase}/?url=${encodeURIComponent(absoluteUri)}`;
  }).join('\n');
}

const server = http.createServer((req, res) => {
    // CORS headers – required for your frontend
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Parse the target stream URL from query parameter
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const targetUrl = requestUrl.searchParams.get('url');

    if (!targetUrl || typeof targetUrl !== 'string') {
        res.writeHead(400);
        res.end('Missing ?url= parameter');
        return;
    }

    const target = new URL(targetUrl);
    const protocol = target.protocol === 'https:' ? https : http;

    console.log(`[PROXY] Proxying: ${targetUrl}`);

    const upstreamReq = protocol.request(
        {
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: req.method,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                Accept: '*/*',
                'Accept-Encoding': 'identity', // prevent gzip/video corruption
                Connection: 'keep-alive',
            },
        },
        (upstreamRes) => {
            const contentType = upstreamRes.headers['content-type'] || '';
            const isM3u8 = targetUrl.toLowerCase().includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('m3u8');

            // Prevent caching – critical for live
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');

            if (isM3u8) {
                // Read and rewrite playlist
                let body = '';
                upstreamRes.on('data', chunk => body += chunk);
                upstreamRes.on('end', () => {
                    const protocol = req.headers['x-forwarded-proto'] || 'http';
                    const proxyBase = `${protocol}://${req.headers.host}`;
                    const rewritten = rewritePlaylist(body, targetUrl, proxyBase);
                    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                    res.writeHead(upstreamRes.statusCode || 200);
                    res.end(rewritten);
                });
            } else {
                // Forward relevant headers for binary segments
                if (contentType) {
                    res.setHeader('Content-Type', contentType);
                }
                
                // 🔥 THE FIX: force chunked encoding for live streams, remove Content-Length
                res.setHeader('Transfer-Encoding', 'chunked');
                res.removeHeader('Content-Length');

                // Copy vital segment headers
                if (upstreamRes.headers['content-range']) res.setHeader('Content-Range', upstreamRes.headers['content-range']);
                if (upstreamRes.headers['accept-ranges']) res.setHeader('Accept-Ranges', upstreamRes.headers['accept-ranges']);

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