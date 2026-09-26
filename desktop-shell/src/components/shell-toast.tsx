import { createContext, useContext, useEffect, useId, useRef, type ReactNode, type RefObject } from "react"
import { Toast, ToastBody, ToastTitle, ToastTrigger, Toaster, Button, useToastController, type ToastIntent } from "@fluentui/react-components"
import { DismissRegular } from "@fluentui/react-icons"

/** 通知位置：底部是壳的默认区（连接、外观、退出房间都往那儿走），
    顶部留给「你自己那块内容读不出来」这类需要当事人立刻处理的事（如大厅房间列表读失败）。 */
export type NoticePlacement = "bottom" | "top"
const NoticeContext = createContext<(message: string, intent?: ToastIntent, placement?: NoticePlacement) => void>(() => undefined)

export function ShellToastProvider({ children }: { children: ReactNode }) {
  const bottomId = useId()
  const topId = useId()
  const bottom = useToastController(bottomId)
  const top = useToastController(topId)
  const recent = useRef({ message: "", at: 0 })
  function notify(message: string, intent: ToastIntent = "info", placement: NoticePlacement = "bottom") {
    if (!message || (recent.current.message === message && Date.now() - recent.current.at < 4000)) return
    recent.current = { message, at: Date.now() }
    const dispatchToast = placement === "top" ? top.dispatchToast : bottom.dispatchToast
    dispatchToast(<Toast><ToastTitle action={<ToastTrigger><Button appearance="transparent" icon={<DismissRegular />} aria-label="关闭通知" /></ToastTrigger>}>{intent === "error" ? "操作未完成" : intent === "success" ? "已完成" : "通知"}</ToastTitle><ToastBody>{message}</ToastBody></Toast>, { intent, timeout: intent === "error" ? -1 : 3000 })
  }
  return <NoticeContext.Provider value={notify}>{children}<Toaster inline toasterId={bottomId} position="bottom-end" limit={1} className="shell-toaster" /><Toaster inline toasterId={topId} position="top-end" limit={1} className="shell-toaster shell-toaster-top" /></NoticeContext.Provider>
}

export function useShellToast() { return useContext(NoticeContext) }

// Only errors without a local owner need a shell-level fallback.
export function ShellStatusToast({ status, locallyHandledStatus }: {
  status: { text: string; tone: string }
  locallyHandledStatus: RefObject<boolean>
}) {
  const notify = useShellToast()
  const previous = useRef<typeof status | null>(null)
  useEffect(() => {
    if (status === previous.current) return
    previous.current = status
    const handled = locallyHandledStatus.current
    if (!handled && status.tone === "error") notify(status.text, "error")
  }, [status, locallyHandledStatus, notify])
  return null
}
