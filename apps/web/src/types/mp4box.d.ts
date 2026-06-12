declare module "mp4box" {
  export interface MP4Track {
    id: number;
    codec: string;
    type: string;
    duration: number;
    timescale: number;
    nb_samples: number;
    video?: { width: number; height: number };
    audio?: { sample_rate: number; channel_count: number };
  }

  export interface MP4Info {
    duration: number;
    timescale: number;
    isFragmented: boolean;
    tracks: MP4Track[];
    videoTracks: MP4Track[];
    audioTracks: MP4Track[];
  }

  export interface MP4ArrayBuffer extends ArrayBuffer {
    fileStart: number;
  }

  export interface ISOFile {
    onReady: ((info: MP4Info) => void) | null;
    onError: ((error: string) => void) | null;
    onSegment:
      | ((id: number, user: unknown, buffer: ArrayBuffer, sampleNum: number, isLast: boolean) => void)
      | null;
    appendBuffer(buffer: MP4ArrayBuffer): number;
    setSegmentOptions(trackId: number, user?: unknown, options?: { nbSamples?: number }): void;
    initializeSegmentation(): Array<{ id: number; user: unknown; buffer: ArrayBuffer }>;
    start(): void;
    stop(): void;
    flush(): void;
  }

  export function createFile(): ISOFile;
}
