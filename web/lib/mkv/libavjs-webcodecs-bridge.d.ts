  import type { LibAV, Packet, Stream } from "@libav.js/types";

  export function audioStreamToConfig(libav: LibAV, stream: Stream): Promise<unknown>;
  export function videoStreamToConfig(libav: LibAV, stream: Stream): Promise<unknown>;
  export function packetToEncodedAudioChunk(packet: Packet, stream: Stream): EncodedAudioChunk;
  export function packetToEncodedVideoChunk(packet: Packet, stream: Stream): EncodedVideoChunk;
