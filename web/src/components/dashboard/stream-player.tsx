// StreamPlayer.tsx
"use client";

import { Radio, Tv2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

import type { LiveChannel } from "@/lib/types";
import { getIptvProxyBases } from "@/lib/stream-url";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
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
    config?: Record<string, unknown>,
  ): MpegtsPlayer;
  isSupported(): boolean;
  Events: { ERROR: string };
};

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------
const XTREAM_LIVE_STREAM_PATTERN =
  /^(https?:\/\/.+\/live\/[^/]+\/[^/]+\/[^/.?]+)(?:\.(?:m3u8|ts|m2ts|flv))?(\?.*)?$/i;

function unwrapProxyUrl(streamUrl: string) {
  try {
    const parsed = new URL(streamUrl);
    return parsed.searchParams.get("url") || streamUrl;
  } catch {
    return streamUrl;
  }
}

function buildDirectUrl(streamUrl: string, ext: "m3u8" | "ts") {
  const trimmed = unwrapProxyUrl(streamUrl.trim());
  const match = trimmed.match(XTREAM_LIVE_STREAM_PATTERN);
  if (!match) return trimmed;
  return `${match[1]}.${ext}${match[2] ?? ""}`;
}

function buildProxyUrl(proxyBase: string, url: string) {
  return proxyBase ? `${proxyBase}?url=${encodeURIComponent(url)}` : "";
}

function getStreamUrl(streamUrl: string): string {
  const directTs = buildDirectUrl(streamUrl, "ts");
  const proxyBases = getIptvProxyBases();
  // Prefer proxy if available (handles CORS and keeps connection alive)
  if (proxyBases.length) {
    return buildProxyUrl(proxyBases[0], directTs);
  }
  return directTs;
}

async function loadMpegtsModule(): Promise<MpegtsModule | null> {
  try {
    const module = await import("mpegts.js");
    const lib = (module.default ?? module) as unknown as MpegtsModule;
    return lib.isSupported() ? lib : null;
  } catch {
    const globalLib = (window as unknown as { mpegts?: MpegtsModule }).mpegts;
    return globalLib?.isSupported() ? globalLib : null;
  }
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------
export function StreamPlayer({ channel }: { channel: LiveChannel | null }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<MpegtsPlayer | null>(null);
  const [status, setStatus] = useState("Idle");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!channel) return;

    let cancelled = false;
    const video = videoRef.current;
    if (!video) return;

    const proxyUrl = getStreamUrl(channel.streamUrl);
    console.log("[Player] Stream URL:", proxyUrl);

    const isHls = proxyUrl.includes(".m3u8") || proxyUrl.includes("mpegurl");

    const cleanup = () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (mpegtsRef.current) {
        try {
          mpegtsRef.current.pause();
          mpegtsRef.current.unload();
          mpegtsRef.current.destroy();
        } catch {}
        mpegtsRef.current = null;
      }
      video.pause();
      video.removeAttribute("src");
      video.load();
    };

    const startPlayer = async () => {
      cleanup();
      setStatus("Connecting...");

      try {
        if (isHls && Hls.isSupported()) {
          setStatus("Using HLS.js");
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            liveSyncDurationCount: 2,          // stay close to live edge
            liveMaxLatencyDurationCount: 6,
            maxBufferLength: 10,               // small buffer to avoid stale data
            maxMaxBufferLength: 20,
            manifestLoadingTimeOut: 15000,
            fragLoadingTimeOut: 20000,
            debug: false,
          });
          hlsRef.current = hls;
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) {
              console.error("[HLS] Fatal error:", data);
              setStatus("HLS error, retrying...");
              setRetryKey((k) => k + 1);
            }
          });
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setStatus("Live");
            video.play().catch((e) => console.warn("Autoplay blocked", e));
          });
          hls.loadSource(proxyUrl);
          hls.attachMedia(video);
        } else if (!isHls) {
          // Fallback to mpegts.js for raw TS streams
          const lib = await loadMpegtsModule();
          if (!lib) throw new Error("mpegts.js not supported");
          setStatus("Using MPEG-TS");
          const player = lib.createPlayer(
            { type: "mse", url: proxyUrl, isLive: true },
            {
              isLive: true,
              enableWorker: true,
              enableStashBuffer: true,
              stashInitialSize: 1024 * 1024,
              lazyLoad: false,
              liveBufferLatencyChasing: true,
              liveBufferLatencyMinRemain: 3,
              reuseRedirectedURL: true,
            }
          );
          mpegtsRef.current = player;
          player.on(lib.Events.ERROR, () => {
            setStatus("TS error, reconnecting...");
            setRetryKey((k) => k + 1);
          });
          player.on("ended", () => {
            setStatus("Stream ended, reconnecting...");
            setRetryKey((k) => k + 1);
          });
          player.attachMediaElement(video);
          player.load();
          player.play().catch((e) => console.warn("Autoplay blocked", e));
          setStatus("Live");
        } else {
          // Native HLS fallback (Safari)
          video.src = proxyUrl;
          video.load();
          video.play().catch(() => setStatus("Click to play"));
          setStatus("Live (native)");
        }
      } catch (err: any) {
        console.error("[Player] Init error:", err);
        setStatus(`Error: ${err.message}`);
      }
    };

    startPlayer();

    // Keep-alive: reload if stream freezes for >15 seconds
    let lastTime = 0;
    const interval = setInterval(() => {
      if (!video || cancelled) return;
      if (video.paused) return;
      if (video.currentTime === lastTime && video.currentTime > 0) {
        console.warn("[Player] Stream frozen, reloading...");
        setRetryKey((k) => k + 1);
      }
      lastTime = video.currentTime;
    }, 10000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      cleanup();
    };
  }, [channel?.id, channel?.streamUrl, retryKey]);

  if (!channel) {
    return (
      <div className="player-shell-empty">
        <div className="player-empty-state">
          <Tv2 size={64} />
          <h3>No Channel Selected</h3>
          <p>Select a channel from the sidebar</p>
        </div>
      </div>
    );
  }

  return (
    <div className="player-shell livezone-player">
      <div className="player-video-frame">
        <video
          ref={videoRef}
          className="player-video"
          autoPlay
          muted
          controls
          playsInline
          preload="metadata"
          controlsList="nopause noplaybackrate"
        />
      </div>
      <div className="player-footer">
        <div className="player-current-info">
          <p className="player-active-meta">Now playing</p>
          <h3 className="player-active-title">{channel.name}</h3>
          <p className="player-active-copy">{status}</p>
        </div>
        <div className="player-controls-hint">
          <Radio size={16} />
          {status.includes("Error") && (
            <button
              onClick={() => setRetryKey((k) => k + 1)}
              style={{
                background: "rgba(255,255,255,0.2)",
                border: "none",
                borderRadius: "4px",
                padding: "2px 8px",
                marginLeft: "8px",
                cursor: "pointer",
                color: "white",
              }}
            >
              Retry
            </button>
          )}
        </div>
      </div>
      <style jsx>{`
        .livezone-player {
          border-radius: var(--radius-xl);
        }
        .player-controls-hint {
          display: inline-flex;
          align-items: center;
          gap: 0.55rem;
        }
      `}</style>
    </div>
  );
}