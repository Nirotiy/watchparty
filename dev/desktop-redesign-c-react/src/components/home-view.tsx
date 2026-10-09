import { useMemo, useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { classifyEntry, type EntryIntent } from "@/lib/entry-intent"
import { cn } from "@/lib/utils"

export interface LastRoomHint {
  roomId: string
  mediaTitle?: string
}

export interface HomeViewProps {
  /** 本地记忆昵称（上次使用值，可为空串） */
  nickname: string
  /**
   * 上次房间是否仍存活（由 DesktopUiState 探测或最近会话缓存判定）。
   * 存活 → 显示「上次观看」恢复条；死亡或 null → 整条隐藏。
   */
  lastRoomAlive: LastRoomHint | null
  /** 站点凭据是否已在系统凭据库配置；null = native 未上报 */
  credentialsConfigured: boolean | null
  backendOrigin: string | null
  starting: boolean
  /**
   * 加入房间（房号 + 可选 PIN + 昵称）。
   * 房间受保护且未带 PIN 时返回字符串 "pin_required"，组件就地展开 PIN 输入。
   * 需要 desktop 会话新增 IPC joinRoom(roomId, pin, nickname)（REST /access 封装）。
   */
  onJoinRoom: (roomId: string, pin: string, nickname: string) => Promise<boolean | "pin_required">
  /**
   * 链接开播（http / hls / youtube 直链）。需要 desktop 会话新增 IPC
   * createRoom(nickname, pin, initialMedia)（REST /api/rooms 的 initialMedia 封装）。
   */
  onCreateFromLink: (source: EntryIntent & { kind: "media" }, pin: string, nickname: string) => Promise<boolean>
  /** 网页交接码兑付（现有 startDesktopSession 通道，保留为次要入口） */
  onRedeemTicket: (ticket: string) => Promise<boolean>
  onOpenLibrary: () => void
  onOpenSettings: () => void
}

const INTENT_HINTS: Record<string, string> = {
  room: "检测到房间号 · 回车加入该房间",
  media: "检测到媒体链接 · 将创建新房间（你为房主）并自动开播",
}

function submitLabel(intent: EntryIntent, starting: boolean): string {
  if (starting) return "正在处理…"
  if (intent?.kind === "media") return "创建并开播"
  return "加入房间"
}

export function HomeView({
  nickname: rememberedNickname,
  lastRoomAlive,
  credentialsConfigured,
  backendOrigin,
  starting,
  onJoinRoom,
  onCreateFromLink,
  onRedeemTicket,
  onOpenLibrary,
  onOpenSettings,
}: HomeViewProps) {
  const [entry, setEntry] = useState("")
  const [nickname, setNickname] = useState(rememberedNickname)
  const [pin, setPin] = useState("")
  const [pinVisible, setPinVisible] = useState(false)
  const [ticketMode, setTicketMode] = useState(false)
  const [ticket, setTicket] = useState("")
  const [notice, setNotice] = useState<string | null>(null)

  const intent = useMemo(() => classifyEntry(entry), [entry])
  const linkIntent = intent?.kind === "media" ? intent : null
  const roomIntent = intent?.kind === "room" ? intent : null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (starting) return
    const author = nickname.trim() || "访客"

    if (ticketMode) {
      const value = ticket.trim()
      if (!value) return
      if (await onRedeemTicket(value)) setTicket("")
      return
    }

    if (intent?.kind === "room") {
      const result = await onJoinRoom(intent.roomId, pin, author)
      if (result === "pin_required") {
        setPinVisible(true)
        setNotice("该房间受 PIN 保护，请输入 4 位密码")
      }
      return
    }

    if (linkIntent) {
      if (await onCreateFromLink(linkIntent, pin, author)) setEntry("")
    }
  }

  const hint = ticketMode
    ? "粘贴网页自动复制的一次性交接码（300 秒内有效，只兑换一次）。"
    : intent
      ? INTENT_HINTS[intent.kind]
      : "输入房号加入房间；粘贴媒体直链（http / m3u8 / YouTube）可直接创建新房间并开播。"

  return (
    <section className="mx-auto grid h-full w-[min(680px,calc(100%-4rem))] content-center gap-5" aria-labelledby="home-title">
      {lastRoomAlive ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-positive" aria-hidden />
          <span className="min-w-0 truncate">
            上次观看 · <b className="font-mono text-foreground">{lastRoomAlive.roomId}</b>
            {lastRoomAlive.mediaTitle ? ` · 正在播放 ${lastRoomAlive.mediaTitle}` : ""}
          </span>
          <Button variant="outline" size="sm" className="ml-auto shrink-0">返回房间</Button>
        </div>
      ) : null}

      <div>
        <h1 id="home-title" className="text-2xl font-semibold tracking-tight text-foreground">开始观看</h1>
        <form className="mt-4" autoComplete="off" onSubmit={submit}>
          <div className="flex gap-2.5">
            <Input
              value={entry}
              onChange={(event) => {
                setEntry(event.currentTarget.value)
                setNotice(null)
              }}
              placeholder="输入房号、watchparty:// 链接或媒体直链…"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              className="h-11 border-input text-sm"
              aria-describedby="home-intent-hint"
            />
            <Button
              type="submit"
              disabled={starting || ticketMode ? ticket.trim().length === 0 && !intent : !intent && !ticketMode}
              className="h-11 whitespace-nowrap px-5 text-sm"
            >
              {submitLabel(intent, starting)}
            </Button>
          </div>

          <p id="home-intent-hint" className={cn("mt-2 text-xs", intent?.kind === "media" ? "text-primary" : "text-muted-foreground")}>
            {notice ?? hint}
          </p>

          {pinVisible ? (
            <div className="mt-3 flex items-center gap-2.5">
              <label htmlFor="home-pin" className="text-xs text-muted-foreground">房间 PIN</label>
              <Input
                id="home-pin"
                value={pin}
                onChange={(event) => setPin(event.currentTarget.value.replace(/\D/g, "").slice(0, 4))}
                inputMode="numeric"
                maxLength={4}
                placeholder="0000"
                className="w-28 font-mono tracking-widest"
                autoFocus
              />
            </div>
          ) : null}

          {linkIntent ? (
            <div className="mt-3 flex flex-wrap items-center gap-3.5">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                昵称
                <Input
                  value={nickname}
                  onChange={(event) => setNickname(event.currentTarget.value)}
                  maxLength={24}
                  className="h-8 w-32 text-xs"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                房间 PIN（可选）
                <Input
                  value={pin}
                  onChange={(event) => setPin(event.currentTarget.value.replace(/\D/g, "").slice(0, 4))}
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="0000"
                  className="h-8 w-24 font-mono tracking-widest"
                />
              </label>
            </div>
          ) : null}
        </form>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onOpenLibrary}
            className={cn(
              "rounded-lg border border-border bg-card p-3.5 text-left transition-colors hover:border-primary",
              linkIntent && "border-primary",
            )}
          >
            <span className="block text-[12.5px] font-semibold text-foreground">
              {linkIntent ? "链接开播" : "从媒体库点播开房"}
            </span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              {linkIntent ? "已识别 · 直链 / m3u8 / YouTube" : "浏览 Anime / Film / TV Shows，选片即建新房"}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setTicketMode(false)
              setEntry("")
            }}
            className={cn(
              "rounded-lg border border-border bg-card p-3.5 text-left transition-colors hover:border-primary",
              !linkIntent && intent?.kind === "room" && "border-primary",
            )}
          >
            <span className="block text-[12.5px] font-semibold text-foreground">加入已有房间</span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              {intent?.kind === "room" ? "已识别 · 受保护房间会要求 PIN" : "清空后输入房号即可切换"}
            </span>
          </button>
        </div>

        <details className="mt-4 text-xs text-muted-foreground" onToggle={(event) => setTicketMode((event.target as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer select-none hover:text-foreground">我有网页交接码</summary>
          <div className="mt-2.5 flex gap-2">
            <Input
              value={ticket}
              onChange={(event) => setTicket(event.currentTarget.value)}
              type="password"
              maxLength={4096}
              placeholder="一次性交接码"
              spellCheck={false}
              className="font-mono text-xs"
              aria-label="一次性交接码"
            />
            <Button variant="outline" type="button" disabled={starting || ticket.trim().length === 0} onClick={() => void onRedeemTicket(ticket)}>
              兑换
            </Button>
          </div>
        </details>

        <div className="mt-5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-positive" aria-hidden />
          <span>{backendOrigin ? `后端 ${backendOrigin} 已连接` : "后端已连接"}</span>
          <span className="text-border">·</span>
          {credentialsConfigured === false ? (
            <button type="button" onClick={onOpenSettings} className="text-primary hover:underline">
              站点凭据未配置 → 去设置
            </button>
          ) : (
            <span>站点凭据{credentialsConfigured ? "已配置" : "状态未知"}</span>
          )}
        </div>
      </div>
    </section>
  )
}
