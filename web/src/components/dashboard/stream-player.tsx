// StreamPlayer.tsx
"use client";

import { Radio, Tv2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { LiveChannel } from "@/lib/types";
import { getIptvProxyBases, isHlsPlaylistUrl } from "@/lib/stream-url";

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

  if (!match) {
    return trimmed;
  }

  return `${match[1]}.${ext}${match[2] ?? ""}`;
}

function buildProxyUrl(proxyBase: string, url: string) {
  return proxyBase ? `${proxyBase}?url=${encodeURIComponent(url)}` : "";
}

function shouldTryDirectPlayback(streamUrl: string): boolean {
  return isHlsPlaylistUrl(streamUrl);
}

function shouldTryContinuousMpegTs(): boolean {
  return true;
}

function buildStrategies(streamUrl: string, skippedUrls: Set<string> = new Set()): Strategy[] {
  const strategies: Strategy[] = [];

  // Direct MPEG‑TS strategy (always try the raw .ts URL).
  const directTs = buildDirectUrl(streamUrl, "ts");
  strategies.push({
    kind: "mpegts",
    label: "Direct MPEG-TS",
    url: directTs,
  });

  // Proxy MPEG‑TS strategies.
  const proxyBases = getIptvProxyBases();
  proxyBases.forEach((proxyBase, index) => {
    strategies.push({
      kind: "mpegts",
      label: index === 0 ? "Proxy MPEG-TS" : `Proxy MPEG-TS fallback ${index}`,
      url: buildProxyUrl(proxyBase, directTs),
    });
  });

  // Remove duplicates and any URLs that have been skipped.
  const uniqueStrategies = strategies.filter(
    (item, idx, arr) => item.url && arr.findIndex((e) => e.url === item.url) === idx,
  );
  const availableStrategies = uniqueStrategies.filter((s) => !skippedUrls.has(s.url));

  // Return the list (prefer non‑skipped strategies, fallback to all if none left).
  return availableStrategies.length > 0 ? availableStrategies : uniqueStrategies;
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
  const mpegtsRef = useRef<MpegtsPlayer | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const recoveryCountRef = useRef(0);
  const loadingRef = useRef(false);
  const currentStrategyRef = useRef<Strategy | null>(null);
  const skippedStrategyUrlsRef = useRef<Set<string>>(new Set());
  const lastChannelKeyRef = useRef("");
  const [status, setStatus] = useState<string>("Idle");
  const [playbackNonce, setPlaybackNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    const channelKey = channel ? `${channel.id}:${channel.streamUrl}` : "";

    // DVR TIMESHIFT CONFIGURATION
    const LIVE_DELAY = 20; // seconds behind live edge

    // FORCE INFINITE DURATION FOR LIVE STREAM
    const forceInfiniteDuration = () => {
      if (!video) return;
      try {
        Object.defineProperty(video, 'duration', {
          get: () => Infinity,
          configurable: true,
        });
      } catch (e) {
        // Silently fail if property can't be overridden
      }
    };

    if (video) {
      video.addEventListener('loadedmetadata', forceInfiniteDuration);
    }

    if (channelKey !== lastChannelKeyRef.current) {
      lastChannelKeyRef.current = channelKey;
      recoveryCountRef.current = 0;
      skippedStrategyUrlsRef.current = new Set();
    }

    function clearReconnectTimer() {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function softReconnect() {
      const player = mpegtsRef.current;
      if (!player || !video) return false;

      try {
        player.unload();
        player.load();
        void player.play().catch(() => undefined);
        return true;
      } catch {
        return false;
      }
    }

    function scheduleRecovery(reason: string, skipCurrentStrategy = false) {
      if (cancelled || reconnectTimerRef.current) {
        return;
      }

      // Only permanently skip strategy on hard failures, not transient stalls
      if (skipCurrentStrategy && currentStrategyRef.current) {
        skippedStrategyUrlsRef.current.add(currentStrategyRef.current.url);
      }

      if (recoveryCountRef.current >= 10) {
        loadingRef.current = false;
        setStatus(`Playback failed: ${reason}`);
        return;
      }

      // Try a soft reconnect first, only schedule a full recovery if it fails
      if (!skipCurrentStrategy && softReconnect()) {
        setStatus(`Reconnected: ${reason}`);
        return;
      }

      recoveryCountRef.current += 1;
      loadingRef.current = true;
      setStatus(`Recovering stream (${recoveryCountRef.current}/10): ${reason}`);

      // Longer delay before retry to let network settle
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        setPlaybackNonce((value) => value + 1);
      }, 2000);
    }

    function cleanup() {
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
        let started = false;
        let settled = false;
        const player = lib.createPlayer(
          {
            type: "mse",
            url: strategy.url,
            isLive: true,
          },
          {
            enableWorker: true,
            enableStashBuffer: true,
            stashInitialSize: 4096,

            // FIX: Much more tolerant latency window — stops aggressive live-edge chasing
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 90,
            liveBufferLatencyMinLatency: 20,

            // FIX: Larger IO buffer for absorbing IPTV jitter
            ioBufferSize: 4194304,

            // CONTINUOUS LIVE DVR — sliding window buffer management
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 30,
            autoCleanupMinBackwardDuration: 15,
          },
        );

        mpegtsRef.current = player;

        const settleSuccess = () => {
          if (settled) {
            return;
          }

          settled = true;
          started = true;
          window.clearTimeout(timeoutId);
          video.removeEventListener("playing", settleSuccess);
          video.removeEventListener("canplay", settleSuccess);
          video.removeEventListener("loadeddata", settleSuccess);
          resolve();
        };

        // FIX: Increased initial timeout
        const timeoutId = window.setTimeout(() => {
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || video.buffered.length > 0) {
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
            // Attempt soft reconnect; only fallback to full recovery if it fails
            if (!softReconnect()) {
              scheduleRecovery(detail, false);
            }
            return;
          }

          window.clearTimeout(timeoutId);
          video.removeEventListener("playing", settleSuccess);
          video.removeEventListener("canplay", settleSuccess);
          video.removeEventListener("loadeddata", settleSuccess);
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

      loadingRef.current = true;
      setStatus("Preparing stream...");

      video.muted = false;
      video.autoplay = true;
      video.playsInline = true;

      const strategies = buildStrategies(channel.streamUrl, skippedStrategyUrlsRef.current);
      let lastError = "No playable stream source was found.";

      for (const strategy of strategies) {
        if (cancelled) {
          return;
        }

        try {
          currentStrategyRef.current = strategy;
          await tryMpegts(strategy);

          if (!cancelled) {
            loadingRef.current = false;
            recoveryCountRef.current = 0; // FIX: Reset recovery count on successful connect
            setStatus(`${strategy.label} connected`);
          }
          return;
        } catch (attemptError) {
          skippedStrategyUrlsRef.current.add(strategy.url);
          lastError = attemptError instanceof Error ? attemptError.message : String(attemptError);
        }
      }

      if (!cancelled) {
        loadingRef.current = false;
        setStatus(`Playback failed: ${lastError}`);
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

    // SMART LIVE EDGE MONITOR — only adjusts when dangerously close to live edge
    const liveEdgeMonitorId = window.setInterval(() => {
      if (!video || cancelled || video.paused || loadingRef.current) return;

      try {
        if (video.seekable.length > 0) {
          const liveEdge = video.seekable.end(0);
          const distance = liveEdge - video.currentTime;

          // Only correct if dangerously close to live edge (less than 3 seconds)
          if (distance < 3) {
            // Use playback rate adjustment for smoother experience
            video.playbackRate = 0.97;
          } else {
            // Return to normal playback rate
            video.playbackRate = 1.0;
          }
        }
      } catch (e) {
        // Silently fail if seekable isn't available
      }
    }, 5000);

    const getBufferedAhead = () => {
      if (!video || video.buffered.length === 0) {
        return 0;
      }

      for (let index = 0; index < video.buffered.length; index += 1) {
        if (video.currentTime >= video.buffered.start(index) && video.currentTime <= video.buffered.end(index)) {
          return video.buffered.end(index) - video.currentTime;
        }
      }

      return 0;
    };

    let lastCurrentTime = video.currentTime;

    // Monitor for freeze detection — if currentTime doesn't change for ~8s, soft reconnect
    const freezeMonitorId = window.setInterval(() => {
      if (!video || cancelled || video.paused || loadingRef.current) {
        lastCurrentTime = video?.currentTime ?? 0;
        return;
      }

      if (video.currentTime === lastCurrentTime) {
        // Video appears frozen, try soft reconnect
        if (softReconnect()) {
          setStatus("Reconnected after freeze detection");
        } else {
          scheduleRecovery("stream frozen", false);
        }
      }

      lastCurrentTime = video.currentTime;
    }, 8000);

    const onWaiting = () => {
      window.setTimeout(() => {
        if (!cancelled && video && !video.paused && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
          // FIX: false = don't skip strategy just because of a waiting event
          scheduleRecovery("waiting for data", false);
        }
        // FIX: 25s timeout instead of 10s — IPTV streams legitimately pause before segments
      }, 25000);
    };

    const onEnded = () => {
      if (mpegtsRef.current) {
        // Attempt soft restart instead of full recovery
        if (!softReconnect()) {
          scheduleRecovery("stream ended", false);
        }
      } else {
        scheduleRecovery("stream ended", false);
      }
    };

    const onVideoError = () => scheduleRecovery(video.error?.message || "video error", false);

    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onVideoError);

    return () => {
      cancelled = true;
      window.clearInterval(liveEdgeMonitorId);
      window.clearInterval(freezeMonitorId);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onVideoError);
      if (video) {
        video.removeEventListener('loadedmetadata', forceInfiniteDuration);
      }
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
        <video ref={videoRef} className="player-video" autoPlay muted controls playsInline preload="metadata" />
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