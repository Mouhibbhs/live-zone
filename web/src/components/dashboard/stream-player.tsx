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
  const lastDataTimestampRef = useRef<number>(Date.now());
  const [status, setStatus] = useState("Idle");
  const [playbackNonce, setPlaybackNonce] = useState(0);

  const updateLastDataTimestamp = () => {
    lastDataTimestampRef.current = Date.now();
  };

  // Hard reload for MPEG-TS (destroys and recreates player)
  const hardReloadMpegts = (reason: string) => {
    if (!videoRef.current || !currentStrategyRef.current) return false;
    if (loadingRef.current) return false;

    console.log(`[MPEG-TS] Hard reload: ${reason}`);
    setStatus(`Recovering: ${reason}`);
    loadingRef.current = true;

    // Destroy current MPEG-TS player
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
          
          // 🚀 OPTIMIZED CONFIGURATION FOR INFINITE LIVE STREAM
          const player = module.createPlayer(
            { type: "mse", url: url, isLive: true },
            {
              // Core live settings
              isLive: true,
              liveBufferLatencyChasing: true,   // aggressively follow live edge
              liveBufferLatencyMaxLatency: 8,    // max 8s behind live
              liveBufferLatencyMinRemain: 1.5,   // keep only 1.5s buffer
              
              // Buffer control – prevents chunk accumulation
              enableStashBuffer: true,
              stashInitialSize: 256 * 1024,      // 256KB initial stash
              ioBufferSize: 2 * 1024 * 1024,     // 2MB I/O buffer
              
              // Network & retry – never give up
              reuseRedirectedURL: false,         // always fetch fresh URL
              reconnectInterval: 2,              // retry every 2 sec
              reconnectDecay: 1.5,               // exponential backoff
              maxReconnectAttempts: Infinity,    // never stop trying
              
              // Cleanup to prevent memory bloat
              autoCleanupSourceBuffer: true,
              autoCleanupMaxBackwardDuration: 10, // keep only 10s behind
              autoCleanupMinBackwardDuration: 2,
              
              // Performance
              enableWorker: false,               // workers can cause stalls
              lazyLoad: false,                   // never pause loading
              statisticsInfoReportInterval: 1000,
            }
          );
          mpegtsRef.current = player;

          // Force video element to ignore 'ended'
          if (videoRef.current) {
            videoRef.current.onended = () => {
              console.warn("[MPEG-TS] video.onended – forcing reload");
              hardReloadMpegts("video ended");
            };
          }

          player.on(module.Events.ERROR, (...args: unknown[]) => {
            const errMsg = typeof args[1] === "string" ? args[1] : "mpegts error";
            console.warn("[MPEG-TS] Error:", errMsg);
            hardReloadMpegts(`error: ${errMsg}`);
          });

          player.on("ended", () => {
            console.warn("[MPEG-TS] player ended – reloading");
            hardReloadMpegts("player ended");
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
          setStatus("Live");
        })
        .catch(() => {
          loadingRef.current = false;
          setStatus("Reload failed");
        });
    }, 100);

    return true;
  };

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

    const scheduleRecovery = async (reason: string, skipCurrentStrategy = false) => {
      if (cancelled || reconnectTimerRef.current) return;

      if (skipCurrentStrategy && currentStrategyRef.current) {
        skippedStrategyUrlsRef.current.add(currentStrategyRef.current.url);
      }

      if (recoveryCountRef.current >= 10) {
        loadingRef.current = false;
        setStatus(`Playback failed: ${reason}`);
        return;
      }

      // Always use hard reload for MPEG-TS
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

        // 🚀 OPTIMIZED CONFIGURATION (same as hard reload)
        const player = lib.createPlayer(
          { type: "mse", url: strategy.url, isLive: true },
          {
            isLive: true,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 8,
            liveBufferLatencyMinRemain: 1.5,
            enableStashBuffer: true,
            stashInitialSize: 256 * 1024,
            ioBufferSize: 2 * 1024 * 1024,
            reuseRedirectedURL: false,
            reconnectInterval: 2,
            reconnectDecay: 1.5,
            maxReconnectAttempts: Infinity,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 10,
            autoCleanupMinBackwardDuration: 2,
            enableWorker: false,
            lazyLoad: false,
            statisticsInfoReportInterval: 1000,
          }
        );
        mpegtsRef.current = player;

        // Force video element to ignore 'ended'
        if (video) {
          video.onended = () => {
            console.warn("[MPEG-TS] video.onended – forcing reload");
            hardReloadMpegts("video ended");
          };
        }

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
        }, 20000);

        video.addEventListener("playing", settleSuccess, { once: true });
        video.addEventListener("canplay", settleSuccess, { once: true });
        video.addEventListener("loadeddata", settleSuccess, { once: true });

        player.on(lib.Events.ERROR, (...args: unknown[]) => {
          const detail = typeof args[1] === "string" ? args[1] : "mpegts error";
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
          console.warn("[MPEG-TS] player ended – reloading");
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
            setStatus(`${strategy.label} live`);
            updateLastDataTimestamp();
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

    // Data timeout monitor – if no data for 8 seconds, force reload
    const dataTimeoutInterval = setInterval(() => {
      if (cancelled || loadingRef.current) return;
      if (!video || video.paused) return;
      
      const now = Date.now();
      const timeSinceLastData = now - lastDataTimestampRef.current;
      if (timeSinceLastData > 8000 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        console.warn(`[MPEG-TS] No data for ${timeSinceLastData}ms → reload`);
        hardReloadMpegts("data timeout");
        updateLastDataTimestamp();
      }
    }, 4000);

    // Live edge monitor (playback rate tweak)
    const liveEdgeMonitor = setInterval(() => {
      if (!video || cancelled || video.paused || loadingRef.current) return;
      try {
        if (video.seekable.length > 0) {
          const liveEdge = video.seekable.end(0);
          const distance = liveEdge - video.currentTime;
          if (distance > 5) {
            video.currentTime = liveEdge - 2;
          } else if (distance < 1.5) {
            video.playbackRate = 1.0;
          } else {
            video.playbackRate = 0.98;
          }
        }
      } catch {}
    }, 3000);

    // Freeze detection (6 seconds)
    let lastCurrentTime = video.currentTime;
    const freezeMonitor = setInterval(() => {
      if (!video || cancelled || video.paused || loadingRef.current) {
        lastCurrentTime = video?.currentTime ?? 0;
        return;
      }
      if (video.currentTime === lastCurrentTime && video.currentTime !== 0) {
        hardReloadMpegts("freeze detected");
      }
      lastCurrentTime = video.currentTime;
    }, 6000);

    const onWaiting = () => {
      setTimeout(() => {
        if (!cancelled && video && !video.paused && video.readyState < 3) {
          hardReloadMpegts("waiting for data");
        }
      }, 10000);
    };

    const onEnded = () => {
      hardReloadMpegts("ended event");
    };

    const onVideoError = () => {
      hardReloadMpegts(video.error?.message || "video error");
    };

    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onVideoError);

    return () => {
      cancelled = true;
      clearInterval(forcePlayInterval);
      clearInterval(dataTimeoutInterval);
      clearInterval(liveEdgeMonitor);
      clearInterval(freezeMonitor);
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