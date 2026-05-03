export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    try {
      const url = new URL(request.url);
      const target = decodeURIComponent(url.searchParams.get("url") || '');

      if (!target) {
        return new Response("Missing url parameter", { status: 400 });
      }

      const response = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Origin": new URL(target).origin,
          "Referer": target.replace(/\/[^\/]*$/, '/'),
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
"Sec-Fetch-Site": "cross-site",
          "Connection": "keep-alive"
        }
      });

      if (!response.ok) {
        return new Response("Stream unavailable", { status: response.status });
      }

      const contentType = response.headers.get('content-type') || '';
      const isM3u8 = contentType.includes('m3u8') || target.endsWith('.m3u8');

      if (isM3u8) {
        // Parse and rewrite playlist
        const playlistText = await response.text();
        const proxyBase = new URL(request.url).origin;
        
        const rewritten = playlistText
          .replace(/(https?:\/\/[^#\s\n\r\t]+?\.(?:m3u8|ts)(?:\?[^\s\n\r\t#]+)?)/gi, (match) => {
            return `${proxyBase}/?url=${encodeURIComponent(match)}`;
          })
          .replace(/(\/[^#\s\n\r\t]+?\.(?:m3u8|ts)(?:\?[^\s\n\r\t#]+)?)/gi, (match) => {
            return `${proxyBase}/?url=${encodeURIComponent(target.split('/').slice(0,3).join('/') + match)}`;
          });

        const headers = new Headers({
          "Content-Type": "application/vnd.apple.m3u8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD",
          "Access-Control-Allow-Headers": "Range",
          "Access-Control-Expose-Headers": "Content-Length"
        });

        return new Response(rewritten, { headers });
      } else {
        // Stream .ts segments and other binary
        const headers = new Headers({
          "Content-Type": response.headers.get("content-type") || "video/mp2t",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD",
          "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
          "Access-Control-Allow-Headers": "Range"
        });

        // Copy range/content headers
        ['content-length', 'content-range', 'accept-ranges'].forEach(name => {
          const value = response.headers.get(name);
          if (value) headers.set(name, value);
        });

        return new Response(response.body, {
          status: response.status,
          headers
        });
      }

    } catch (err) {
      return new Response("Proxy error: " + err.message, { status: 500 });
    }
  }
};


