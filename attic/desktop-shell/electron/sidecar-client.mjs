import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

/** Correlates bounded stdio frames; process failure rejects every pending request. */
export class SidecarClient extends EventEmitter {
  #child
  #pending = new Map()
  #nextId = 0
  #buffer = ''
  #closed = false
  constructor(executable, args) {
    super()
    this.#child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', chunk => {
      this.#buffer += chunk
      if (Buffer.byteLength(this.#buffer) > 2 * 1024 * 1024) return this.#fail()
      let end
      while ((end = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, end)
        this.#buffer = this.#buffer.slice(end + 1)
        try {
          const message = JSON.parse(line)
          if (typeof message.event === 'string') { this.emit('event', message.event, message.payload); continue }
          const pending = this.#pending.get(message.id)
          if (!pending) continue
          this.#pending.delete(message.id)
          clearTimeout(pending.timer)
          if (Object.hasOwn(message, 'error')) pending.reject(message.error)
          else pending.resolve(message.result)
        } catch { this.#fail(); return }
      }
    })
    this.#child.on('error', () => this.#fail())
    this.#child.on('exit', () => this.#fail())
    this.#child.stdin.on('error', () => this.#fail())
  }
  request(method, args = {}) {
    if (this.#closed) return Promise.reject(new Error('desktop_runtime_unavailable'))
    if (this.#pending.size >= 32) return Promise.reject(new Error('desktop_busy'))
    const id = ++this.#nextId
    const frame = JSON.stringify({ id, method, args }) + '\n'
    if (Buffer.byteLength(frame) > 1024 * 1024) return Promise.reject(new Error('desktop_request_too_large'))
    return new Promise((resolve, reject) => {
      // Receive intentionally waits for the next server event; shutdown cancels it natively.
      const timer = method === 'musicPartyWsReceive' ? undefined : setTimeout(() => this.#fail(), 45000)
      this.#pending.set(id, { resolve, reject, timer })
      this.#child.stdin.write(frame)
    })
  }
  async close() {
    if (this.#closed) return
    const deadline = setTimeout(() => this.#fail(), 5000)
    try { await this.request('__shutdown') } catch {} finally {
      clearTimeout(deadline)
      this.#child.stdin.end()
      this.#fail()
    }
  }
  #fail() {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('desktop_runtime_unavailable'))
    }
    this.#pending.clear()
    this.#child.kill()
    this.emit('closed')
  }
}
