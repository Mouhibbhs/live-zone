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
    <div className="standalone-player">
      <div className="standalone-video-shell">
        <video
          ref={videoRef}
          controls
          autoPlay
          muted
          playsInline
          className="standalone-video"
          poster="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgwIiBoZWlnaHQ9IjI3MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjMDAwIiBzdHJva2U9Im5vbmUiLz48L3N2Zz4="
        />
      </div>

      <div className="standalone-player-footer">
        <div className="standalone-player-row">
          <div className="standalone-player-copy">
            <h2>{title}</h2>
            <div className="standalone-player-stats">
              <span>Quality: <strong className="quality-value">{quality}</strong></span>
              <span>Buffer: <strong className="buffer-value">{formatBuffer(buffered)}</strong></span>
            </div>
            {error ? <p className="standalone-player-error">{error}</p> : null}
          </div>
          <div className="standalone-player-actions">
            <button onClick={() => videoRef.current?.play()} type="button">Play</button>
            <button onClick={() => videoRef.current?.pause()} type="button">Pause</button>
          </div>
        </div>
      </div>

      <style jsx>{`
        .standalone-player {
          width: 100%;
          max-width: 1200px;
          margin: 0 auto;
          overflow: hidden;
          border-radius: 12px;
          background: #0a0a0a;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
          font-family: system-ui, sans-serif;
        }

        .standalone-video-shell {
          position: relative;
          width: 100%;
          aspect-ratio: 16 / 9;
          overflow: hidden;
          background: #000;
        }

        .standalone-video {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: contain;
          background: #000;
        }

        .standalone-player-footer {
          padding: 1rem 1.5rem;
          background: #1a1a2e;
        }

        .standalone-player-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          min-width: 0;
        }

        .standalone-player-copy {
          min-width: 0;
        }

        .standalone-player-copy h2 {
          margin: 0;
          color: white;
          font-size: 1.2rem;
          line-height: 1.2;
          overflow-wrap: anywhere;
        }

        .standalone-player-stats {
          display: flex;
          flex-wrap: wrap;
          gap: 0.35rem 0.75rem;
          margin-top: 0.25rem;
          color: #a0a0b0;
          font-size: 0.85rem;
        }

        .quality-value {
          color: #00d9ff;
        }

        .buffer-value {
          color: #ffaa00;
        }

        .standalone-player-error {
          margin: 0.45rem 0 0;
          color: #ffb4ad;
          font-size: 0.85rem;
          overflow-wrap: anywhere;
        }

        .standalone-player-actions {
          display: flex;
          flex: 0 0 auto;
          gap: 0.5rem;
        }

        .standalone-player-actions button {
          min-height: 38px;
          padding: 0.5rem 1rem;
          border: 0;
          border-radius: 6px;
          background: #00d9ff;
          color: #000;
          cursor: pointer;
          font: inherit;
        }

        .standalone-player-actions button + button {
          background: #666;
          color: white;
        }

        @media (max-width: 560px) {
          .standalone-player-footer {
            padding: 0.85rem;
          }

          .standalone-player-row {
            align-items: stretch;
            flex-direction: column;
            gap: 0.85rem;
          }

          .standalone-player-copy h2 {
            font-size: 1.05rem;
          }

          .standalone-player-actions {
            display: grid;
            grid-template-columns: 1fr;
          }

          .standalone-player-actions button {
            width: 100%;
          }
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

