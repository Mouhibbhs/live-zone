"use client";

import { Radio, Tv2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getClapprSourceCandidates } from "@/lib/stream-url";
import type { LiveChannel } from "@/lib/types";

type ClapprEvents = {
  CORE_READY?: string;
  CORE_ERROR?: string;
  PLAYER_READY?: string;
  PLAYER_PLAY?: string;
  PLAYER_BUFFERING?: string;
  PLAYER_BUFFERFULL?: string;
  PLAYER_ERROR?: string;
};

type ClapprModule = {
  Player: new (options: Record<string, unknown>) => ClapprPlayer;
  Events?: ClapprEvents;
};

type ClapprPlayer = {
  configure(options: Record<string, unknown>): void;
  destroy(): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  off(event: string, callback: (...args: unknown[]) => void): void;
  play(): void;
  stop(): void;
};

type HlsErrorLike = {
  details?: string;
  fatal?: boolean;
  type?: string;
};

const RETRY_LIMIT = 5;
const RETRY_DELAY_MS = 1800;
const LOAD_TIMEOUT_MS = 20000;
const BUFFER_RECOVERY_MS = 30000;
const HLS_ERROR_EVENT = "hlsError";
const HLS_FRAG_BUFFERED_EVENT = "hlsFragBuffered";

function getPlayerSources(streamUrl: string): string[] {
  return getClapprSourceCandidates(streamUrl.trim());
}

