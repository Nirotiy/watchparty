import { useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface SessionGateProps {
  roomId: string | null
  starting: boolean
  onStart: (ticket: string) => Promise<boolean>
}

export function SessionGate({ roomId, starting, onStart }: SessionGateProps) {
  const [ticket, setTicket] = useState("")

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = ticket.trim()
    if (!value || starting) return
    if (await onStart(value)) setTicket("")
  }

  return (
    <section className="mt-5 max-w-[680px]" aria-labelledby="join-title">
      <h2 id="join-title" className="sr-only">从网页接续观看</h2>
      <form autoComplete="off" onSubmit={submit}>
        <div className="flex gap-2">
          <Input
            id="handoff-ticket"
            name="ticket"
            type="password"
            value={ticket}
            onChange={(event) => setTicket(event.currentTarget.value)}
            maxLength={4096}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            required
            placeholder={roomId ? `房间 /${roomId} 的一次性交接码` : "粘贴一次性交接码…"}
            className="h-9 font-mono text-xs"
          />
          <Button className="h-9 px-5" type="submit" disabled={starting || ticket.trim().length === 0}>
            {starting ? "正在加入" : "加入或开播"}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">当前识别一次性交接码；房号、链接和自动开播将在受限原生 IPC 就绪后开放。</p>
      </form>
    </section>
  )
}
