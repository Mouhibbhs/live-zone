// server.js – Deploy to Render.com
import http from 'http';

const PORT = process.env.PORT || 3000;

function resolveUrl(uri, targetUrl) { /* same as yours */ }
function rewritePlaylist(content, targetUrl, proxyBase, proxyPath) { /* same as yours */ }

const server = http.createServer(async (req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent, Referer, Origin',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Connection': 'keep-alive',
  };

  if (req.method === 'OPTIONS') { /* ... */ }
  if (req.url === '/' || req.url === '/ping') { /* ... */ }

  const url = new URL(req.url, `http://${req.headers.host}`);
  let targetUrl = url.searchParams.get('url');
  if (!targetUrl) { /* ... */ }
  if (targetUrl.startsWith('http%3A')) targetUrl = decodeURIComponent(targetUrl);

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    const target = new URL(targetUrl);
    const headers = { /* same as yours */ };
    const response = await fetch(targetUrl, { method: 'GET', headers, redirect: 'follow', signal: abortController.signal });

    if (!response.ok) { /* forward error */ return; }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const isM3u8 = targetUrl.toLowerCase().includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('m3u8');

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
      // 🔥 FIXED BINARY STREAM BRANCH – INFINITE LIVE
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
            console.log('[PROXY] Upstream ended – keeping socket open');
            break; // DO NOT end response
          }
          const canContinue = res.write(value);
          if (!canContinue) await new Promise(resolve => res.once('drain', resolve));
        }
      } catch (err) {
        if (err.name !== 'AbortError') console.error('[PROXY] Stream error', err);
      } finally {
        reader.releaseLock();
        // NEVER call res.end() – the connection stays alive
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

server.listen(PORT, () => console.log(`✅ Proxy ready on port ${PORT}`));