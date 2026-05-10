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
    MEDIA_ATTACHED: string;
    METADATA_ARRIVED: string;
    SCRIPTDATA_ARRIVED: string;
    MEDIA_INFO: string;
    STATISTICS_INFO: string;
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

  proxyBases.forEach((proxyBase, index) => {
    strategies.push({
      kind: "mpegts",
      label: index === 0 ? "Proxy MPEG-TS" : `Proxy MPEG-TS fallback ${index}`,
      url: buildProxyUrl(proxyBase, directTs),
    });
  });
  
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

  // Force seek to live edge every few seconds
  const forceLiveEdge = (video: HTMLVideoElement) => {
    try {
      if (video.seekable.length > 0) {
        const liveEdge = video.seekable.end(video.seekable.length - 1);
        const distanceFromEdge = liveEdge - video.currentTime;
        
        // If we're more than 10 seconds behind live, jump to live edge
        if (distanceFromEdge > 10) {
          console.log(`[Player] Skipping from ${video.currentTime} to live edge ${liveEdge}`);
          video.currentTime = liveEdge - 2; // 2 seconds behind live
        }
        
        // If playback rate is negative or we're going backwards, fix it
        if (video.playbackRate < 0 || video.currentTime < 0) {
          video.currentTime = liveEdge - 2;
        }
      }
    } catch (e) {
      console.warn("[Player] Failed to seek to live edge", e);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    const channelKey = channel ? `${channel.id}:${channel.streamUrl}` : "";

    // Force play every 2 seconds (prevents autoplay blocks)
    const forcePlayInterval = window.setInterval(() => {
      if (!video || cancelled) return;
      if (video.paused && !loadingRef.current && video.readyState >= 2) {
        video.play().catch(() => {});
      }
    }, 2000);

    // Block spacebar pause
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
      clearReconnectTimer();
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

        // CRITICAL: Config to prevent looping and buffer issues
        const player = lib.createPlayer(
          { type: "mse", url: strategy.url, isLive: true },
          {
            isLive: true,
            enableWorker: false,           // Disable workers for better live sync
            enableStashBuffer: true,
            stashInitialSize: 512 * 1024,  // 512KB initial buffer (small)
            lazyLoad: false,               // Never pause loading
            reuseRedirectedURL: false,     // Always get fresh URL
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 5,   // Only keep 5 seconds behind
            autoCleanupMinBackwardDuration: 2,   // Keep at least 2 seconds
            liveBufferLatencyChasing: true,      // Aggressively chase live edge
            liveBufferLatencyMaxLatency: 4,      // Max 4 seconds behind live
            liveBufferLatencyMinRemain: 1,       // Keep only 1 second buffer
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
          
          // Force to live edge immediately after starting
          setTimeout(() => forceLiveEdge(video), 100);
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
          console.error("[MPEGTS] Error:", detail);
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

        player.on("ended", () => {
          console.warn("[MPEGTS] Stream ended - recovering");
          if (started && !cancelled) {
            scheduleRecovery("stream ended", false);
          }
        });

        player.attachMediaElement(video);
        player.load();
        void player.play().catch((err) => console.warn("Play failed", err));
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
          }
          return;
        } catch (err) {
          console.error(`Failed with ${strategy.label}:`, err);
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
        window.clearInterval(forcePlayInterval);
        window.removeEventListener("keydown", blockKeys);
        cleanup();
      };
    }

    void startPlayback();

    // Force live edge every 5 seconds (prevents falling behind and looping)
    const liveEdgeMonitor = window.setInterval(() => {
      if (!video || cancelled || video.paused || loadingRef.current) return;
      try {
        forceLiveEdge(video);
      } catch {}
    }, 5000);

    // Buffer monitor - clear buffer if it gets too large
    const bufferMonitor = window.setInterval(() => {
      if (!video || cancelled || loadingRef.current) return;
      try {
        if (video.buffered.length > 0) {
          const bufferedEnd = video.buffered.end(video.buffered.length - 1);
          const currentTime = video.currentTime;
          const bufferAhead = bufferedEnd - currentTime;
          
          // If buffer is larger than 15 seconds, we're accumulating too much
          if (bufferAhead > 15) {
            console.log(`[Player] Buffer too large (${bufferAhead}s), seeking to live edge`);
            forceLiveEdge(video);
          }
        }
      } catch {}
    }, 10000);

    // Simple freeze detection (every 10 seconds)
    let lastCurrentTime = video.currentTime;
    let freezeCount = 0;
    const freezeMonitor = window.setInterval(() => {
      if (!video || cancelled || video.paused || loadingRef.current) {
        lastCurrentTime = video?.currentTime ?? 0;
        freezeCount = 0;
        return;
      }
      
      if (video.currentTime === lastCurrentTime) {
        freezeCount++;
        if (freezeCount >= 3) { // Frozen for 30 seconds (3 * 10s)
          scheduleRecovery("stream frozen", false);
          freezeCount = 0;
        }
      } else {
        freezeCount = 0;
      }
      lastCurrentTime = video.currentTime;
    }, 10000);

    const onWaiting = () => {
      let waitingTimeout: NodeJS.Timeout;
      waitingTimeout = setTimeout(() => {
        if (!cancelled && video && !video.paused && video.readyState < 2) {
          scheduleRecovery("waiting for data", false);
        }
      }, 15000);
      
      video?.addEventListener("playing", () => clearTimeout(waitingTimeout), { once: true });
    };

    const onEnded = () => {
      scheduleRecovery("stream ended", false);
    };

    const onVideoError = () =>
      scheduleRecovery(video.error?.message || "video error", false);

    // Monitor timeupdate to detect backwards playback
    const onTimeUpdate = () => {
      if (!video || cancelled) return;
      // If current time goes backwards (looping), force to live edge
      if (video.currentTime < lastCurrentTime && video.currentTime > 0) {
        console.warn(`[Player] Detected rewinding from ${lastCurrentTime} to ${video.currentTime}`);
        forceLiveEdge(video);
      }
    };

    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onVideoError);
    video.addEventListener("timeupdate", onTimeUpdate);

    return () => {
      cancelled = true;
      window.clearInterval(forcePlayInterval);
      window.clearInterval(liveEdgeMonitor);
      window.clearInterval(bufferMonitor);
      window.clearInterval(freezeMonitor);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onVideoError);
      video.removeEventListener("timeupdate", onTimeUpdate);
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