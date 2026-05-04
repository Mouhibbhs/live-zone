import StandaloneIPTVPlayer from '@/components/standalone-iptv-player';

export default function DemoPage() {
  return (
    <div className="standalone-page standalone-page-narrow">
      <h1>🌟 LiveZone IPTV Player Demo</h1>
      <p className="standalone-page-copy">
        Production-ready standalone HLS player with optimal live buffering
      </p>
      <StandaloneIPTVPlayer 
        url="http://xlion.net:8080/live/747645/lion123123/101758.m3u8"
        title="Live Stream Demo" 
      />
      <div className="standalone-page-meta">
        <p>Usage: <code>/player?url=YOUR.m3u8</code></p>
        <p>Features: 90s buffering, auto-recovery, multi-quality, responsive</p>
      </div>
    </div>
  );
}
