"use client";

import { LoaderCircle, Radio, RotateCw, Tv2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getFinalUrl } from "@/lib/stream-url";
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

const RETRY_LIMIT = 5;
const RETRY_DELAY_MS = 1800;

function getPlayerSource(streamUrl: string): string {
  return getFinalUrl(streamUrl.trim());
}

export function StreamPlayer({ channel }: { channel: LiveChannel | null }) {
  const playerHostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<ClapprPlayer | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);
  const channelKeyRef = useRef("");
  const [status, setStatus] = useState("Idle");
  const [isLoading, setIsLoading] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    const channelKey = channel ? `${channel.id}:${channel.streamUrl}` : "";
    if (channelKey !== channelKeyRef.current) {
      channelKeyRef.current = channelKey;
      retryCountRef.current = 0;
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

    function destroyPlayer() {
      clearRetryTimer();

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

    function scheduleRetry(reason: string) {
      if (disposed || retryTimerRef.current !== null) {
        return;
      }

      if (retryCountRef.current >= RETRY_LIMIT) {
        setIsLoading(false);
        setStatus(`Playback unavailable`);
        return;
      }

      retryCountRef.current += 1;
      setIsLoading(true);
      setStatus(`Reconnecting stream`);

      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        setRetryNonce((value) => value + 1);
      }, RETRY_DELAY_MS);
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

      const source = getPlayerSource(channel.streamUrl);

      try {
        const clapprImport = await import("clappr");
        const Clappr = (clapprImport.default ?? clapprImport) as unknown as ClapprModule;

        if (disposed || !playerHostRef.current) {
          return;
        }

        const player = new Clappr.Player({
          source,
          parent: playerHostRef.current,
          width: "100%",
          height: "100%",
          autoPlay: true,
          mute: true,
          crossOrigin: "anonymous",
          disableErrorScreen: true,
          playbackNotSupportedMessage: "",
          mediacontrol: {
            seekbar: "#25b0ff",
            buttons: "#25b0ff",
          },
          hlsjsConfig: {
            maxBufferLength: 30,
            liveSyncDurationCount: 7,
          },
        });

        playerRef.current = player;

        const events = Clappr.Events ?? {};
        const readyEvent = events.PLAYER_READY ?? events.CORE_READY ?? "ready";
        const playEvent = events.PLAYER_PLAY ?? "play";
        const bufferingEvent = events.PLAYER_BUFFERING ?? "buffering";
        const bufferFullEvent = events.PLAYER_BUFFERFULL ?? "bufferfull";
        const errorEvent = events.PLAYER_ERROR ?? events.CORE_ERROR ?? "error";

        const handleReady = () => {
          setStatus("Live");
          setIsLoading(false);
          retryCountRef.current = 0;
        };

        const handlePlay = () => {
          setStatus("Playing");
          setIsLoading(false);
        };

        const handleBuffering = () => {
          setStatus("Buffering");
          setIsLoading(true);
        };

        const handleBufferFull = () => {
          setStatus("Playing");
          setIsLoading(false);
        };

        const handleError = (..._args: unknown[]) => {
          scheduleRetry("player error");
        };

        player.on(readyEvent, handleReady);
        player.on(playEvent, handlePlay);
        player.on(bufferingEvent, handleBuffering);
        player.on(bufferFullEvent, handleBufferFull);
        player.on(errorEvent, handleError);
      } catch {
        scheduleRetry("player bootstrap failed");
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

        {isLoading ? (
          <div className="player-loading-overlay" aria-live="polite">
            <LoaderCircle className="player-loading-spinner" size={18} />
            <span>{status}</span>
          </div>
        ) : null}
      </div>

      <div className="player-footer">
        <div className="player-current-info">
          <p className="player-active-meta">Now playing</p>
          <h3 className="player-active-title">{channel.name}</h3>
          <p className="player-active-copy">{status}</p>
        </div>
        <div className="player-controls-hint">
          {isLoading ? <RotateCw size={16} /> : <Radio size={16} />}
          {isLoading ? "Recovering stream route." : "Autoplay enabled. Use controls for sound."}
        </div>
      </div>
    </div>
  );
}
