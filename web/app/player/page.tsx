import StandaloneIPTVPlayer from '@/components/standalone-iptv-player';

export default function PlayerPage() {
  return (
    <div className="standalone-page">
      <h1>🎬 LiveZone IPTV Player</h1>
      <StandaloneIPTVPlayer 
        url="http://xlion.net:8080/live/747645/lion123123/101758.m3u8"
        title="Live Stream Demo" 
      />
    </div>
  );
}
