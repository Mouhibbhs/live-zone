// StreamPlayer.tsx - MPEG-TS focused player
"use client";

import { Radio, Tv2, AlertCircle } from "lucide-react";
import { useEffect, useRef, useState, useCallback } from "react";

import type { LiveChannel } from "@/lib/types";
import { 
  getMpegtsProxyUrl,
  isMpegTsUrl,
} from "@/lib/stream-url";

// Types for mpegts.js
type MpegtsPlayer = {
  attachMediaElement(mediaElement: HTMLMediaElement): void;
  load(): void;
  play(): Promise<void>;
  pause(): void;
  unload(): void;
  destroy(): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
};

type MpegtsModule = {
  createPlayer(
    dataSource: { type: string; url: string; isLive?: boolean },
    config?: Record<string, unknown>
  ): MpegtsPlayer;
  isSupported(): boolean;
  Events: { ERROR: string; MEDIA_INFO: string };
};

// Constants
const MAX_RETRY_DELAY = 15000;
const INITIAL_RETRY_DELAY = 1000;

// Load mpegts.js module
async function loadMpegtsModule(): Promise<MpegtsModule | null> {
  try {
    const module = await import("mpegts.js");
    const lib = (module.default ?? module) as unknown as MpegtsModule;
    return lib && typeof lib.isSupported === "function" && lib.isSupported() ? lib : null;
  } catch (err) {
    console.warn("[Player] Failed to load mpegts.js module", err);
    const globalLib = (window as unknown as { mpegts?: MpegtsModule }).mpegts;
    return globalLib && typeof globalLib.isSupported === "function" && globalLib.isSupported() ? globalLib : null;
  }
}

