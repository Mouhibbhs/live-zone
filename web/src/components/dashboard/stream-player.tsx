"use client";

import Hls from "hls.js";
import { AlertTriangle, RefreshCw, Tv2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { normalizeLiveStreamUrl } from "@/lib/stream-url";
import type { LiveChannel } from "@/lib/types";

type PlayerState = "idle" | "loading" | "playing" | "error";

export function StreamPlayer({ channel }: { channel: LiveChannel | null }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
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
    const streamUrl = normalizeLiveStreamUrl(channel.streamUrl, "m3u8");
    let cancelled = false;

    function cleanup() {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      currentVideo.pause();
      currentVideo.removeAttribute("src");
      currentVideo.load();
    }

    async function playVideo() {
      setPlayerState("loading");
      setMessage("Loading live stream...");
      cleanup();

      currentVideo.muted = true;
      currentVideo.autoplay = true;
      currentVideo.playsInline = true;

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          liveDurationInfinity: true,
          liveSyncDurationCount: 6,
          liveMaxLatencyDurationCount: 12,
          maxBufferLength: 60,
          maxMaxBufferLength: 120,
          backBufferLength: 45,
          manifestLoadingMaxRetry: 6,
          levelLoadingMaxRetry: 6,
          fragLoadingMaxRetry: 6,
        });

        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          void currentVideo.play().catch((error: unknown) => {
            if (!cancelled) {
              setPlayerState("error");
              setMessage(error instanceof Error ? error.message : "Unable to start playback.");
            }
          });
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) {
            return;
          }

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
            return;
          }

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }

          if (!cancelled) {
            setPlayerState("error");
            setMessage(`Stream error: ${data.details}`);
          }
        });

        hls.loadSource(streamUrl);
        hls.attachMedia(currentVideo);
      } else if (currentVideo.canPlayType("application/vnd.apple.mpegurl")) {
        currentVideo.src = streamUrl;
        await currentVideo.play();
      } else {
        setPlayerState("error");
        setMessage("This browser does not support HLS playback.");
      }
    }

    const onPlaying = () => {
      setPlayerState("playing");
      setMessage("Live stream connected.");
    };

    const onWaiting = () => {
      if (!cancelled) {
        setMessage("Buffering live stream...");
      }
    };

    const onError = () => {
      if (!cancelled) {
        setPlayerState("error");
        setMessage(currentVideo.error?.message || "Playback failed.");
      }
    };

    currentVideo.addEventListener("playing", onPlaying);
    currentVideo.addEventListener("waiting", onWaiting);
    currentVideo.addEventListener("error", onError);

    void playVideo().catch((error: unknown) => {
      if (!cancelled) {
        setPlayerState("error");
        setMessage(error instanceof Error ? error.message : "Playback failed.");
      }
    });

    return () => {
      cancelled = true;
      currentVideo.removeEventListener("playing", onPlaying);
      currentVideo.removeEventListener("waiting", onWaiting);
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
                <strong>Playback needs another attempt</strong>
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
