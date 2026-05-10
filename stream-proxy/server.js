// server.js – Deploy to Render.com as a web service
import http from 'http';
import https from 'https';
import url from 'url';

const PORT = process.env.PORT || 3000;

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
    const parsedUrl = url.parse(req.url || '', true);
    const targetUrl = parsedUrl.query.url;

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
                'User-Agent': 'Mozilla/5.0 (compatible; LiveZoneProxy/1.0)',
                Accept: '*/*',
                'Accept-Encoding': 'identity', // prevent gzip/video corruption
                Connection: 'keep-alive',
            },
        },
        (upstreamRes) => {
            // Forward relevant headers
            if (upstreamRes.headers['content-type']) {
                res.setHeader('Content-Type', upstreamRes.headers['content-type']);
            }
            // Prevent caching – critical for live
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');

            // 🔥 THE FIX: force chunked encoding, remove Content-Length
            res.setHeader('Transfer-Encoding', 'chunked');
            res.removeHeader('Content-Length');

            // For HLS playlists (.m3u8), flush headers immediately
            if (targetUrl.includes('.m3u8')) {
                res.flushHeaders();
            }

            res.writeHead(upstreamRes.statusCode || 200);
            upstreamRes.pipe(res);
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