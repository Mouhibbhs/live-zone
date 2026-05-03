"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { normalizeLiveStreamUrl } from "@/lib/stream-url";

interface PlayerProps {
  url?: string;
  title?: string;
}

export default function StandaloneIPTVPlayer({ url, title = "IPTV Stream" }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [buffered, setBuffered] = useState(0);
  const [quality, setQuality] = useState("HD");
  const hlsRef = useRef<Hls | null>(null);

  // Best buffering config for live IPTV
  const hlsConfig = {
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 120,      // 2min back buffer
    maxBufferLength: 90,        // 90s forward buffer
    maxMaxBufferLength: 180,    // Max 3min
    liveSyncDurationCount: 2,   // Tight sync
    liveMaxLatencyDurationCount: 4,
    maxLiveSyncPlaybackRate: 1.1,
    manifestLoadingMaxRetry: 6,
    levelLoadingMaxRetry: 6,
    fragLoadingMaxRetry: 6,
    startLevel: -1,             // Auto quality
    abrEwmaFastLive: 3.0,
    abrEwmaSlowLive: 8.0,
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;

    setError(null);
    setBuffered(0);
    const streamUrl = normalizeLiveStreamUrl(url, "m3u8");

    if (Hls.isSupported()) {
      const hls = new Hls(hlsConfig);
      hlsRef.current = hls;

      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      // Loading states
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch((e) => setError(e.message));
      });

      // Buffer monitoring - best buffering system
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        const bufferedDuration = video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0;
        setBuffered(Math.round(bufferedDuration));
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
        const height = hls.levels[data.level]?.height || 0;
        setQuality(height >= 1080 ? "4K" : height >= 720 ? "HD" : "SD");
      });

      // Robust error recovery
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              setError('Stream unavailable');
              hls.destroy();
          }
        }
      });

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native Safari HLS
      video.src = streamUrl;
      video.play().catch(setError);
    }
  }, [url]);

  const formatBuffer = (seconds: number) => {
    if (seconds > 60) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds)}s`;
  };

  return (
    <div className="standalone-player" style={{
      maxWidth: "1200px",
      margin: "0 auto",
      background: "#0a0a0a",
      borderRadius: "12px",
      overflow: "hidden",
      boxShadow: "0 20px 40px rgba(0,0,0,0.5)",
      fontFamily: "system-ui, sans-serif"
    }}>
      {/* Video Player */}
      <div style={{ position: "relative", aspectRatio: "16/9", background: "#000" }}>
        <video
          ref={videoRef}
          controls
          autoPlay
          muted
          playsInline
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
          poster="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgwIiBoZWlnaHQ9IjI3MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjMDAwIiBzdHJva2U9Im5vbmUiLz48L3N2Zz4="
        />
        
        {/* Error overlay */}
        {error && (
          <div style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.9)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "white",
            textAlign: "center",
            padding: "2rem"
          }}>
            <div>
              <h2 style={{ color: "#ff4444", marginBottom: "1rem" }}>Stream Error</h2>
              <p>{error}</p>
              <button 
                onClick={() => window.location.reload()}
                style={{
                  marginTop: "1rem",
                  padding: "0.75rem 1.5rem",
                  background: "#e94560",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer"
                }}
              >
                🔄 Retry Stream
              </button>
            </div>
          </div>
        )}

        {/* Live indicator */}
        <div style={{
          position: "absolute",
          top: "1rem",
          left: "1rem",
          background: "rgba(0,0,0,0.7)",
          padding: "0.5rem 1rem",
          borderRadius: "20px",
          color: "#00ff88",
          fontWeight: "bold",
          fontSize: "0.9rem",
          backdropFilter: "blur(10px)"
        }}>
          <span style={{ animation: "pulse 2s infinite" }}>● LIVE</span>
        </div>
      </div>

      {/* Controls & Stats */}
      <div style={{ padding: "1rem 1.5rem", background: "#1a1a2e" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <h2 style={{ margin: 0, color: "white", fontSize: "1.2rem" }}>{title}</h2>
            <div style={{ color: "#a0a0b0", fontSize: "0.85rem" }}>
              Quality: <span style={{ color: "#00d9ff", fontWeight: "bold" }}>{quality}</span> | 
              Buffer: <span style={{ color: "#ffaa00", fontWeight: "bold" }}>{formatBuffer(buffered)}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", fontSize: "0.85rem", color: "#a0a0b0" }}>
            <button onClick={() => videoRef.current?.play()} style={{ padding: "0.5rem 1rem", background: "#00d9ff", color: "#000", border: "none", borderRadius: "4px", cursor: "pointer" }}>▶ Play</button>
            <button onClick={() => videoRef.current?.pause()} style={{ padding: "0.5rem 1rem", background: "#666", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>⏸ Pause</button>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

// Export for URL param usage
export function StandalonePlayer() {
  const urlParams = new URLSearchParams(window.location.search);
  const url = urlParams.get('url');
  
  if (!url) {
    return (
      <div style={{ padding: "2rem", textAlign: "center", color: "white" }}>
        <h1>LiveZone IPTV Player</h1>
        <p>Use: <code>/player?url=http://your-stream.m3u8</code></p>
      </div>
    );
  }

  return <StandaloneIPTVPlayer url={decodeURIComponent(url)} title={urlParams.get('title') || 'Live Stream'} />;
}

