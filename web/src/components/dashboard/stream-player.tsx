// StreamPlayer.tsx
"use client";

import { Radio, Tv2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { LiveChannel } from "@/lib/types";
import { getIptvProxyBases } from "@/lib/stream-url";

// Fake DVR constants
const DVR_WINDOW = 2 * 60 * 60; // 2 hours
const DVR_DELAY = 20; // stay 20s behind live edge

// -----------------------------------------------------------------------------
// Type definitions for mpegts.js (unchanged)
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
// Stream URL helpers (unchanged)
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

  // DVR session refs
  const playbackStartedAtRef = useRef(Date.now());
  const dvrDurationRef = useRef(DVR_WINDOW);

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    const channelKey = channel ? `${channel.id}:${channel.streamUrl}` : "";

    // ----- Fake DVR setup -----
    // Grab the real seekable getter for internal use later
    const realSeekableGetter = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "seekable",
    )?.get;

    // Helper to read real live edge (seconds)
    const getRealLiveEdge = (): number => {
      if (!video) return 0;
      try {
        const raw = realSeekableGetter?.call(video);
        if (raw && raw.length > 0) {
          return raw.end(raw.length - 1);
        }
      } catch {
        // fallback
      }
      return 0;
    };

    // Apply fake duration and seekable on the video element
    const applyFakeDvrProperties = () => {
      if (!video) return;
      try {
        Object.defineProperty(video, "duration", {
          get: () => dvrDurationRef.current,
          configurable: true,
        });
      } catch {}
      try {
        Object.defineProperty(video, "seekable", {
          get: () => ({
            length: 1,
            start: () => 0,
            end: () => dvrDurationRef.current,
          }),
          configurable: true,
        });
      } catch {}
    };

    // Increase dvrDurationRef over time (growing window)
    const durationGrowthInterval = window.setInterval(() => {
      if (!video || cancelled) return;
      const elapsed = (Date.now() - playbackStartedAtRef.current) / 1000;
      dvrDurationRef.current = elapsed + DVR_WINDOW;
    }, 1000);

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

    // Reset session on channel change
    if (channelKey !== lastChannelKeyRef.current) {
      lastChannelKeyRef.current = channelKey;
      recoveryCountRef.current = 0;
      skippedStrategyUrlsRef.current = new Set();
      playbackStartedAtRef.current = Date.now();
      dvrDurationRef.current = DVR_WINDOW;
    }

    // ---- Existing reconnect / soft reconnect ----
    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

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

    // ---- MPEGTS strategy runner ----
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
            stashInitialSize: 4096,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 150,
            liveBufferLatencyMinLatency: 30,
            ioBufferSize: 4194304,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 60,
            autoCleanupMinBackwardDuration: 30,
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
          // Apply fake DVR properties once the stream is running
          applyFakeDvrProperties();
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
        video.addEventListener("loadedmeta data", settleSuccess, { once: true });

        player.on(lib.Events.ERROR, (...args: unknown[]) => {
          const detail = typeof args[1] === "string" ? args[1] : "mpegts error";
          if (started) {
            if (!softReconnect()) scheduleRecovery(detail, false);
            return;
          }
          window.clearTimeout(timeoutId);
          video.removeEventListener("playing", settleSuccess);
          video.removeEventListener("canplay", settleSuccess);
          video.removeEventListener("loadedmeta data", settleSuccess);
          reject(new Error(`${strategy.label} failed: ${detail}`));
        });

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

    // ---- DVR Timeshift loop (replaces old live‑edge monitor) ----
    const dvrTimeshiftInterval = window.setInterval(() => {
      if (!video || cancelled || video.paused || loadingRef.current) return;
      const realLiveEdge = getRealLiveEdge();
      if (realLiveEdge <= 0) return;

      const targetPosition = realLiveEdge - DVR_DELAY;
      const drift = video.currentTime - targetPosition;

      // If we drifted too far ahead (too close to live edge), seek back
      if (drift > 3 || realLiveEdge - video.currentTime < DVR_DELAY - 2) {
        if (targetPosition > 0) {
          video.currentTime = targetPosition;
        }
      }
      // If we are behind, we can optionally nudge forward, but not required
    }, 3000);

    // ---- Freeze detection (unchanged) ----
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

    // Final cleanup
    return () => {
      cancelled = true;
      window.clearInterval(forcePlayInterval);
      window.clearInterval(dvrTimeshiftInterval);
      window.clearInterval(durationGrowthInterval);
      window.clearInterval(freezeMonitor);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onVideoError);
      video.removeEventListener("loadedmetadata", applyFakeDvrProperties);
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