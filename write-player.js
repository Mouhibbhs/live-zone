const fs = require('fs');
const content = `"use client";

import { Tv2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeLiveStreamUrl } from "@/lib/stream-url";
import type { LiveChannel } from "@/lib/types";

function getMpegts() {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.mpegts as typeof import("mpegts.js") | undefined) ?? null;
}

function getProxyUrl(targetUrl: string) {
  return \`http://localhost:3000/proxy?url=\${encodeURIComponent(targetUrl)}\`;
}

async function probeUrl(url: string) {
  try {
    const r = await fetch(url, { method: "HEAD", mode: "cors" });
    return { ok: true, status: r.status };
  } catch (err: any) {
    const msg = err.message || "";
    const cors = msg.includes("CORS") || msg.includes("Failed to fetch");
    return { ok: false, cors, error: msg };
  }
}

const MPEGTS_CONFIG = {
  enableStashBuffer: true,
  stashInitialSize: 2048,
  liveBufferLatencyChasing: false,
  liveBufferLatencyMaxLatency: 20,
  enableWorker: true,
};

export function StreamPlayer({ channel }: { channel: LiveChannel | null }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mpegtsRef = useRef<import("mpegts.js").Player | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    console.log(\`[IPTV] \${msg}\`);
    setLogs((p) => [...p.slice(-19), msg]);
  }, []);

  const destroyMpegts = useCallback(() => {
    if (mpegtsRef.current) {
      try { mpegtsRef.current.pause(); mpegtsRef.current.unload(); mpegtsRef.current.destroy(); } catch {}
      mpegtsRef.current = null;
    }
  }, []);

  const loadWithMpegts = useCallback((video: HTMLVideoElement, url: string) => {
    destroyMpegts();
    addLog(\`mpegts.js: \${url}\`);
    const lib = getMpegts();
    if (!lib || !lib.isSupported()) { setError("mpegts.js not supported"); setLoading(false); return; }
    const player = lib.createPlayer({ type: "mse", isLive: true, url }, MPEGTS_CONFIG);
    mpegtsRef.current = player;
    player.on(lib.Events.ERROR, (...args: unknown[]) => {
      const [, detail] = args as [string, string];
      addLog(\`error: \${detail}\`); setLoading(false); setError(detail);
    });
    player.attachMediaElement(video);
    player.load();
    player.play().catch(() => {});
    video.addEventListener("playing", () => { addLog("playing"); setLoading(false); }, { once: true });
  }, [addLog, destroyMpegts]);

  const loadStream = useCallback(async (video: HTMLVideoElement, rawUrl: string) => {
    destroyMpegts();
    setLoading(true); setError(null); setLogs([]);
    video.removeAttribute("src");
    const tsUrl = normalizeLiveStreamUrl(rawUrl, "ts");
    if (!tsUrl) { setError("Invalid URL"); setLoading(false); return; }
    let target = tsUrl;
    addLog(\`Probing \${tsUrl}...\`);
    const probe = await probeUrl(tsUrl);
    if (!probe.ok && probe.cors) { addLog("CORS BLOCKED -> proxy"); target = getProxyUrl(tsUrl); addLog(target); }
    else if (probe.ok) addLog(\`OK \${probe.status}\`);
    else addLog(\`Fail: \${probe.error}\`);
    loadWithMpegts(video, target);
  }, [addLog, destroyMpegts, loadWithMpegts]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!channel) { destroyMpegts(); v.removeAttribute("src"); v.load(); return; }
    loadStream(v, channel.streamUrl);
    return () => { destroyMpegts(); };
  }, [channel, destroyMpegts, loadStream]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.code === "Space") { e.preventDefault(); v.paused ? v.play().catch(()=>{}) : v.pause(); }
      if (e.code === "ArrowLeft") { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); }
      if (e.code === "ArrowRight") { e.preventDefault(); v.currentTime += 10; }
      if (e.code === "ArrowUp") { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); }
      if (e.code === "ArrowDown") { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); }
      if (e.code === "KeyF") { e.preventDefault(); document.fullscreenElement ? document.exitFullscreen().catch(()=>{}) : v.requestFullscreen().catch(()=>{}); }
      if (e.code === "KeyM") { e.preventDefault(); v.muted = !v.muted; setMuted(v.muted); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!channel) {
    return (
      <div className="player-shell player-shell-empty">
        <div className="player-empty-state">
          <div className="player-empty-icon"><Tv2 size={24} /></div>
          <div><strong>No channel selected</strong><p>Open the channel drawer to launch a stream.</p></div>
      </div>
    );
  }

  return (
    <div className="player-shell">
      <div className="player-video-frame">
        <video ref={videoRef} className="player-video" autoPlay playsInline muted={muted} controls style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
        <div className="player-live-banner" style={{ pointerEvents: "none" }}>
          <span className="live-indicator status-live"><span className="pulse" />LIVE</span>
          <span className="player-active-title" style={{ marginLeft: 12 }}>{channel.name}</span>
        </div>
        {loading && (
          <div className="player-overlay" style={{ pointerEvents: "none" }}>
            <div className="player-overlay-card">
              <div className="spin" style={{ width: 32, height: 32, border: "3px solid rgba(127,194,255,0.2)", borderTopColor: "var(--accent)", borderRadius: "50%" }} />
              <div className="player-overlay-copy"><strong>Buffering stream…</strong><p>Recovering live edge. Please wait.</p></div>
          </div>
        )}
        {error && !loading && (
          <div className="player-overlay">
            <div className="player-overlay-card">
              <div className="player-overlay-copy"><strong>Stream interrupted</strong><p>{error}</p></div>
          </div>
        )}
      </div>
      <div className="player-footer">
        <div className="player-current-info">
          <span className="live-indicator status-live"><span className="pulse" />LIVE</span>
          <h3 className="player-active-title">{channel.name}</h3>
          <p className="player-active-meta">{channel.epgChannelId ? \`EPG: \${channel.epgChannelId}\` : "Adaptive bitrate streaming"}</p>
        </div>
        <div className="player-controls-hint"><span>Space: play/pause · F: fullscreen · M: mute · ↑↓: volume · ←→: seek</span></div>
      {error && <div className="player-notice player-notice-error"><span>{error}</span></div>}
      <div style={{ marginTop: 8, background: "#121225", borderRadius: 8, padding: 10, maxHeight: 120, overflow: "auto" }}>
        <div style={{ fontSize: "0.7rem", color: "#a0a0b0", marginBottom: 6 }}>Debug Logs:</div>
        {logs.map((log, i) => <div key={i} style={{ fontSize: "0.72rem", color: "#00d9ff", fontFamily: "monospace", lineHeight: 1.4, wordBreak: "break-all" }}>{log}</div>)}
      </div>
  );
}
`;
fs.writeFileSync('web/src/components/dashboard/stream-player.tsx', content, 'utf8');
console.log('stream-player.tsx written successfully');
