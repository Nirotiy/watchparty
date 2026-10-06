import * as React from "react"

import { Button } from "@/components/ui/button"

/**
 * 顶层渲染兜底（M2 键盘与读屏批）：任一组件渲染期异常不再白屏，给出可恢复的说明与重新载入。
 * 只接渲染与生命周期错误；事件处理器中的异常由各自路径与主进程的进程级兜底负责。
 */
export class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(JSON.stringify({ event: "renderer-render-error", message: error.message, stack: info.componentStack }))
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid min-h-screen place-items-center bg-[var(--base)] px-6 text-[var(--text-primary)]">
        <div className="w-full max-w-lg">
          <h1 className="text-xl font-semibold">界面出错了</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">这一步没法继续渲染。重新载入界面即可恢复；房间会话与播放不受影响。</p>
          <p className="mt-2 break-all font-mono text-xs text-[var(--text-disabled)]">{this.state.error.message}</p>
          <div className="mt-5"><Button variant="accent" onClick={() => window.location.reload()}>重新载入界面</Button></div>
        </div>
      </div>
    )
  }
}
