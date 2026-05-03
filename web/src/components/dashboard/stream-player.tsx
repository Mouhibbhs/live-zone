"use client";

import { Tv2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

import type { LiveChannel } from "@/lib/types";
import { getIptvProxyBase } from "@/lib/stream-url";

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
  Events: {
    ERROR: string;
  };
};

type Strategy = {
  kind: "hls" | "mpegts";
  label: string;
  url: string;
};

const XTREAM_LIVE_STREAM_PATTERN =
  /^(https?:\/\/.+\/live\/[^/]+\/[^/]+\/[^/.?]+)(?:\.(?:m3u8|ts|m2ts|flv))?(\?.*)?$/i;

function buildDirectUrl(streamUrl: string, ext: "m3u8" | "ts") {
  const trimmed = streamUrl.trim();
  const match = trimmed.match(XTREAM_LIVE_STREAM_PATTERN);

  if (!match) {
    return trimmed;
  }

  return `${match[1]}.${ext}${match[2] ?? ""}`;
}

function buildProxyUrl(url: string) {
  const proxyBase = getIptvProxyBase();
  return proxyBase ? `${proxyBase}?url=${encodeURIComponent(url)}` : "";
}

function buildStrategies(streamUrl: string): Strategy[] {
  const directHls = buildDirectUrl(streamUrl, "m3u8");
  const directTs = buildDirectUrl(streamUrl, "ts");
  const proxyHls = buildProxyUrl(directHls);
  const proxyTs = buildProxyUrl(directTs);

  const strategies: Strategy[] = [];

  if (proxyHls) {
    strategies.push({ kind: "hls", label: "Proxy HLS", url: proxyHls });
  }

  strategies.push({ kind: "hls", label: "Direct HLS", url: directHls });

  if (proxyTs) {
    strategies.push({ kind: "mpegts", label: "Proxy MPEG-TS", url: proxyTs });
  }

  strategies.push({ kind: "mpegts", label: "Direct MPEG-TS", url: directTs });

  return strategies.filter((item, index, array) => item.url && array.findIndex((entry) => entry.url === item.url) === index);
}

async function loadMpegtsModule(): Promise<MpegtsModule | null> {
  try {
    const module = await import("mpegts.js");
    const lib = (module.default ?? module) as unknown as MpegtsModule;
    return lib.isSupported() ? lib : null;
  } catch {
    return null;
  }
}

export function StreamPlayer({ channel }: { channel: LiveChannel | null }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<MpegtsPlayer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Idle");

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;

    function cleanup() {
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

      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    }

    async function tryHls(strategy: Strategy) {
      if (!video) {
        throw new Error("Video element not ready.");
      }

      cleanup();
      setStatus(`Trying ${strategy.label}...`);

      await new Promise<void>((resolve, reject) => {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 6,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 90,
          liveDurationInfinity: true,
          abrEwmaFastLive: 3,
          abrEwmaSlowLive: 9,
        });

        hlsRef.current = hls;

        const timeoutId = window.setTimeout(() => {
          reject(new Error(`${strategy.label} timed out.`));
        }, 12000);

        const onPlaying = () => {
          window.clearTimeout(timeoutId);
          video.removeEventListener("playing", onPlaying);
          resolve();
        };

        video.addEventListener("playing", onPlaying, { once: true });

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          void video.play().catch(() => undefined);
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            window.clearTimeout(timeoutId);
            video.removeEventListener("playing", onPlaying);
            reject(new Error(`${strategy.label} failed: ${data.details}`));
          }
        });

        hls.loadSource(strategy.url);
        hls.attachMedia(video);
      });
    }

    async function tryMpegts(strategy: Strategy) {
      if (!video) {
        throw new Error("Video element not ready.");
      }

      const lib = await loadMpegtsModule();

      if (!lib) {
        throw new Error("mpegts.js is not available in this browser.");
      }

      cleanup();
      setStatus(`Trying ${strategy.label}...`);

      await new Promise<void>((resolve, reject) => {
        const player = lib.createPlayer(
          {
            type: "mse",
            url: strategy.url,
            isLive: true,
          },
          {
            enableWorker: true,
            enableStashBuffer: true,
            stashInitialSize: 1024,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 15,
            liveBufferLatencyMinLatency: 4,
          },
        );

        mpegtsRef.current = player;

        const timeoutId = window.setTimeout(() => {
          reject(new Error(`${strategy.label} timed out.`));
        }, 12000);

        const onPlaying = () => {
          window.clearTimeout(timeoutId);
          video.removeEventListener("playing", onPlaying);
          resolve();
        };

        video.addEventListener("playing", onPlaying, { once: true });

        player.on(lib.Events.ERROR, (...args: unknown[]) => {
          const detail = typeof args[1] === "string" ? args[1] : "mpegts error";
          window.clearTimeout(timeoutId);
          video.removeEventListener("playing", onPlaying);
          reject(new Error(`${strategy.label} failed: ${detail}`));
        });

        player.attachMediaElement(video);
        player.load();
        void player.play().catch(() => undefined);
      });
    }

    async function startPlayback() {
      if (!video || !channel) {
        return;
      }

      setLoading(true);
      setError(null);
      setStatus("Preparing stream...");

      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;

      const strategies = buildStrategies(channel.streamUrl);
      let lastError = "No playable stream source was found.";

      for (const strategy of strategies) {
        if (cancelled) {
          return;
        }

        try {
          if (strategy.kind === "hls") {
            await tryHls(strategy);
          } else {
            await tryMpegts(strategy);
          }

          if (!cancelled) {
            setLoading(false);
            setError(null);
            setStatus(`${strategy.label} connected`);
          }
          return;
        } catch (attemptError) {
          lastError = attemptError instanceof Error ? attemptError.message : String(attemptError);
        }
      }

      if (!cancelled) {
        setLoading(false);
        setError(lastError);
        setStatus("Playback failed");
      }
    }

    if (!channel || !video) {
      cleanup();
      return () => {
        cancelled = true;
        cleanup();
      };
    }

    void startPlayback();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [channel]);

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
    <div className="hls-player">
      <div className="player-container">
        <video ref={videoRef} className="player-video" autoPlay muted controls playsInline preload="metadata" />
        {loading ? (
          <div className="error-overlay">
            <div className="error-content">
              <h4>Loading stream</h4>
              <p>{status}</p>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="error-overlay">
            <div className="error-content">
              <h4>Stream Error</h4>
              <p>{error}</p>
              <p>{status}</p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="player-info">
        <div className="channel-title">{channel.name}</div>
        <div className="player-stats">
          <span>{status}</span>
        </div>
      </div>

      <style jsx>{`
        .hls-player {
          width: 100%;
          max-width: 100%;
          background: #000;
          border-radius: 12px;
          overflow: hidden;
          font-family: system-ui, sans-serif;
        }

        .player-container {
          position: relative;
          aspect-ratio: 16 / 9;
          background: #000;
        }

        .player-video {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }

        .error-overlay {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.82);
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          z-index: 10;
        }

        .error-content {
          text-align: center;
          padding: 2rem;
          max-width: 32rem;
        }

        .player-info {
          padding: 1rem;
          background: #1a1a1a;
          color: white;
        }

        .channel-title {
          font-weight: bold;
          margin: 0 0 0.5rem 0;
          font-size: 1.1rem;
        }

        .player-stats {
          display: flex;
          gap: 1rem;
          font-size: 0.85rem;
          color: #aaa;
        }
      `}</style>
    </div>
  );
}
