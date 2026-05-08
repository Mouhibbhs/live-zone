// StreamPlayer.tsx
"use client";

import { Radio, Tv2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { LiveChannel } from "@/lib/types";
import { getIptvProxyBases } from "@/lib/stream-url";

// -----------------------------------------------------------------------------
// Type definitions for JSMpeg (loaded as a browser script)
// -----------------------------------------------------------------------------
type JSMpegPlayer = {
  play(): void;
  pause(): void;
  stop(): void;
  destroy(): void;
  paused: boolean;
  currentTime: number;
  volume: number;
};

type JSMpegOptions = {
  canvas: HTMLCanvasElement;
  autoplay?: boolean;
  loop?: boolean;
  audio?: boolean;
  video?: boolean;
  pauseWhenHidden?: boolean;
  progressive?: boolean;
  throttled?: boolean;
  videoBufferSize?: number;
  audioBufferSize?: number;
  onSourceEstablished?: () => void;
  onSourceCompleted?: () => void;
  onVideoDecode?: () => void;
  onStalled?: () => void;
  onEnded?: () => void;
};

type JSMpegModule = {
  Player: new (url: string, options: JSMpegOptions) => JSMpegPlayer;
};

type Strategy = {
  kind: "jsmpeg";
  label: string;
  url: string;
};

declare global {
  interface Window {
    JSMpeg?: JSMpegModule;
    __livezoneJSMpegLoader?: Promise<JSMpegModule>;
  }
}

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
  strategies.push({ kind: "jsmpeg", label: "Direct JSMpeg MPEG-TS", url: directTs });

  const proxyBases = getIptvProxyBases();
  proxyBases.forEach((proxyBase, index) => {
    strategies.push({
      kind: "jsmpeg",
      label: index === 0 ? "Proxy JSMpeg MPEG-TS" : `Proxy JSMpeg MPEG-TS fallback ${index}`,
      url: buildProxyUrl(proxyBase, directTs),
    });
  });

  const unique = strategies.filter(
    (item, idx, arr) => item.url && arr.findIndex((e) => e.url === item.url) === idx,
  );
  const available = unique.filter((s) => !skippedUrls.has(s.url));
  return available.length > 0 ? available : unique;
}

const JSMPEG_SCRIPT_URL = "https://cdn.jsdelivr.net/gh/phoboslab/jsmpeg@master/jsmpeg.min.js";

function loadJSMpegModule(): Promise<JSMpegModule> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("JSMpeg can only load in the browser."));
  }

  if (window.JSMpeg?.Player) {
    return Promise.resolve(window.JSMpeg);
  }

  if (!window.__livezoneJSMpegLoader) {
    window.__livezoneJSMpegLoader = new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${JSMPEG_SCRIPT_URL}"]`,
      );

      const handleLoad = () => {
        if (window.JSMpeg?.Player) {
          resolve(window.JSMpeg);
        } else {
          window.__livezoneJSMpegLoader = undefined;
          reject(new Error("JSMpeg loaded without exposing JSMpeg.Player."));
        }
      };

      if (existing) {
        if (existing.dataset.loaded === "true" || window.JSMpeg?.Player) {
          window.setTimeout(handleLoad, 0);
          return;
        }
        existing.addEventListener("load", handleLoad, { once: true });
        existing.addEventListener(
          "error",
          () => {
            window.__livezoneJSMpegLoader = undefined;
            reject(new Error("Failed to load JSMpeg."));
          },
          { once: true },
        );
        return;
      }

      const script = document.createElement("script");
      script.src = JSMPEG_SCRIPT_URL;
      script.async = true;
      script.onload = () => {
        script.dataset.loaded = "true";
        handleLoad();
      };
      script.onerror = () => {
        window.__livezoneJSMpegLoader = undefined;
        reject(new Error("Failed to load JSMpeg."));
      };
      document.head.appendChild(script);
    });
  }

  return window.__livezoneJSMpegLoader;
}

