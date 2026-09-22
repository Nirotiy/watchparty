import { createContext, useContext, useEffect, useId, useRef, type ReactNode, type RefObject } from "react"
import { Toast, ToastBody, ToastTitle, ToastTrigger, Toaster, Button, useToastController, type ToastIntent } from "@fluentui/react-components"
import { DismissRegular } from "@fluentui/react-icons"

const NoticeContext = createContext<(message: string, intent?: ToastIntent) => void>(() => undefined)

export function ShellToastProvider({ children }: { children: ReactNode }) {
  const toasterId = useId()
  const { dispatchToast } = useToastController(toasterId)
  const recent = useRef({ message: "", at: 0 })
  function notify(message: string, intent: ToastIntent = "info") {
    if (!message || (recent.current.message === message && Date.now() - recent.current.at < 4000)) return
    recent.current = { message, at: Date.now() }
    dispatchToast(<Toast><ToastTitle action={<ToastTrigger><Button appearance="transparent" icon={<DismissRegular />} aria-label="关闭通知" /></ToastTrigger>}>{intent === "error" ? "操作未完成" : intent === "success" ? "已完成" : "通知"}</ToastTitle><ToastBody>{message}</ToastBody></Toast>, { intent, timeout: intent === "error" ? -1 : 3000 })
  }
  return <NoticeContext.Provider value={notify}>{children}<Toaster inline toasterId={toasterId} position="bottom-end" limit={1} className="shell-toaster" /></NoticeContext.Provider>
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
