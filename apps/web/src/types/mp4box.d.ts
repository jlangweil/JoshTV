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

  export interface MP4Sample {
    offset: number;
    size: number;
    dts: number;
    cts: number;
    duration: number;
    timescale: number;
    is_sync: boolean;
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
    /** Moves segmentation to the sync sample at/before time; returns the byte offset needed next. */
    seek(time: number, useRap: boolean): { offset: number; time: number };
    getTrackById(id: number): { samples?: MP4Sample[] } | undefined;
    /** Frees sample data (and fully consumed input buffers) before sampleNum. */
    releaseUsedSamples(trackId: number, sampleNum: number): void;
  }

  export function createFile(): ISOFile;
}
