// StreamPlayer.tsx
"use client";

import { Radio, Tv2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { LiveChannel } from "@/lib/types";
import { getIptvProxyBases } from "@/lib/stream-url";

// -----------------------------------------------------------------------------
// Type definitions for mpegts.js (used by the dynamic import)
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
// Utility functions (unchanged)
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
  strategies.push({ kind: "mpegts", label: "Direct MPEG-TS", url: directTs });

  const proxyBases = getIptvProxyBases();
  proxyBases.forEach((proxyBase, index) => {
    strategies.push({
      kind: "mpegts",
      label: index === 0 ? "Proxy MPEG-TS" : `Proxy MPEG-TS fallback ${index}`,
      url: buildProxyUrl(proxyBase, directTs),
    });
  });

  const unique = strategies.filter(
    (item, idx, arr) => item.url && arr.findIndex((e) => e.url === item.url) === idx,
  );
  const available = unique.filter((s) => !skippedUrls.has(s.url));
  return available.length > 0 ? available : unique;
}

async function loadMpegtsModule(): Promise<MpegtsModule | null> {
  try {
    // If you want to use your local file instead, replace this with:
    // const lib = (window as any).mpegts; return lib?.isSupported() ? lib : null;
    const module = await import("mpegts.js");
    const lib = (module.default ?? module) as unknown as MpegtsModule;
    return lib.isSupported() ? lib : null;
  } catch {
    return null;
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

  // DVR delay (play 20s behind live edge)
  const LIVE_DELAY = 20;

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    const channelKey = channel ? `${channel.id}:${channel.streamUrl}` : "";


    // Always‑on playback (infinity loop)
    const forcePlayInterval = window.setInterval(() => {
      if (!video || cancelled) return;
      if (video.paused) {
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

    // Soft reconnect (unload → load → play) – never destroy
    const softReconnect = (): boolean => {
      const player = mpegtsRef.current;
      if (!player || !video) return false;
      try {
        player.unload();
        player.load();
        void player.play().catch(() => {});
        return true;
      } catch {
        return false;
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

      // Try soft reconnect first
      if (!skipCurrentStrategy && softReconnect()) {
        setStatus(`Reconnected: ${reason}`);
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

      await new Promise<void>((resolve, reject) => {
        let started = false;
        let settled = false;

        const player = lib.createPlayer(
          { type: "mse", url: strategy.url, isLive: true },
          {
            enableWorker: true,

            enableStashBuffer: true,
            stashInitialSize: 1024 * 1024 * 2 ,
            ioBufferSize: 1024 * 1024 * 8,

            isLive: true,

            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 1000000,
            liveBufferLatencyMinRemain: 1000000,

            lazyLoad: false,

            autoCleanupSourceBuffer: false,
            autoCleanupMaxBackwardDuration: 3,
            autoCleanupMinBackwardDuration: 1,

            reuseRedirectedURL: false,

            statisticsInfoReportInterval: 600,
          },
        );
        mpegtsRef.current = player;

        const settleSuccess = () => {
          if (settled) return;
          settled = true;
          started = true;
          window.clearTimeout(timeoutId);
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
          reject(new Error(`${strategy.label} timed out.`));
        }, 30000);

        video.addEventListener("playing", settleSuccess, { once: true });
        video.addEventListener("canplay", settleSuccess, { once: true });
        video.addEventListener("loadeddata", settleSuccess, { once: true });

        player.on(lib.Events.ERROR, (...args: unknown[]) => {
          const detail = typeof args[1] === "string" ? args[1] : "mpegts error";
          if (started) {
            if (!softReconnect()) scheduleRecovery(detail, false);
            return;
          }
          window.clearTimeout(timeoutId);
          video.removeEventListener("playing", settleSuccess);
          video.removeEventListener("canplay", settleSuccess);
          video.removeEventListener("loadeddata", settleSuccess);
          reject(new Error(`${strategy.label} failed: ${detail}`));
        });

        // Seamless reload when stream ends (MediaSource ended)
        player.on("ended", () => {
          if (started && !cancelled) softReconnect();
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

      video.muted = false;
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

    // Smart live‑edge monitor (playback rate tweak)
    const liveEdgeMonitor = window.setInterval(() => {
      if (!video || cancelled || video.paused || loadingRef.current) return;
      try {
        if (video.seekable.length > 0) {
          const liveEdge = video.seekable.end(0);
          const distance = liveEdge - video.currentTime;
          video.playbackRate = distance < 3 ? 0.97 : 1.0;
        }
      } catch {}
    }, 5000);

    // Freeze detection (8 seconds)
    let lastCurrentTime = video.currentTime;
    const freezeMonitor = window.setInterval(() => {
      if (!video || cancelled || video.paused || loadingRef.current) {
        lastCurrentTime = video?.currentTime ?? 0;
        return;
      }
      if (video.currentTime === lastCurrentTime) {
        if (!softReconnect()) scheduleRecovery("stream frozen", false);
      }
      lastCurrentTime = video.currentTime;
    }, 8000);

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
      }, 25000);
    };

    const onEnded = () => {
      if (mpegtsRef.current) {
        if (!softReconnect()) scheduleRecovery("stream ended", false);
      } else {
        scheduleRecovery("stream ended", false);
      }
    };

    const onVideoError = () =>
      scheduleRecovery(video.error?.message || "video error", false);

    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onVideoError);

    // --- Final cleanup on unmount / dependency change ---
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

  // --- UI (unchanged) ---
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