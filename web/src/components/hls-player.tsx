"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import { normalizeLiveStreamUrl } from "@/lib/stream-url";
import { Tv, Play, Pause, Volume2, VolumeX, Maximize2, Settings } from "lucide-react";
import type { LiveChannel } from "@/lib/types";

interface HLSPlayerProps {
  channel: LiveChannel | null;
  onError?: (error: string) => void;
  className?: string;
}

export function HLSPlayer({ channel, onError, className = "" }: HLSPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [buffered, setBuffered] = useState(0);
  const [quality, setQuality] = useState("Auto");
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !channel) return;

    // Cleanup
    if (hlsRef.current) {
      hlsRef.current.destroy();
    }

    setError(null);
    setIsPlaying(false);
    setBuffered(0);
    setQuality("Auto");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;

    const streamUrl = normalizeLiveStreamUrl(channel.streamUrl, "m3u8");

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 90,
        maxFragLookUpTolerance: 0.25,
        liveDurationInfinity: true,
        abrEwmaFastLive: 3,
        abrEwmaSlowLive: 9,
      });

      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setError(null);
        void video.play().catch((playError: unknown) => {
          const message = playError instanceof Error ? playError.message : "Playback could not start automatically.";
          setError(message);
          onError?.(message);
        });
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
        const level = hls.levels[data.level];
        setQuality(level?.height ? `${level.height}p` : "Auto");
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (video.buffered.length > 0) {
          const bufferedDuration = video.buffered.end(video.buffered.length - 1) - video.currentTime;
          setBuffered(Math.round(bufferedDuration));
        }
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.log("HLS error type:", data.type, data.details);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              setTimeout(() => hls.startLoad(), 2000);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              setError(`Stream error: ${data.details}`);
              onError?.(`Stream error: ${data.details}`);
              break;
          }
        }
      });

      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = streamUrl;
      video.load();
      void video.play().catch((playError: unknown) => {
        const message = playError instanceof Error ? playError.message : "Playback could not start automatically.";
        setError(message);
        onError?.(message);
      });
    } else {
      const message = "This browser does not support HLS playback.";
      setError(message);
      onError?.(message);
    }
  }, [channel, onError]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      if (video.paused) {
        video.play();
      } else {
        video.pause();
      }
    }
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.muted = !video.muted;
      setIsMuted(video.muted);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      if (!document.fullscreenElement) {
        video.requestFullscreen?.();
      } else {
        document.exitFullscreen();
      }
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (video && video.videoWidth > 0) {
      setError(null);
    }
  }, [channel]);

  if (!channel) {
    return (
      <div className="player-shell-empty">
        <div className="player-empty-state">
          <Tv size={64} />
          <h3>No Channel Selected</h3>
          <p>Select a channel from the sidebar</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`hls-player ${className}`}>
      <div className="player-container">
        <video
          ref={videoRef}
          className="player-video"
          controls
          autoPlay
          muted
          playsInline
          preload="metadata"
          disablePictureInPicture
          onPlay={() => {}}
          onPause={() => {}}
        />
        {error && (
          <div className="error-overlay">
            <div className="error-content">
              <h4>Stream Error</h4>
              <p>{error}</p>
              <button onClick={() => window.location.reload()}>Retry</button>
            </div>
          </div>
        )}
      </div>

      <div className="player-info">
        <div className="channel-title">{channel.name}</div>
        <div className="player-stats">
          <span>Quality: {quality}</span>
          <span>Buffer: {buffered}s</span>
          <span>{isPlaying ? '● LIVE' : '⏸ Paused'}</span>
        </div>
      </div>

      <div className="player-controls">
        <button onClick={togglePlay} title="Play/Pause">
          {isPlaying ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <button onClick={toggleMute} title="Mute">
          {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
        </button>
        <button onClick={toggleFullscreen} title="Fullscreen">
          <Maximize2 size={20} />
        </button>
        <button title="Settings">
          <Settings size={20} />
        </button>
      </div>

      <style jsx>{`
        .hls-player {
          width: 100%;
          max-width: 100%;
          background: #000;
          border-radius: 12px;
          overflow: hidden;
          font-family: system-ui, sans-serif;
        }

        .player-container {
          position: relative;
          aspect-ratio: 16 / 9;
          background: #000;
        }

        .player-video {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }

        .error-overlay {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.9);
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          z-index: 10;
        }

        .error-content {
          text-align: center;
          padding: 2rem;
        }

        .player-info {
          padding: 1rem;
          background: #1a1a1a;
          color: white;
        }

        .channel-title {
          font-weight: bold;
          margin: 0 0 0.5rem 0;
          font-size: 1.1rem;
        }

        .player-stats {
          display: flex;
          gap: 1rem;
          font-size: 0.85rem;
          color: #aaa;
        }

        .player-controls {
          display: flex;
          gap: 0.5rem;
          padding: 0.5rem;
          background: #111;
        }

        .player-controls button {
          background: none;
          border: none;
          color: white;
          padding: 0.5rem;
          border-radius: 4px;
          cursor: pointer;
          transition: background 0.2s;
        }

        .player-controls button:hover {
          background: rgba(255,255,255,0.1);
        }
      `}</style>
    </div>
  );
}

