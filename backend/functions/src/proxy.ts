import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import fetch from "node-fetch";

export const proxy = onRequest(async (req, res) => {
  const streamUrl = req.query.url as string;
  
  if (!streamUrl) {
    res.status(400).send("Missing 'url' parameter");
    return;
  }
  
  try {
    logger.info(`Proxying stream: ${streamUrl}`);
    
    // Fetch stream headers first
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const streamRes = await fetch(streamUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LiveZone-Proxy/1.0)'
      }
    });
    clearTimeout(timeoutId);
    
    if (!streamRes.ok) {
      res.status(streamRes.status).send("Stream unavailable");
      return;
    }
    
    // Stream response
    const headers = {
      'Content-Type': streamRes.headers.get('content-type') || 'application/vnd.apple.m3u8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
    };
    
    // Copy relevant headers
    const contentHeaders: Record<string, string> = {};
    streamRes.headers.forEach((value: string, key: string) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey.match(/^(content-length|content-type|content-range)$/)) {
        contentHeaders[lowerKey] = value;
      }
    });
    Object.assign(headers, contentHeaders);
    
    res.set(headers);
    
    // Pipe stream
    streamRes.body?.pipe(res as NodeJS.WritableStream);
    
  } catch (error) {
    logger.error('Proxy error:', error);
    res.status(502).send("Stream proxy failed");
  }
});

