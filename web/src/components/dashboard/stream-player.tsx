"use client";

import Hls from "hls.js";
import { AlertTriangle, RefreshCw, Tv2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Player as MpegtsPlayer } from "mpegts.js";

import { buildDirectLiveStreamUrl, getIptvProxyBases, proxyLiveStreamUrl } from "@/lib/stream-url";
import type { LiveChannel } from "@/lib/types";

type PlayerState = "idle" | "loading" | "playing" | "error";
type PlaybackKind = "hls" | "mpegts";

interface PlaybackStrategy {
  kind: PlaybackKind;
  label: string;
  url: string;
}

function isHlsUrl(url: string): boolean {
  return url.split("?")[0].toLowerCase().endsWith(".m3u8");
}

function canTryDirectUrl(url: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const parsed = new URL(url);
    return window.location.protocol !== "https:" || parsed.protocol === "https:";
  } catch {
    return true;
  }
}

function pushUnique(strategies: PlaybackStrategy[], strategy: PlaybackStrategy) {
  if (!strategy.url || strategies.some((item) => item.kind === strategy.kind && item.url === strategy.url)) {
    return;
  }

  strategies.push(strategy);
}

function buildPlaybackStrategies(streamUrl: string): PlaybackStrategy[] {
  const exactUrl = streamUrl.trim();
  const hlsUrl = buildDirectLiveStreamUrl(exactUrl, "m3u8");
  const tsUrl = buildDirectLiveStreamUrl(exactUrl, "ts");
  const proxyBases = getIptvProxyBases();
  const strategies: PlaybackStrategy[] = [];

  if (exactUrl && isHlsUrl(exactUrl) && canTryDirectUrl(exactUrl)) {
    pushUnique(strategies, {
      kind: "hls",
      label: "Direct HLS",
      url: exactUrl,
    });
  }

  for (const proxyBase of proxyBases) {
    if (exactUrl && isHlsUrl(exactUrl)) {
      pushUnique(strategies, {
        kind: "hls",
        label: "Proxy HLS",
        url: proxyLiveStreamUrl(exactUrl, proxyBase),
      });
    }
  }

  if (hlsUrl && hlsUrl !== exactUrl && canTryDirectUrl(hlsUrl)) {
    pushUnique(strategies, {
      kind: "hls",
      label: "Direct HLS",
      url: hlsUrl,
    });
  }

  for (const proxyBase of proxyBases) {
    if (hlsUrl) {
      pushUnique(strategies, {
        kind: "hls",
        label: "Proxy HLS",
        url: proxyLiveStreamUrl(hlsUrl, proxyBase),
      });
    }
  }

  if (tsUrl && tsUrl !== hlsUrl) {
    for (const proxyBase of proxyBases) {
      pushUnique(strategies, {
        kind: "mpegts",
        label: "Proxy MPEG-TS",
        url: proxyLiveStreamUrl(tsUrl, proxyBase),
      });
    }

    if (canTryDirectUrl(tsUrl)) {
      pushUnique(strategies, {
        kind: "mpegts",
        label: "Direct MPEG-TS",
        url: tsUrl,
      });
    }
  }

  if (strategies.length === 0 && exactUrl) {
    pushUnique(strategies, {
      kind: isHlsUrl(exactUrl) ? "hls" : "mpegts",
      label: "Direct stream",
      url: exactUrl,
    });
  }

  return strategies;
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function StreamPlayer({ channel }: { channel: LiveChannel | null }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<MpegtsPlayer | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState>("idle");
  const [message, setMessage] = useState("Select a channel to start playback.");
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !channel) {
      setPlayerState("idle");
      setMessage("Select a channel to start playback.");
      return;
    }

    const currentVideo = video;
    const strategies = buildPlaybackStrategies(channel.streamUrl);
    const errors: string[] = [];
    let activeStrategyIndex = 0;
    let cancelled = false;
    let loadTimeoutId: number | null = null;
    let stalledTimeoutId: number | null = null;
    let recoveredMediaError = false;
    let suppressVideoErrors = false;

    function clearLoadTimeout() {
      if (loadTimeoutId !== null) {
        window.clearTimeout(loadTimeoutId);
        loadTimeoutId = null;
      }
    }

    function clearStalledTimeout() {
      if (stalledTimeoutId !== null) {
        window.clearTimeout(stalledTimeoutId);
        stalledTimeoutId = null;
      }
    }

    function destroyPlayers() {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      if (mpegtsRef.current) {
        mpegtsRef.current.unload();
        mpegtsRef.current.detachMediaElement();
        mpegtsRef.current.destroy();
        mpegtsRef.current = null;
      }
    }

    function resetVideo() {
      suppressVideoErrors = true;
      currentVideo.pause();
      currentVideo.removeAttribute("src");
      currentVideo.load();
      window.setTimeout(() => {
        suppressVideoErrors = false;
      }, 0);
    }

    function cleanup() {
      clearLoadTimeout();
      clearStalledTimeout();
      destroyPlayers();
      resetVideo();
    }

    function failPlayback(nextMessage: string) {
      if (cancelled) {
        return;
      }

      clearLoadTimeout();
      clearStalledTimeout();
      setPlayerState("error");
      setMessage(errors.length > 0 ? `${nextMessage} Last errors: ${errors.slice(-2).join(" | ")}` : nextMessage);
    }

    function startLoadTimer(strategy: PlaybackStrategy) {
      clearLoadTimeout();
      loadTimeoutId = window.setTimeout(() => {
        tryNextStrategy(`${strategy.label} timed out while loading.`);
      }, 18000);
    }

    function tryNextStrategy(reason: string) {
      if (cancelled) {
        return;
      }

      const currentStrategy = strategies[activeStrategyIndex];

      if (currentStrategy) {
        errors.push(`${currentStrategy.label}: ${reason}`);
      }

      const nextIndex = activeStrategyIndex + 1;

      if (nextIndex >= strategies.length) {
        failPlayback(reason);
        return;
      }

      void startStrategy(nextIndex, reason);
    }

    function startHls(strategy: PlaybackStrategy) {
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          liveDurationInfinity: true,
          liveSyncDurationCount: 4,
          liveMaxLatencyDurationCount: 9,
          maxBufferLength: 35,
          maxMaxBufferLength: 70,
          backBufferLength: 20,
          manifestLoadingMaxRetry: 1,
          levelLoadingMaxRetry: 1,
          fragLoadingMaxRetry: 2,
        });

        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled) {
            return;
          }

          setMessage("Live manifest loaded. Starting playback...");
          void currentVideo.play().catch((error: unknown) => {
            tryNextStrategy(describeError(error, "Unable to start HLS playback."));
          });
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || cancelled) {
            return;
          }

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMediaError) {
            recoveredMediaError = true;
            hls.recoverMediaError();
            return;
          }

          const responseCode = data.response?.code ? ` (${data.response.code})` : "";
          tryNextStrategy(`${data.details}${responseCode}`);
        });

        hls.loadSource(strategy.url);
        hls.attachMedia(currentVideo);
        return;
      }

      if (currentVideo.canPlayType("application/vnd.apple.mpegurl")) {
        currentVideo.src = strategy.url;
        void currentVideo.play().catch((error: unknown) => {
          tryNextStrategy(describeError(error, "Unable to start native HLS playback."));
        });
        return;
      }

      tryNextStrategy("This browser does not support HLS playback.");
    }

    async function startMpegTs(strategy: PlaybackStrategy) {
      try {
        const mpegts = (await import("mpegts.js")).default;

        if (cancelled) {
          return;
        }

        if (!mpegts.isSupported()) {
          tryNextStrategy("This browser does not support MPEG-TS playback.");
          return;
        }

        const player = mpegts.createPlayer(
          {
            type: "mpegts",
            isLive: true,
            url: strategy.url,
          },
          {
            enableWorker: true,
            enableStashBuffer: true,
            stashInitialSize: 512 * 1024,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 8,
            liveBufferLatencyMinLatency: 2,
            autoCleanupMaxBackwardDuration: 20,
            autoCleanupMaxForwardDuration: 45,
          },
        );

        mpegtsRef.current = player;

        player.on(mpegts.Events.ERROR, (type: unknown, detail: unknown) => {
          tryNextStrategy(`${String(type || "stream error")}: ${String(detail || "network error")}`);
        });

        player.attachMediaElement(currentVideo);
        player.load();
        void player.play().catch((error: unknown) => {
          tryNextStrategy(describeError(error, "Unable to start MPEG-TS playback."));
        });
      } catch (error) {
        tryNextStrategy(describeError(error, "Unable to load MPEG-TS player."));
      }
    }

    async function startStrategy(index: number, previousReason?: string) {
      const strategy = strategies[index];

      if (!strategy) {
        failPlayback("No playable stream URL was found for this channel.");
        return;
      }

      activeStrategyIndex = index;
      recoveredMediaError = false;
      cleanup();
      currentVideo.muted = true;
      currentVideo.autoplay = true;
      currentVideo.playsInline = true;
      setPlayerState("loading");
      setMessage(
        previousReason
          ? `${previousReason} Trying ${strategy.label}...`
          : `Loading ${strategy.label} live stream...`,
      );
      startLoadTimer(strategy);

      if (strategy.kind === "hls") {
        startHls(strategy);
        return;
      }

      await startMpegTs(strategy);
    }

    const onPlaying = () => {
      clearLoadTimeout();
      clearStalledTimeout();
      setPlayerState("playing");
      setMessage("Live stream connected.");
    };

    const onWaiting = () => {
      if (cancelled) {
        return;
      }

      setMessage("Buffering live stream...");
      clearStalledTimeout();
      stalledTimeoutId = window.setTimeout(() => {
        tryNextStrategy("buffering stalled");
      }, 12000);
    };

    const onTimeUpdate = () => {
      clearStalledTimeout();
    };

    const onEnded = () => {
      tryNextStrategy("stream ended");
    };

    const onError = () => {
      if (suppressVideoErrors) {
        return;
      }

      tryNextStrategy(currentVideo.error?.message || "video element error");
    };

    currentVideo.addEventListener("playing", onPlaying);
    currentVideo.addEventListener("waiting", onWaiting);
    currentVideo.addEventListener("timeupdate", onTimeUpdate);
    currentVideo.addEventListener("ended", onEnded);
    currentVideo.addEventListener("error", onError);

    void startStrategy(0);

    return () => {
      cancelled = true;
      currentVideo.removeEventListener("playing", onPlaying);
      currentVideo.removeEventListener("waiting", onWaiting);
      currentVideo.removeEventListener("timeupdate", onTimeUpdate);
      currentVideo.removeEventListener("ended", onEnded);
      currentVideo.removeEventListener("error", onError);
      cleanup();
    };
  }, [channel?.id, channel?.streamUrl, retryNonce]);

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
        <video ref={videoRef} className="player-video" autoPlay muted controls playsInline preload="auto" />

        {playerState === "loading" ? (
          <div className="player-overlay">
            <div className="player-overlay-card">
              <RefreshCw className="spin" size={28} />
              <div className="player-overlay-copy">
                <strong>Preparing live stream</strong>
                <p>{message}</p>
              </div>
            </div>
          </div>
        ) : null}

        {playerState === "error" ? (
          <div className="player-overlay">
            <div className="player-overlay-card player-error-card">
              <AlertTriangle size={30} />
              <div className="player-overlay-copy">
                <strong>Playback failed</strong>
                <p>{message}</p>
              </div>
              <button className="primary-button" onClick={() => setRetryNonce((value) => value + 1)} type="button">
                <RefreshCw size={16} />
                Retry stream
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="player-footer">
        <div className="player-current-info">
          <p className="player-active-meta">Now playing</p>
          <h3 className="player-active-title">{channel.name}</h3>
          <p className="player-active-copy">{message}</p>
        </div>
      </div>

      <style jsx>{`
        .livezone-player {
          border-radius: var(--radius-xl);
        }

        .player-error-card {
          border-color: rgba(255, 107, 95, 0.26);
          background:
            radial-gradient(circle at top, rgba(255, 107, 95, 0.12), transparent 42%),
            rgba(7, 13, 21, 0.9);
        }

        .player-error-card :global(svg) {
          color: var(--danger);
        }
      `}</style>
    </div>
  );
}
