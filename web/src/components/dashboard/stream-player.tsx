// StreamPlayer.tsx
"use client";

import { Radio, Tv2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { LiveChannel } from "@/lib/types";
import { getIptvProxyBases } from "@/lib/stream-url";

// -----------------------------------------------------------------------------
// Type definitions for mpegts.js
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
  Events: {
    ERROR: string;
  };
};

type Strategy = {
  kind: "mpegts";
  label: string;
  url: string;
};

// -----------------------------------------------------------------------------
// Utility functions
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

function buildDirectUrl(streamUrl: string, ext: "ts") {
  const trimmed = unwrapProxyUrl(streamUrl.trim());
  const match = trimmed.match(XTREAM_LIVE_STREAM_PATTERN);
  if (!match) return trimmed;
  return `${match[1]}.${ext}${match[2] ?? ""}`;
}

function buildProxyUrl(proxyBase: string, url: string) {
  return proxyBase ? `${proxyBase}?url=${encodeURIComponent(url)}` : "";
}

function buildStrategies(streamUrl: string, skippedUrls: Set<string> = new Set()): Strategy[] {
  const strategies: Strategy[] = [];
  const directTs = buildDirectUrl(streamUrl, "ts");
  const proxyBases = getIptvProxyBases();

  // Try proxy first (more reliable for CORS)
  proxyBases.forEach((proxyBase, index) => {
    strategies.push({
      kind: "mpegts",
      label: index === 0 ? "Proxy MPEG-TS" : `Proxy MPEG-TS fallback ${index}`,
      url: buildProxyUrl(proxyBase, directTs),
    });
  });
  
  // Direct as fallback
  strategies.push({ kind: "mpegts", label: "Direct MPEG-TS", url: directTs });

  const unique = strategies.filter(
    (item, idx, arr) => item.url && arr.findIndex((e) => e.url === item.url) === idx,
  );
  const available = unique.filter((s) => !skippedUrls.has(s.url));
  return available.length > 0 ? available : unique;
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
// Main Component
// -----------------------------------------------------------------------------
export function StreamPlayer({ channel }: { channel: LiveChannel | null }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mpegtsRef = useRef<MpegtsPlayer | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const recoveryCountRef = useRef(0);
  const loadingRef = useRef(false);
  const currentStrategyRef = useRef<Strategy | null>(null);
  const skippedStrategyUrlsRef = useRef<Set<string>>(new Set());
  const lastChannelKeyRef = useRef("");
  const [status, setStatus] = useState("Idle");
  const [playbackNonce, setPlaybackNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    const channelKey = channel ? `${channel.id}:${channel.streamUrl}` : "";

    // Always-on playback (infinity loop)
    const forcePlayInterval = window.setInterval(() => {
      if (!video || cancelled) return;
      if (video.paused && !loadingRef.current) {
        video.play().catch(() => {});
      }
    }, 200);

    // Block spacebar pause when video is focused
    const blockKeys = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === video) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", blockKeys);

    // Reset state when channel changes
    if (channelKey !== lastChannelKeyRef.current) {
      lastChannelKeyRef.current = channelKey;
      recoveryCountRef.current = 0;
      skippedStrategyUrlsRef.current = new Set();
    }

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleRecovery = (reason: string, skipCurrentStrategy = false) => {
      if (cancelled || reconnectTimerRef.current) return;

      if (skipCurrentStrategy && currentStrategyRef.current) {
        skippedStrategyUrlsRef.current.add(currentStrategyRef.current.url);
      }

      if (recoveryCountRef.current >= 10) {
        loadingRef.current = false;
        setStatus(`Playback failed: ${reason}`);
        return;
      }

      recoveryCountRef.current += 1;
      loadingRef.current = true;
      setStatus(`Recovering (${recoveryCountRef.current}/10): ${reason}`);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        setPlaybackNonce((v) => v + 1);
      }, 2000);
    };

    const cleanup = () => {
      clearReconnectTimer();
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
    };

    const tryMpegts = async (strategy: Strategy) => {
      if (!video) throw new Error("Video element not ready.");
      const lib = await loadMpegtsModule();
      if (!lib) throw new Error("mpegts.js not available.");

      cleanup();
      setStatus(`Trying ${strategy.label}...`);

      return new Promise<void>((resolve, reject) => {
        let started = false;
        let settled = false;

        // SIMPLE, RELIABLE CONFIGURATION (no aggressive timeouts)
        const player = lib.createPlayer(
          { type: "mse", url: strategy.url, isLive: true },
          {
            isLive: true,
            enableWorker: true,
            enableStashBuffer: true,
            stashInitialSize: 1024 * 1024, // 1MB
            lazyLoad: false,
            reuseRedirectedURL: true,
          }
        );
        mpegtsRef.current = player;

        const settleSuccess = () => {
          if (settled) return;
          settled = true;
          started = true;
          clearTimeout(timeoutId);
          video.removeEventListener("playing", settleSuccess);
          video.removeEventListener("canplay", settleSuccess);
          video.removeEventListener("loadeddata", settleSuccess);
          resolve();
        };

        const timeoutId = window.setTimeout(() => {
          if (
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ||
            video.buffered.length > 0
          ) {
            settleSuccess();
            return;
          }
          reject(new Error(`${strategy.label} timed out`));
        }, 30000);

        video.addEventListener("playing", settleSuccess, { once: true });
        video.addEventListener("canplay", settleSuccess, { once: true });
        video.addEventListener("loadeddata", settleSuccess, { once: true });

        player.on(lib.Events.ERROR, (...args: unknown[]) => {
          const detail = typeof args[1] === "string" ? args[1] : "mpegts error";
          if (started) {
            scheduleRecovery(detail, false);
            return;
          }
          clearTimeout(timeoutId);
          video.removeEventListener("playing", settleSuccess);
          video.removeEventListener("canplay", settleSuccess);
          video.removeEventListener("loadeddata", settleSuccess);
          reject(new Error(`${strategy.label} failed: ${detail}`));
        });

        // Seamless reload when stream ends
        player.on("ended", () => {
          if (started && !cancelled) {
            console.log("[MPEG-TS] Stream ended, reloading...");
            scheduleRecovery("stream ended", false);
          }
        });

        player.attachMediaElement(video);
        player.load();
        void player.play().catch(() => {});
      });
    };

    const startPlayback = async () => {
      if (!video || !channel) return;
      loadingRef.current = true;
      setStatus("Preparing stream...");

      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;

      const strategies = buildStrategies(
        channel.streamUrl,
        skippedStrategyUrlsRef.current,
      );
      let lastError = "No playable stream source found.";

      for (const strategy of strategies) {
        if (cancelled) return;
        try {
          currentStrategyRef.current = strategy;
          await tryMpegts(strategy);
          if (!cancelled) {
            loadingRef.current = false;
            recoveryCountRef.current = 0;
            setStatus(`${strategy.label} connected`);
          }
          return;
        } catch (err) {
          skippedStrategyUrlsRef.current.add(strategy.url);
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (!cancelled) {
        loadingRef.current = false;
        setStatus(`Playback failed: ${lastError}`);
      }
    };

    if (!channel || !video) {
      cleanup();
      return () => {
        cancelled = true;
        cleanup();
      };
    }

    void startPlayback();

    // Live edge monitor (gentle playback rate adjustment)
    const liveEdgeMonitor = window.setInterval(() => {
      if (!video || cancelled || video.paused || loadingRef.current) return;
      try {
        if (video.seekable.length > 0) {
          const liveEdge = video.seekable.end(0);
          const distance = liveEdge - video.currentTime;
          // Only adjust if we're too far behind or ahead
          if (distance > 10) {
            video.currentTime = liveEdge - 5;
          } else if (distance < 2) {
            video.playbackRate = 1.0;
          } else if (distance > 8) {
            video.playbackRate = 1.02;
          } else if (distance < 3) {
            video.playbackRate = 0.98;
          } else {
            video.playbackRate = 1.0;
          }
        }
      } catch {}
    }, 10000); // Check every 10 seconds (not aggressively)

    // Freeze detection (only check every 15 seconds)
    let lastCurrentTime = video.currentTime;
    let lastTimeChange = Date.now();
    const freezeMonitor = window.setInterval(() => {
      if (!video || cancelled || video.paused || loadingRef.current) {
        lastCurrentTime = video?.currentTime ?? 0;
        lastTimeChange = Date.now();
        return;
      }
      
      const now = Date.now();
      if (video.currentTime === lastCurrentTime) {
        // If frozen for more than 15 seconds
        if (now - lastTimeChange > 15000) {
          scheduleRecovery("stream frozen", false);
          lastTimeChange = now;
        }
      } else {
        lastTimeChange = now;
      }
      lastCurrentTime = video.currentTime;
    }, 5000); // Check every 5 seconds

    const onWaiting = () => {
      window.setTimeout(() => {
        if (
          !cancelled &&
          video &&
          !video.paused &&
          video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
        ) {
          scheduleRecovery("waiting for data", false);
        }
      }, 30000); // Wait 30 seconds before triggering recovery
    };

    const onEnded = () => {
      scheduleRecovery("stream ended", false);
    };

    const onVideoError = () =>
      scheduleRecovery(video.error?.message || "video error", false);

    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onVideoError);

    return () => {
      cancelled = true;
      window.clearInterval(forcePlayInterval);
      window.clearInterval(liveEdgeMonitor);
      window.clearInterval(freezeMonitor);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onVideoError);
      window.removeEventListener("keydown", blockKeys);
      cleanup();
    };
  }, [channel?.id, channel?.streamUrl, playbackNonce]);

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
          Autoplay muted. Use controls for sound.
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