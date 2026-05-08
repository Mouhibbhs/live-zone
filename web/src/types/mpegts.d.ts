declare module "mpegts.js" {
  export interface Player {
    on(event: string, callback: (...args: unknown[]) => void): void;
    off(event: string, callback: (...args: unknown[]) => void): void;
    attachMediaElement(mediaElement: HTMLMediaElement): void;
    detachMediaElement(): void;
    load(): void;
    unload(): void;
    play(): Promise<void>;
    pause(): void;
    destroy(): void;
  }

  export interface PlayerConfig {
    enableStashBuffer?: boolean;
    stashInitialSize?: number;
    liveBufferLatencyChasing?: boolean;
    liveBufferLatencyMaxLatency?: number;
    liveBufferLatencyMinLatency?: number;
    enableWorker?: boolean;
    autoCleanupMaxBackwardDuration?: number;
    autoCleanupMaxForwardDuration?: number;
  }

  export interface MediaDataSource {
    type: string;
    url: string;
    isLive?: boolean;
  }

  export const Events: {
    ERROR: string;
    LOADING_COMPLETE: string;
    RECOVERED_EARLY_EOF: string;
    MEDIA_INFO: string;
    METADATA_ARRIVED: string;
    SCRIPTDATA_ARRIVED: string;
    STATISTICS_INFO: string;
  };

  export const ErrorTypes: {
    NETWORK_ERROR: string;
    MEDIA_ERROR: string;
    OTHER_ERROR: string;
  };

  export const ErrorDetails: {
    NETWORK_EXCEPTION: string;
    NETWORK_STATUS_CODE_INVALID: string;
    NETWORK_TIMEOUT: string;
    NETWORK_UNRECOVERABLE_EARLY_EOF: string;
    MEDIA_MSE_ERROR: string;
    MEDIA_FORMAT_ERROR: string;
    MEDIA_CODEC_UNSUPPORTED: string;
  };

  export function isSupported(): boolean;
  export function createPlayer(dataSource: MediaDataSource, config?: PlayerConfig): Player;

  const mpegts: {
    isSupported(): boolean;
    createPlayer(dataSource: MediaDataSource, config?: PlayerConfig): Player;
    Events: typeof Events;
    ErrorTypes: typeof ErrorTypes;
    ErrorDetails: typeof ErrorDetails;
  };

  export default mpegts;
}