export function StreamPlayer({ channel }: { channel: LiveChannel | null }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mpegtsRef = useRef<MpegtsPlayer | null>(null);
  
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);

  const cleanup = useCallback(() => {
    if (mpegtsRef.current) {
      try {
        mpegtsRef.current.pause();
        mpegtsRef.current.unload();
        mpegtsRef.current.destroy();
      } catch (e) {
        console.warn("[Player] Cleanup error", e);
      }
      mpegtsRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }, []);

  const triggerRetry = useCallback(() => {
    const delay = Math.min(INITIAL_RETRY_DELAY * Math.pow(1.5, retryCount), MAX_RETRY_DELAY);
    console.log(`[Player] Retrying in ${Math.round(delay)}ms (attempt ${retryCount + 1})`);
    
    const timer = setTimeout(() => {
      setRetryCount(c => c + 1);
    }, delay);
    
    return () => clearTimeout(timer);
  }, [retryCount]);

  useEffect(() => {
    if (!channel) {
      cleanup();
      setStatus("Idle");
      setError(null);
      setRetryCount(0);
      return;
    }

    let cancelled = false;
    const video = videoRef.current;
    if (!video) return;

    // Get MPEG-TS proxy URL
    const proxyUrl = getMpegtsProxyUrl(channel.streamUrl);
    console.log(`[Player] Starting MPEG-TS stream: ${proxyUrl}`);

    const startPlayer = async () => {
      cleanup();
      setError(null);
      setIsBuffering(true);
      setStatus("Connecting...");

      try {
        setStatus("Initialising MPEG-TS player...");
        const lib = await loadMpegtsModule();
        
        if (!lib) {
          throw new Error("MPEG-TS playback not supported in this browser");
        }

        const player = lib.createPlayer(
          { type: "mse", url: proxyUrl, isLive: true },
          {
            isLive: true,
            enableWorker: true,
            enableStashBuffer: true,
            stashInitialSize: 128 * 1024,
            lazyLoad: false,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMinRemain: 2,
            autoCleanupMaxBackupDuration: 300,
            autoCleanupMinBackupDuration: 120,
            bufferingTimeout: 30000,
            flushing: true,
          }
        );
        
        mpegtsRef.current = player;
        
        player.on(lib.Events.ERROR, (type, detail) => {
          console.error("[TS] Player error:", type, detail);
          if (cancelled) return;
          
          const detailStr = String(detail || '');
          if (detailStr.includes('timeout') || detailStr.includes('network')) {
            console.warn("[TS] Network issue, retrying...");
            setStatus("Network error, retrying...");
            setIsBuffering(true);
          } else {
            setError(`Stream error: ${detail}`);
          }
          triggerRetry();
        });

        player.on(lib.Events.MEDIA_INFO, (mediaInfo) => {
          console.log("[TS] Media info:", mediaInfo);
        });

        player.attachMediaElement(video);
        player.load();
        
        player.play().catch(e => {
          console.warn("[Player] Playback blocked", e);
          setStatus("Paused (click to play)");
        });
        
        setStatus("Live");
        setIsBuffering(false);
      } catch (err: any) {
        console.error("[Player] Initialization failed:", err);
        if (!cancelled) {
          setError(err.message || "Player initialization failed");
          setStatus("Error");
          triggerRetry();
        }
      }
    };

    startPlayer();

    // Health check: Detect frozen streams
    let lastTime = 0;
    const checkInterval = setInterval(() => {
      if (!video || video.paused || cancelled || isBuffering) return;
      
      if (video.currentTime === lastTime && video.currentTime > 0) {
        console.warn("[Player] Stream frozen, triggering recovery");
        setError("Stream frozen");
        triggerRetry();
      }
      lastTime = video.currentTime;
    }, 12000);

    return () => {
      cancelled = true;
      clearInterval(checkInterval);
    };
  }, [channel?.id, channel?.streamUrl, retryCount, cleanup, triggerRetry]);

  if (!channel) {
    return (
      <div className="player-shell-empty">
        <div className="player-empty-state">
          <Tv2 size={64} strokeWidth={1.5} />
          <h3>No channel selected</h3>
          <p>Pick a stream from the drawer to begin playback</p>
        </div>
      </div>
    );
  }

  return (
    <div className="player-shell livezone-player">
      <div className="player-video-frame">
        {isBuffering && !error && (
          <div className="player-loading-overlay">
            <div className="loading-spinner" />
            <p>{status}</p>
          </div>
        )}
        
        {error && (
          <div className="player-error-overlay">
            <AlertCircle size={32} />
            <p>{error}</p>
            <span>Retrying shortly...</span>
          </div>
        )}

        <video
          ref={videoRef}
          className="player-video"
          autoPlay
          muted
          controls
          playsInline
          preload="auto"
          onWaiting={() => setIsBuffering(true)}
          onPlaying={() => {
            setIsBuffering(false);
            setError(null);
          }}
          controlsList="nodownload noremoteplayback"
        />
      </div>

      <div className="player-footer">
        <div className="player-current-info">
          <div className="player-status-tag">
            <span className={`status-dot ${status === "Live" ? "active" : ""}`} />
            {status}
          </div>
          <h3 className="player-active-title">{channel.name}</h3>
        </div>
        
        <div className="player-actions">
          <button 
            className="secondary-button icon-only" 
            onClick={() => setRetryCount(c => c + 1)}
            title="Refresh stream"
          >
            <Radio size={18} />
          </button>
        </div>
      </div>

      <style jsx>{`
        .livezone-player {
          background: #000;
          overflow: hidden;
          position: relative;
        }

        .player-video-frame {
          position: relative;
          aspect-ratio: 16 / 9;
          background: #000;
        }

        .player-video {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }

        .player-loading-overlay, .player-error-overlay {
          position: absolute;
          inset: 0;
          z-index: 10;
          background: rgba(0,0,0,0.7);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1rem;
          color: white;
          backdrop-filter: blur(4px);
        }

        .loading-spinner {
          width: 40px;
          height: 40px;
          border: 3px solid rgba(255,255,255,0.1);
          border-top-color: var(--primary, #00d9ff);
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .player-status-tag {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #a0a0b0;
          margin-bottom: 0.25rem;
        }

        .status-dot {
          width: 6px;
          height: 6px;
          background: #404050;
          border-radius: 50%;
        }

        .status-dot.active {
          background: #00ff88;
          box-shadow: 0 0 8px #00ff88;
        }

        .player-footer {
          padding: 1.25rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: linear-gradient(to bottom, #1a1a2e, #161625);
        }

        .player-active-title {
          margin: 0;
          font-size: 1.1rem;
          color: white;
        }

        .icon-only {
          padding: 0.5rem;
          border-radius: 50%;
        }
      `}</style>
    </div>
  );
}