export function StreamPlayer({ channel }: { channel: LiveChannel | null }) {
  const playerHostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<ClapprPlayer | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const loadTimeoutRef = useRef<number | null>(null);
  const bufferRecoveryTimerRef = useRef<number | null>(null);
  const mediaProbeTimerRef = useRef<number | null>(null);
  const mediaListenerCleanupRef = useRef<(() => void) | null>(null);
  const retryCountRef = useRef(0);
  const channelKeyRef = useRef("");
  const sourceIndexRef = useRef(0);
  const hasStartedRef = useRef(false);
  const [status, setStatus] = useState("Idle");
  const [isLoading, setIsLoading] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    const channelKey = channel ? `${channel.id}:${channel.streamUrl}` : "";
    if (channelKey !== channelKeyRef.current) {
      channelKeyRef.current = channelKey;
      retryCountRef.current = 0;
      sourceIndexRef.current = 0;
      hasStartedRef.current = false;
    }
  }, [channel?.id, channel?.streamUrl]);

  useEffect(() => {
    let disposed = false;

    function clearRetryTimer() {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    }

    function clearLoadTimeout() {
      if (loadTimeoutRef.current !== null) {
        window.clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
    }

    function clearBufferRecoveryTimer() {
      if (bufferRecoveryTimerRef.current !== null) {
        window.clearTimeout(bufferRecoveryTimerRef.current);
        bufferRecoveryTimerRef.current = null;
      }
    }

    function clearMediaProbeTimer() {
      if (mediaProbeTimerRef.current !== null) {
        window.clearTimeout(mediaProbeTimerRef.current);
        mediaProbeTimerRef.current = null;
      }
    }

    function clearMediaListeners() {
      clearMediaProbeTimer();

      if (mediaListenerCleanupRef.current) {
        mediaListenerCleanupRef.current();
        mediaListenerCleanupRef.current = null;
      }
    }

    function destroyPlayer() {
      clearRetryTimer();
      clearLoadTimeout();
      clearBufferRecoveryTimer();
      clearMediaListeners();

      if (playerRef.current) {
        try {
          playerRef.current.stop();
        } catch {}

        try {
          playerRef.current.destroy();
        } catch {}

        playerRef.current = null;
      }

      if (playerHostRef.current) {
        playerHostRef.current.innerHTML = "";
      }
    }

    function scheduleRetry(sourceCount: number, rotateSource = true) {
      if (disposed || retryTimerRef.current !== null) {
        return;
      }

      clearBufferRecoveryTimer();

      if (rotateSource) {
        const nextSourceIndex = sourceIndexRef.current + 1;
        if (nextSourceIndex < sourceCount) {
          sourceIndexRef.current = nextSourceIndex;
        } else {
          sourceIndexRef.current = 0;
          retryCountRef.current += 1;
        }
      } else {
        retryCountRef.current += 1;
      }

      if (retryCountRef.current >= RETRY_LIMIT) {
        setIsLoading(false);
        setStatus(`Playback unavailable`);
        return;
      }

      setIsLoading(true);
      setStatus(`Reconnecting stream`);

      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        hasStartedRef.current = false;
        setRetryNonce((value) => value + 1);
      }, RETRY_DELAY_MS);
    }

    function scheduleBufferRecovery(sourceCount: number) {
      if (disposed || bufferRecoveryTimerRef.current !== null) {
        return;
      }

      setStatus("Buffering");

      bufferRecoveryTimerRef.current = window.setTimeout(() => {
        bufferRecoveryTimerRef.current = null;
        scheduleRetry(sourceCount, false);
      }, BUFFER_RECOVERY_MS);
    }

    async function mountPlayer() {
      if (!channel || !playerHostRef.current) {
        destroyPlayer();
        setIsLoading(false);
        setStatus("Idle");
        return;
      }

      destroyPlayer();
      setIsLoading(true);
      setStatus("Loading live stream");
      hasStartedRef.current = false;

      const sources = getPlayerSources(channel.streamUrl);
      const source = sources[sourceIndexRef.current] || sources[0];

      if (!source) {
        setIsLoading(false);
        setStatus("Playback unavailable");
        return;
      }

      function markPlaybackActive(nextStatus = "Playing") {
        clearLoadTimeout();
        clearBufferRecoveryTimer();
        hasStartedRef.current = true;
        retryCountRef.current = 0;
        setStatus(nextStatus);
        setIsLoading(false);
      }

      function attachMediaElementListeners(sourceCount: number) {
        clearMediaListeners();

        const video = playerHostRef.current?.querySelector("video");

        if (!video) {
          mediaProbeTimerRef.current = window.setTimeout(() => {
            mediaProbeTimerRef.current = null;

            if (!disposed) {
              attachMediaElementListeners(sourceCount);
            }
          }, 250);
          return;
        }

        let lastPlaybackTime = video.currentTime;

        const handlePlayable = () => {
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            markPlaybackActive("Playing");
          }
        };

        const handleTimeUpdate = () => {
          const moved = Math.abs(video.currentTime - lastPlaybackTime) > 0.05;
          lastPlaybackTime = video.currentTime;

          if (moved || video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
            markPlaybackActive("Playing");
          }
        };

        const handleWaiting = () => {
          if (hasStartedRef.current) {
            scheduleBufferRecovery(sourceCount);
            return;
          }

          setStatus("Buffering");
          setIsLoading(true);
        };

        const handleMediaError = () => {
          scheduleRetry(sourceCount);
        };

        video.addEventListener("playing", handlePlayable);
        video.addEventListener("canplay", handlePlayable);
        video.addEventListener("timeupdate", handleTimeUpdate);
        video.addEventListener("waiting", handleWaiting);
        video.addEventListener("stalled", handleWaiting);
        video.addEventListener("error", handleMediaError);

        mediaListenerCleanupRef.current = () => {
          video.removeEventListener("playing", handlePlayable);
          video.removeEventListener("canplay", handlePlayable);
          video.removeEventListener("timeupdate", handleTimeUpdate);
          video.removeEventListener("waiting", handleWaiting);
          video.removeEventListener("stalled", handleWaiting);
          video.removeEventListener("error", handleMediaError);
        };
      }

      try {
        const [clapprImport, hlsjsPlaybackImport] = await Promise.all([
          import("@clappr/player"),
          import("@clappr/hlsjs-playback"),
        ]);
        const Clappr = (clapprImport.default ?? clapprImport) as unknown as ClapprModule;
        const HlsjsPlayback = (hlsjsPlaybackImport.default ?? hlsjsPlaybackImport) as unknown;

        if (disposed || !playerHostRef.current) {
          return;
        }

        const player = new Clappr.Player({
          source,
          mimeType: "application/vnd.apple.mpegurl",
          parentId: "#player",
          width: "100%",
          height: "100%",
          autoPlay: true,
          mute: true,
          crossOrigin: "anonymous",
          disableErrorScreen: true,
          playbackNotSupportedMessage: "",
          plugins: [HlsjsPlayback],
          hlsRecoverAttempts: 50,
          hlsPlayback: {
            preload: true,
            customListeners: [
              {
                eventName: HLS_FRAG_BUFFERED_EVENT,
                callback: () => {
                  markPlaybackActive("Playing");
                },
              },
              {
                eventName: HLS_ERROR_EVENT,
                callback: (_event: string, data: HlsErrorLike) => {
                  if (disposed) {
                    return;
                  }

                  if (hasStartedRef.current) {
                    scheduleBufferRecovery(sources.length);
                    return;
                  }

                  if (data?.fatal) {
                    scheduleRetry(sources.length);
                  }
                },
              },
            ],
          },
          mediacontrol: {
            seekbar: "#25b0ff",
            buttons: "#25b0ff",
          },
          playback: {
            crossOrigin: "anonymous",
            hlsjsConfig: {
              enableWorker: true,
              lowLatencyMode: false,
              liveDurationInfinity: true,
              maxBufferLength: 120,
              maxMaxBufferLength: 240,
              backBufferLength: 90,
              liveSyncDurationCount: 7,
              liveMaxLatencyDurationCount: 14,
              maxLiveSyncPlaybackRate: 1.1,
              maxBufferHole: 1.5,
              nudgeOffset: 0.2,
              nudgeMaxRetry: 8,
              highBufferWatchdogPeriod: 3,
              startFragPrefetch: true,
              manifestLoadingTimeOut: 20000,
              manifestLoadingMaxRetry: 20,
              manifestLoadingRetryDelay: 1000,
              manifestLoadingMaxRetryTimeout: 15000,
              levelLoadingTimeOut: 20000,
              levelLoadingMaxRetry: 20,
              levelLoadingRetryDelay: 1000,
              levelLoadingMaxRetryTimeout: 15000,
              fragLoadingTimeOut: 20000,
              fragLoadingMaxRetry: 20,
              fragLoadingRetryDelay: 1000,
              fragLoadingMaxRetryTimeout: 15000,
            },
          },
        });

        playerRef.current = player;
        attachMediaElementListeners(sources.length);

        const events = Clappr.Events ?? {};
        const readyEvent = events.PLAYER_READY ?? events.CORE_READY ?? "ready";
        const playEvent = events.PLAYER_PLAY ?? "play";
        const bufferingEvent = events.PLAYER_BUFFERING ?? "buffering";
        const bufferFullEvent = events.PLAYER_BUFFERFULL ?? "bufferfull";
        const errorEvent = events.PLAYER_ERROR ?? events.CORE_ERROR ?? "error";

        const handleReady = () => {
          setStatus("Preparing stream");
        };

        const handlePlay = () => {
          setStatus("Starting playback");
        };

        const handleBuffering = () => {
          if (!hasStartedRef.current) {
            setIsLoading(true);
          }
          setStatus("Buffering");
          scheduleBufferRecovery(sources.length);
        };

        const handleBufferFull = () => {
          markPlaybackActive("Playing");
        };

        const handleError = (..._args: unknown[]) => {
          if (hasStartedRef.current) {
            scheduleBufferRecovery(sources.length);
            return;
          }

          scheduleRetry(sources.length);
        };

        player.on(readyEvent, handleReady);
        player.on(playEvent, handlePlay);
        player.on(bufferingEvent, handleBuffering);
        player.on(bufferFullEvent, handleBufferFull);
        player.on(errorEvent, handleError);

        loadTimeoutRef.current = window.setTimeout(() => {
          scheduleRetry(sources.length);
        }, LOAD_TIMEOUT_MS);
      } catch {
        scheduleRetry(sources.length);
      }
    }

    void mountPlayer();

    return () => {
      disposed = true;
      destroyPlayer();
    };
  }, [channel?.id, channel?.streamUrl, retryNonce]);

  if (!channel) {
    return (
      <div className="player-shell-empty">
        <div className="player-empty-state">
          <div className="player-empty-icon">
            <Tv2 size={30} />
          </div>
          <div>
            <h3>No Channel Selected</h3>
            <p>Select a channel from the sidebar</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="player-shell livezone-player">
      <div className="player-video-frame">
        <div id="player" ref={playerHostRef} className="player-clappr-host" />
      </div>

      <div className="player-footer">
        <div className="player-current-info">
          <p className="player-active-meta">Now playing</p>
          <h3 className="player-active-title">{channel.name}</h3>
          <p className="player-active-copy">{status}</p>
        </div>
        <div className="player-controls-hint">
          <Radio size={16} />
          Autoplay enabled. Use controls for sound.
        </div>
      </div>
    </div>
  );
}
