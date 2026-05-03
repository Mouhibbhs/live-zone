import StandaloneIPTVPlayer from '@/components/standalone-iptv-player';

export default function DemoPage() {
  return (
    <div className="landing-layout" style={{ padding: '2rem', textAlign: 'center', maxWidth: '800px', margin: '0 auto' }}>
      <h1 style={{ color: 'white', marginBottom: '1rem' }}>🌟 LiveZone IPTV Player Demo</h1>
      <p style={{ color: '#a0a0b0', marginBottom: '2rem' }}>
        Production-ready standalone HLS player with optimal live buffering
      </p>
      <StandaloneIPTVPlayer 
        url="http://xlion.net:8080/live/747645/lion123123/101758.m3u8"
        title="Live Stream Demo" 
      />
      <div style={{ marginTop: '2rem', color: '#666', fontSize: '0.9rem' }}>
        <p>Usage: <code>/player?url=YOUR.m3u8</code></p>
        <p>Features: 90s buffering, auto-recovery, multi-quality, responsive</p>
      </div>
    </div>
  );
}