// -----------------------------------------------------------------------------
// Main Component
// -----------------------------------------------------------------------------
export function StreamPlayer({ channel }: { channel: LiveChannel | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const jsmpegRef = useRef<JSMpegPlayer | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const recoveryCountRef = useRef(0);
  const loadingRef = useRef(false);
  const currentStrategyRef = useRef<Strategy | null>(null);
  const skippedStrategyUrlsRef = useRef<Set<string>>(new Set());
  const lastChannelKeyRef = useRef("");
  const lastDecodedAtRef = useRef(0);
  const [status, setStatus] = useState("Idle");
  const [playbackNonce, setPlaybackNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    const channelKey = channel ? `${channel.id}:${channel.streamUrl}` : "";

    // Always-on playback loop for streams that briefly pause after stalls.
    const forcePlayInterval = window.setInterval(() => {
      const player = jsmpegRef.current;
      if (!player || cancelled || !player.paused) return;
      try {
        player.play();
      } catch {
        // JSMpeg may reject playback when the source is already gone; recovery handles it.
      }
    }, 500);

    if (channelKey !== lastChannelKeyRef.current) {
      lastChannelKeyRef.current = channelKey;
      recoveryCountRef.current = 0;
      skippedStrategyUrlsRef.current = new Set();
      lastDecodedAtRef.current = 0;
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
      if (jsmpegRef.current) {
        try {
          jsmpegRef.current.pause();
          jsmpegRef.current.destroy();
        } catch {}
        jsmpegRef.current = null;
      }
    };

    const tryJSMpeg = async (strategy: Strategy) => {
      if (!canvas) throw new Error("Canvas element not ready.");

      const lib = await loadJSMpegModule();

      cleanup();
      setStatus(`Trying ${strategy.label}...`);

      await new Promise<void>((resolve, reject) => {
        let started = false;
        let settled = false;
        let player: JSMpegPlayer | null = null;

        const settleSuccess = () => {
          if (settled) return;
          settled = true;
          started = true;
          lastDecodedAtRef.current = Date.now();
          window.clearTimeout(timeoutId);
          resolve();
        };

        const timeoutId = window.setTimeout(() => {
          reject(new Error(`${strategy.label} timed out.`));
        }, 30000);

        try {
          player = new lib.Player(strategy.url, {
            canvas,
            autoplay: true,
            loop: false,
            audio: true,
            video: true,
            pauseWhenHidden: false,
            progressive: true,
            throttled: false,
            videoBufferSize: 1024 * 1024 * 4,
            audioBufferSize: 1024 * 512,
            onSourceEstablished: () => {
              if (!settled) setStatus(`${strategy.label} source connected...`);
            },
            onVideoDecode: () => {
              lastDecodedAtRef.current = Date.now();
              settleSuccess();
            },
            onStalled: () => {
              if (started && !cancelled) scheduleRecovery("stream stalled", false);
            },
            onEnded: () => {
              if (started && !cancelled) scheduleRecovery("stream ended", false);
            },
            onSourceCompleted: () => {
              if (started && !cancelled) scheduleRecovery("source completed", false);
            },
          });
          player.volume = 1;
          jsmpegRef.current = player;
          player.play();
        } catch (error) {
          window.clearTimeout(timeoutId);
          reject(error);
        }
      });
    };

    const startPlayback = async () => {
      if (!canvas || !channel) return;
      loadingRef.current = true;
      setStatus("Preparing stream...");

      const strategies = buildStrategies(channel.streamUrl, skippedStrategyUrlsRef.current);
      let lastError = "No playable stream source found.";

      for (const strategy of strategies) {
        if (cancelled) return;
        try {
          currentStrategyRef.current = strategy;
          await tryJSMpeg(strategy);
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

    if (!channel || !canvas) {
      cleanup();
      return () => {
        cancelled = true;
        window.clearInterval(forcePlayInterval);
        cleanup();
      };
    }

    void startPlayback();

    // Freeze detection: JSMpeg renders to canvas, so decoded frames are the heartbeat.
    const freezeMonitor = window.setInterval(() => {
      if (cancelled || loadingRef.current || !jsmpegRef.current || lastDecodedAtRef.current === 0) {
        return;
      }
      if (Date.now() - lastDecodedAtRef.current > 15000) {
        scheduleRecovery("stream frozen", false);
      }
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(forcePlayInterval);
      window.clearInterval(freezeMonitor);
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
        <canvas ref={canvasRef} className="player-video" />
      </div>
      <div className="player-footer">
        <div className="player-current-info">
          <p className="player-active-meta">Now playing</p>
          <h3 className="player-active-title">{channel.name}</h3>
          <p className="player-active-copy">{status}</p>
        </div>
        <div className="player-controls-hint">
          <Radio size={16} />
          JSMpeg live canvas playback
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
