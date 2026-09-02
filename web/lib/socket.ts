/**
 * WatchParty 实时 Socket 客户端适配层
 * 严格按照 UNIVERSAL_ALIGNMENT_SPEC.md 规范实现
 */

import { io, Socket } from "socket.io-client";
import { RoomSnapshot, RoomMember, MediaSource, CommandAck } from "./contracts";

export interface SocketClientOptions {
  roomId: string;
  clientId: string;
  accessToken: string;
  ownerToken?: string;
  onSnapshot: (snapshot: RoomSnapshot) => void;
  onMembers: (members: RoomMember[]) => void;
  onOwnerToken?: (newOwnerToken: string) => void;
  onError?: (err: { code: string; message: string }) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
}

/**
 * Development bypasses Next's HTTP-only rewrite and talks to the backend port.
 * Production stays same-origin so Caddy can route /socket.io without exposing 8080.
 */
export function getSocketOrigin(): string {
  const configuredOrigin = process.env.NEXT_PUBLIC_SOCKET_ORIGIN?.trim();
  if (configuredOrigin) return configuredOrigin.replace(/\/$/, "");
  if (typeof window === "undefined") return "";
  if (process.env.NODE_ENV !== "production") {
    const protocol = window.location.protocol === "https:" ? "https:" : "http:";
    return `${protocol}//${window.location.hostname}:8080`;
  }
  return window.location.origin;
}

export class WatchPartySocket {
  private socket: Socket | null = null;
  private options: SocketClientOptions;
  private clockOffsetMs = 0;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncGeneration = 0;

  constructor(options: SocketClientOptions) {
    this.options = options;
  }

  public connect(): void {
    if (this.socket) return;

    this.socket = io(getSocketOrigin(), {
      path: "/socket.io",
      transports: ["polling", "websocket"],
      auth: {
        roomId: this.options.roomId,
        clientId: this.options.clientId,
        accessToken: this.options.accessToken,
        ownerToken: this.options.ownerToken,
      },
    });

    this.socket.on("connect", () => {
      this.options.onConnect?.();
      this.startClockSync();
    });

    this.socket.on("disconnect", (reason) => {
      this.stopClockSync();
      this.options.onDisconnect?.(reason);
    });

    this.socket.on("connect_error", (err: Error & { data?: { code: string; message: string } }) => {
      this.options.onError?.({
        code: err.data?.code || "CONNECT_ERROR",
        message: err.data?.message || err.message,
      });
    });

    this.socket.on("REC:snapshot", (snapshot: RoomSnapshot) => {
      this.options.onSnapshot(snapshot);
    });

    this.socket.on("REC:members", (members: RoomMember[]) => {
      this.options.onMembers(members);
    });

    this.socket.on("REC:ownerToken", (newOwnerToken: string) => {
      this.options.onOwnerToken?.(newOwnerToken);
    });

    this.socket.on("REC:error", (err: { code: string; message: string }) => {
      this.options.onError?.(err);
    });
  }

  public disconnect(): void {
    this.stopClockSync();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  public getClockOffset(): number {
    return this.clockOffsetMs;
  }

  // NTP 时钟对齐流程 (规范要求：连接后连续采样 5 次取中位数，后续每 30 秒微调)
  private async startClockSync(): Promise<void> {
    this.stopClockSync();
    const generation = this.syncGeneration;

    // 连续采样 5 次
    const offsets: number[] = [];
    for (let i = 0; i < 5; i++) {
      const offset = await this.sampleClockOffset();
      if (generation !== this.syncGeneration) return;
      if (offset !== null) {
        offsets.push(offset);
      }
      // 采样间隔 100ms
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (offsets.length > 0) {
      offsets.sort((a, b) => a - b);
      const mid = Math.floor(offsets.length / 2);
      this.clockOffsetMs = offsets.length % 2 !== 0 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
    }

    // 后续每 30 秒定期采样微调
    if (generation !== this.syncGeneration) return;
    this.syncTimer = setInterval(async () => {
      const offset = await this.sampleClockOffset();
      if (generation !== this.syncGeneration) return;
      if (offset !== null) {
        // 平滑移动平均微调
        this.clockOffsetMs = this.clockOffsetMs * 0.8 + offset * 0.2;
      }
    }, 30000);
  }

  private stopClockSync(): void {
    this.syncGeneration += 1;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private async sampleClockOffset(): Promise<number | null> {
    if (!this.socket || !this.socket.connected) return null;
    const clientSentAtMs = Date.now();

    try {
      const res = await this.emitCommand<{ serverTimeMs: number }>("CMD:clockSync", {
        clientSentAtMs,
      });
      if (res.ok && res.data) {
        const clientReceivedAtMs = Date.now();
        const rtt = clientReceivedAtMs - clientSentAtMs;
        const offset = res.data.serverTimeMs - (clientSentAtMs + rtt / 2);
        return offset;
      }
    } catch {
      // 忽略单个采样失败
    }
    return null;
  }

  private emitCommand<T = undefined>(event: string, payload: Record<string, unknown>, timeoutMs = 5000): Promise<CommandAck<T>> {
    return new Promise((resolve) => {
      if (!this.socket || !this.socket.connected) {
        resolve({
          ok: false,
          error: { code: "NOT_CONNECTED", message: "网络连接尚未建立" },
        });
        return;
      }

      let isSettled = false;
      const timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          resolve({
            ok: false,
            error: { code: "TIMEOUT", message: `指令 ${event} 请求超时，服务端未在 ${timeoutMs}ms 内回执` },
          });
        }
      }, timeoutMs);

      this.socket.emit(event, payload, (response: CommandAck<T>) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          resolve(response || { ok: false, error: { code: "INVALID_ACK", message: "服务端回执为空" } });
        }
      });
    });
  }

  // ================= 客户端指令封装 =================
  public sendName(name: string): Promise<CommandAck> {
    return this.emitCommand("CMD:name", { name });
  }

  public play(expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:play", { expectedRevision });
  }

  public pause(expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:pause", { expectedRevision });
  }

  public seek(positionSeconds: number, expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:seek", { positionSeconds, expectedRevision });
  }

  public rate(rate: number, expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:rate", { rate, expectedRevision });
  }

  public loop(loop: boolean, expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:loop", { loop, expectedRevision });
  }

  public lock(locked: boolean, expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:lock", { locked, expectedRevision });
  }

  public mediaSet(media: MediaSource, expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:mediaSet", { media, expectedRevision });
  }

  public playlistAdd(media: MediaSource, expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:playlistAdd", { media, expectedRevision });
  }

  public playlistRemove(itemId: string, expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:playlistRemove", { itemId, expectedRevision });
  }

  public playlistMove(itemId: string, targetIndex: number, expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:playlistMove", { itemId, targetIndex, expectedRevision });
  }

  public playlistPlay(itemId: string, expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:playlistPlay", { itemId, expectedRevision });
  }

  public playlistNext(expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:playlistNext", { expectedRevision });
  }

  public transferOwner(targetClientId: string, expectedRevision: number): Promise<CommandAck> {
    return this.emitCommand("CMD:transferOwner", { targetClientId, expectedRevision });
  }
}
