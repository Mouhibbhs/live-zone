// StreamPlayer.tsx
"use client";

import { Radio, Tv2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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

type Strategy = {
  kind: "mpegts";
  label: string;
  url: string;
};

interface StreamPlayerProps {
  channel: LiveChannel | null;
  refreshStreamUrl?: () => Promise<string>;
}

// -----------------------------------------------------------------------------
// Helpers
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

  proxyBases.forEach((proxyBase, index) => {
    strategies.push({
      kind: "mpegts",
      label: index === 0 ? "Proxy MPEG-TS" : `Proxy MPEG-TS fallback ${index}`,
      url: buildProxyUrl(proxyBase, directTs),
    });
  });
  strategies.push({ kind: "mpegts", label: "Direct MPEG-TS", url: directTs });

  const unique = strategies.filter(
    (item, idx, arr) => item.url && arr.findIndex((e) => e.url === item.url) === idx
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
    const lib = (window as unknown as { mpegts?: MpegtsModule }).mpegts;
    return lib?.isSupported() ? lib : null;
  }
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------
export function StreamPlayer({ channel, refreshStreamUrl }: StreamPlayerProps) {
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
  const lastStreamUrlRef = useRef<string>("");

  // Monitor last received data timestamp for MPEG‑TS
  const lastDataTimestampRef = useRef<number>(Date.now());

  const updateLastDataTimestamp = () => {
    lastDataTimestampRef.current = Date.now();
  };

  // -------------------------------------------------------------------------
  // Hard reload for MPEG‑TS (destroys and recreates player)
  // -------------------------------------------------------------------------
  const hardReloadMpegts = (reason: string) => {
    if (!videoRef.current || !currentStrategyRef.current) return false;
    if (loadingRef.current) return false;

    console.log(`[MPEG-TS] Hard reload: ${reason}`);
    setStatus(`Recovering (hard): ${reason}`);
    loadingRef.current = true;

    // Destroy current MPEG‑TS player
    if (mpegtsRef.current) {
      try {
        mpegtsRef.current.pause();
        mpegtsRef.current.unload();
        mpegtsRef.current.destroy();
      } catch (e) {
        console.warn("Error destroying MPEG-TS player", e);
      }
      mpegtsRef.current = null;
    }

    // Reset video src to clear any pending state
    const video = videoRef.current;
    video.pause();
    video.removeAttribute("src");
    video.load();

    const url = currentStrategyRef.current.url;
    if (!url) return false;

    setTimeout(() => {
      if (!videoRef.current) {
        loadingRef.current = false;
        return;
      }
      loadMpegtsModule()
        .then((module) => {
          if (!module) {
            loadingRef.current = false;
            setStatus("mpegts.js not available");
            return;
          }
          const player = module.createPlayer(
            { type: "mse", url: url, isLive: true },
            {
              enableWorker: true,
              enableStashBuffer: true,
              stashInitialSize: 1024 * 1024 * 4,
              ioBufferSize: 1024 * 1024 * 16,
              isLive: true,
              liveBufferLatencyChasing: true,
              liveBufferLatencyMaxLatency: 30,
              liveBufferLatencyMinRemain: 5,
              lazyLoad: false,
              autoCleanupSourceBuffer: true,
              autoCleanupMaxBackwardDuration: 15,
              autoCleanupMinBackwardDuration: 5,
              reuseRedirectedURL: false,
              reconnectInterval: 5,
              statisticsInfoReportInterval: 600,
            }
          );
          mpegtsRef.current = player;

          player.on(module.Events.ERROR, (...args: unknown[]) => {
            const errMsg = typeof args[1] === "string" ? args[1] : "mpegts error";
            console.warn("[MPEG-TS] Error event:", errMsg);
            hardReloadMpegts(`error: ${errMsg}`);
          });

          player.on("ended", () => {
            console.warn("[MPEG-TS] Ended event");
            hardReloadMpegts("stream ended");
          });

          player.on("statistics_info", (stats: any) => {
            if (stats && stats.currentBytes) updateLastDataTimestamp();
          });

          if (videoRef.current) {
            player.attachMediaElement(videoRef.current);
            player.load();
            player.play().catch((err) => console.warn("play() failed", err));
          }
          loadingRef.current = false;
          setStatus("MPEG-TS hard reloaded");
        })
        .catch(() => {
          loadingRef.current = false;
          setStatus("Failed to reload mpegts.js");
        });
    }, 100);

    return true;
  };

  // -------------------------------------------------------------------------
  // Helper: force full restart using playbackNonce
  // -------------------------------------------------------------------------
  const scheduleFullReset = (reason: string, delayMs = 2000) => {
    if (reconnectTimerRef.current) return;
    setStatus(`Scheduling reset: ${reason}`);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      setPlaybackNonce((v) => v + 1);
    }, delayMs);
  };

  // -------------------------------------------------------------------------
  // Data timeout monitor (for MPEG‑TS)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!videoRef.current) return;
    const video = videoRef.current;

    const checkDataTimeout = () => {
      if (loadingRef.current) return;
      if (video.paused) return;
      if (currentStrategyRef.current?.kind !== "mpegts") return;

      const now = Date.now();
      const timeSinceLastData = now - lastDataTimestampRef.current;
      if (timeSinceLastData > 15000 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        console.warn(`[MPEG-TS] No data for ${timeSinceLastData}ms → hard reload`);
        hardReloadMpegts("data timeout");
        updateLastDataTimestamp(); // reset to avoid cascade
      }
    };

    const interval = window.setInterval(checkDataTimeout, 5000);
    return () => clearInterval(interval);
  }, []);

  // -------------------------------------------------------------------------
  // Main effect
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    const channelKey = channel ? `${channel.id}:${channel.streamUrl}` : "";

    const forcePlayInterval = window.setInterval(() => {
      if (!video || cancelled) return;
      if (video.paused) {
        video.play().catch(() => {});
      }
    }, 200);

    const blockKeys = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === video) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", blockKeys);

    if (channelKey !== lastChannelKeyRef.current) {
      lastChannelKeyRef.current = channelKey;
      recoveryCountRef.current = 0;
      skippedStrategyUrlsRef.current = new Set();
      if (channel?.streamUrl) lastStreamUrlRef.current = channel.streamUrl;
    }

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const tryRefreshStreamUrl = async (): Promise<string | null> => {
      if (!refreshStreamUrl) return null;
      try {
        const newUrl = await refreshStreamUrl();
        lastStreamUrlRef.current = newUrl;
        return newUrl;
      } catch {
        return null;
      }
    };

    const scheduleRecovery = async (reason: string, skipCurrentStrategy = false) => {
      if (cancelled || reconnectTimerRef.current) return;

      if (skipCurrentStrategy && currentStrategyRef.current) {
        skippedStrategyUrlsRef.current.add(currentStrategyRef.current.url);
      }

      if (recoveryCountRef.current >= 10) {
        if (refreshStreamUrl) {
          const newUrl = await tryRefreshStreamUrl();
          if (newUrl) {
            recoveryCountRef.current = 0;
            skippedStrategyUrlsRef.current.clear();
            loadingRef.current = true;
            setStatus("Token refreshed, retrying...");
            setPlaybackNonce((v) => v + 1);
            return;
          }
        }
        loadingRef.current = false;
        setStatus(`Playback failed: ${reason}`);
        return;
      }

      // Always use hard reload
      hardReloadMpegts(reason);
      recoveryCountRef.current += 1;
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
      updateLastDataTimestamp();

      return new Promise<void>((resolve, reject) => {
        let started = false;
        let settled = false;

        const player = lib.createPlayer(
          { type: "mse", url: strategy.url, isLive: true },
          {
            enableWorker: true,
            enableStashBuffer: true,
            stashInitialSize: 512* 1024,
            ioBufferSize: 1024 * 1024 * 4,
            isLive: true,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 10,
            liveBufferLatencyMinRemain: 2,
            lazyLoad: false,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 10,
            autoCleanupMinBackwardDuration: 2,
            reuseRedirectedURL: false,
            reconnectInterval: 2,
            statisticsInfoReportInterval: 600,
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
          const detail =
            typeof args[1] === "string"
              ? args[1]
              : typeof args[0] === "string"
                ? args[0]
                : "mpegts error";
          if (started) {
            hardReloadMpegts(detail);
            return;
          }
          clearTimeout(timeoutId);
          video.removeEventListener("playing", settleSuccess);
          video.removeEventListener("canplay", settleSuccess);
          video.removeEventListener("loadeddata", settleSuccess);
          reject(new Error(`${strategy.label} failed: ${detail}`));
        });

        player.on("ended", () => {
          if (started && !cancelled) {
            hardReloadMpegts("ended");
          }
        });

        player.on("statistics_info", (stats: any) => {
          if (stats && stats.currentBytes) updateLastDataTimestamp();
        });

        player.attachMediaElement(video);
        player.load();
        void player.play().catch(() => {});
      });
    };

    const startPlayback = async (streamUrl?: string) => {
      const url = streamUrl || channel?.streamUrl;
      if (!video || !url) return;

      lastStreamUrlRef.current = url;
      loadingRef.current = true;
      setStatus("Preparing stream...");

      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;

      const strategies = buildStrategies(url, skippedStrategyUrlsRef.current);
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
            updateLastDataTimestamp();
          }
          return;
        } catch (err) {
          skippedStrategyUrlsRef.current.add(strategy.url);
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (refreshStreamUrl) {
        const newUrl = await tryRefreshStreamUrl();
        if (newUrl) {
          skippedStrategyUrlsRef.current.clear();
          recoveryCountRef.current = 0;
          setStatus("Token refreshed, retrying...");
          return startPlayback(newUrl);
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
        window.clearInterval(forcePlayInterval);
        window.removeEventListener("keydown", blockKeys);
        cleanup();
      };
    }

    void startPlayback(lastStreamUrlRef.current);

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

    let lastCurrentTime = video.currentTime;
    const freezeMonitor = window.setInterval(() => {
      if (!video || cancelled || video.paused || loadingRef.current) {
        lastCurrentTime = video?.currentTime ?? 0;
        return;
      }
      if (video.currentTime === lastCurrentTime) {
        hardReloadMpegts("freeze detected");
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
        hardReloadMpegts("ended event");
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

    return () => {
      cancelled = true;
      clearInterval(forcePlayInterval);
      clearInterval(liveEdgeMonitor);
      clearInterval(freezeMonitor);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onVideoError);
      window.removeEventListener("keydown", blockKeys);
      cleanup();
    };
  }, [channel?.id, channel?.streamUrl, playbackNonce, refreshStreamUrl]);

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