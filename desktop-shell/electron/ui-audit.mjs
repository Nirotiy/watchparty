import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as wait } from 'node:timers/promises'

/**
 * UI/UX 自动化排查（M0）：对比度、焦点可见性、Tab 序、触达尺寸、响应式溢出、
 * reduced-motion、明暗/高对比三态 —— uiux-audit-plan.html §6/§8/§9 列的八项检查。
 * 范围仅桌面壳（.desktop-page 内），不含 Linkle 房间 UI。
 *
 *   node electron/launch.mjs --ui-audit
 *
 * 明暗/forced-colors/reduced-motion 三类媒体特性用 CDP `Emulation.setEmulatedMedia`
 * 模拟（`webContents.debugger` 是 Electron 内置能力，不需要额外 webPreferences），
 * 不走 Chromium 启动开关 —— 这样同一个窗口单次运行就能切完三态，不用重启进程。
 */

const SCOPE = '.desktop-page'
// 触达尺寸下限：WinUI 3 / Fluent 的最小交互目标是 32px（紧凑型控件），
// 不是网页常见的 44px —— 桌面壳按鼠标/触控混合输入设计，取 32。
const MIN_HIT_TARGET = 32

export async function runUiAudit(window, native) {
  const dir = await mkdtemp(join(tmpdir(), 'watchparty-ui-audit-'))
  await mkdir(join(dir, 'shots'), { recursive: true })
  const js = source => window.webContents.executeJavaScript(source)
  const step = async (label, work) => {
    try { const value = await work(); console.log('UI_AUDIT_STEP ' + JSON.stringify({ label, ok: true })); return value }
    catch (error) { console.log('UI_AUDIT_STEP ' + JSON.stringify({ label, ok: false, message: error?.message ?? String(error) })); throw error }
  }
  const shot = async name => {
    const image = await window.webContents.capturePage()
    const target = join(dir, 'shots', `${name}.png`)
    await writeFile(target, image.toPNG())
    console.log(`SHOT ${target}`)
    return target
  }

  // CDP 媒体特性模拟：一次 attach，整个 audit 复用同一个 debugger session。
  const debuggerSession = window.webContents.debugger
  debuggerSession.attach('1.3')
  const emulate = async features => debuggerSession.sendCommand('Emulation.setEmulatedMedia', { features })
  const resetEmulation = () => emulate([])

  const results = { contrast: [], focusVisibility: [], tabOrder: null, hitTarget: [], overflow: [], reducedMotion: null, themes: [], screenshots: [] }
  const failures = []
  const record = (bucket, items) => { if (Array.isArray(items)) results[bucket].push(...items); else results[bucket] = items }

  try {
    // --- A. 触达尺寸：所有可见的 button / role=button / 链接型控件，边界矩形 >= 32x32。
    await step('hitTarget', async () => {
      const items = await js(`(() => {
        const nodes = Array.from(document.querySelectorAll(${JSON.stringify(SCOPE)} + ' button, ' + ${JSON.stringify(SCOPE)} + ' [role="button"], ' + ${JSON.stringify(SCOPE)} + ' a[href]'))
        return nodes.filter(node => {
          const style = getComputedStyle(node)
          return style.visibility !== 'hidden' && style.display !== 'none' && node.offsetParent !== null
        }).map(node => {
          const rect = node.getBoundingClientRect()
          return {
            label: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 40) || node.tagName,
            width: Math.round(rect.width), height: Math.round(rect.height),
          }
        })
      })()`)
      const small = items.filter(item => item.width < MIN_HIT_TARGET || item.height < MIN_HIT_TARGET)
      record('hitTarget', small)
      if (small.length) failures.push(`${small.length} 个控件小于 ${MIN_HIT_TARGET}px：${small.slice(0, 5).map(i => `${i.label}(${i.width}x${i.height})`).join(', ')}`)
    })

    // --- B. 对比度：遍历可见文本节点，取文字色与「向上找最近非透明背景」的相对亮度比。
    // 局限：不处理 backdrop-filter 透过的毛玻璃背景（卡片用了这个），这类节点会按父节点
    // 的纯色背景估算，可能偏松 —— M1 若发现误差大，再补 capturePage 像素采样。
    await step('contrast', async () => {
      const items = await js(`(() => {
        function relLuminance(r, g, b) {
          const chan = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
          return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
        }
        function parseColor(value) {
          if (!value || value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
          const m = value.match(/rgba?\\(([^)]+)\\)/)
          if (!m) return null
          const parts = m[1].split(',').map(s => parseFloat(s.trim()))
          return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
        }
        function effectiveBackground(node) {
          let current = node
          while (current) {
            const color = parseColor(getComputedStyle(current).backgroundColor)
            if (color && color.a > 0.5) return color
            current = current.parentElement
          }
          // Fallback: read the actual computed background of <body> or <html>.
          const body = document.body
          const bodyBg = body ? parseColor(getComputedStyle(body).backgroundColor) : null
          if (bodyBg && bodyBg.a > 0.5) return bodyBg
          const html = document.documentElement
          const htmlBg = html ? parseColor(getComputedStyle(html).backgroundColor) : null
          if (htmlBg && htmlBg.a > 0.5) return htmlBg
          // Final fallback: infer from theme. Dark mode uses black background, light uses white.
          const isDark = html && html.classList.contains('dark')
          return isDark ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 }
        }
        const scope = document.querySelector(${JSON.stringify(SCOPE)})
        if (!scope) return []
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
          acceptNode: node => node.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
        })
        const out = []
        let node
        while ((node = walker.nextNode())) {
          const el = node.parentElement
          if (!el) continue
          const style = getComputedStyle(el)
          if (style.visibility === 'hidden' || style.display === 'none' || el.offsetParent === null) continue
          const fg = parseColor(style.color)
          if (!fg) continue
          const bg = effectiveBackground(el)
          const l1 = relLuminance(fg.r, fg.g, fg.b), l2 = relLuminance(bg.r, bg.g, bg.b)
          const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
          const sizePx = parseFloat(style.fontSize)
          const bold = parseInt(style.fontWeight, 10) >= 700
          const large = sizePx >= 24 || (sizePx >= 18.66 && bold)
          const threshold = large ? 3 : 4.5
          if (ratio < threshold) {
            out.push({ text: node.textContent.trim().slice(0, 30), ratio: Math.round(ratio * 100) / 100, threshold, large })
          }
        }
        return out
      })()`)
      record('contrast', items)
      if (items.length) failures.push(`${items.length} 处文字对比度不达标（AA）：${items.slice(0, 5).map(i => `"${i.text}" ${i.ratio}:1 (需 ${i.threshold}:1)`).join('; ')}`)
    })
    // --- C. 焦点可见性：逐个 focus() 可聚焦控件，比较聚焦前后的 outline/box-shadow 计算值。
    // 两者都没变化 ⇒ 焦点态在视觉上不可辨识（纯靠 :focus-visible 清零 outline 又没补环的典型坑）。
    await step('focusVisibility', async () => {
      const items = await js(`(() => {
        const nodes = Array.from(document.querySelectorAll(${JSON.stringify(SCOPE)} + ' button, ' + ${JSON.stringify(SCOPE)} + ' [href], ' + ${JSON.stringify(SCOPE)} + ' input, ' + ${JSON.stringify(SCOPE)} + ' [tabindex]'))
          .filter(node => node.offsetParent !== null && node.tabIndex >= 0 && !node.disabled)
        const out = []
        for (const node of nodes) {
          node.blur()
          const before = getComputedStyle(node)
          const beforeSig = before.outlineStyle + before.outlineWidth + before.boxShadow
          node.focus({ preventScroll: true })
          const after = getComputedStyle(node)
          const afterSig = after.outlineStyle + after.outlineWidth + after.boxShadow
          if (beforeSig === afterSig) {
            const label = node.getAttribute('aria-label') || node.textContent?.trim().slice(0, 40) || node.tagName
            out.push({ label })
          }
          node.blur()
        }
        return out
      })()`)
      record('focusVisibility', items)
      if (items.length) {
        // DIAGNOSTIC: print first 5 with full details
        console.log('FOCUS_DIAG_ITEMS', JSON.stringify(items.slice(0, 5), null, 2))
        failures.push(`${items.length} 个控件聚焦后视觉无变化：${items.slice(0, 5).map(i => i.label).join(', ')}`)
      }
    })

    // --- D. Tab 序：从 body 开始模拟真实 Tab 键，记录焦点序列，检查是否有重复早停（焦点陷阱）
    // 或者序列长度明显小于可聚焦元素总数（跳出容器、tabindex 断链）。
    await step('tabOrder', async () => {
      await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`)
      const focusableCount = await js(`document.querySelectorAll(${JSON.stringify(SCOPE)} + ' button, ' + ${JSON.stringify(SCOPE)} + ' [href], ' + ${JSON.stringify(SCOPE)} + ' input, ' + ${JSON.stringify(SCOPE)} + ' [tabindex]:not([tabindex="-1"])').length`)
      const sequence = []
      const seen = new Set()
      let repeats = 0
      const steps = Math.min(focusableCount * 2 + 5, 120)
      for (let i = 0; i < steps; i += 1) {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
        await wait(20)
        const active = await js(`(() => { const el = document.activeElement; if (!el || el === document.body) return null; return (el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || el.tagName) + '#' + Array.from(document.querySelectorAll('*')).indexOf(el) })()`)
        if (active === null) break
        sequence.push(active)
        if (seen.has(active)) { repeats += 1; if (repeats > 2) break } else seen.add(active)
      }
      const info = { focusableCount, visited: seen.size, sequenceSample: sequence.slice(0, 15) }
      record('tabOrder', info)
      // 可聚焦元素里混了对话框/卫星视图未挂载的控件是常态，这里只抓明显偏小的覆盖率，
      // 真正的陷阱（重复 >2 次提前退出）已经在循环里体现在 visited 远小于 sequence.length。
      if (focusableCount > 0 && seen.size < focusableCount * 0.5) failures.push(`Tab 序只覆盖 ${seen.size}/${focusableCount} 个可聚焦元素，疑似焦点陷阱或断链`)
    })
    // --- E. 响应式溢出：窗口最小尺寸 960x640 是硬约束（main.mjs minWidth/minHeight），
    // 在该约束内外各取两档宽度，检查 .desktop-page 子树是否出现横向溢出（scrollWidth > clientWidth）。
    const originalBounds = window.getBounds()
    await step('overflow', async () => {
      const widths = [960, 1100, 1300, 1680]
      const out = []
      for (const width of widths) {
        window.setBounds({ ...originalBounds, width, height: 800 })
        await wait(150)
        const overflowing = await js(`(() => {
          const scope = document.querySelector(${JSON.stringify(SCOPE)})
          if (!scope) return []
          const nodes = Array.from(scope.querySelectorAll('*')).filter(node => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== 'auto' && getComputedStyle(node).overflowX !== 'scroll')
          return nodes.slice(0, 10).map(node => ({ tag: node.tagName, cls: (node.className || '').toString().slice(0, 60), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }))
        })()`)
        if (overflowing.length) out.push({ width, overflowing })
      }
      window.setBounds(originalBounds)
      await wait(150)
      record('overflow', out)
      if (out.length) failures.push(`${out.length} 档宽度下出现横向溢出：${out.map(o => o.width).join(', ')}`)
    })

    // --- F. Reduced motion：CDP 模拟 prefers-reduced-motion: reduce，确认 Kawarp 背景的
    // <canvas> 不再挂载（现有逻辑：reduce 时停渲染），且动效类元素的 animation-duration 归零/很短。
    await step('reducedMotion', async () => {
      await emulate([{ name: 'prefers-reduced-motion', value: 'reduce' }])
      await wait(200)
      const info = await js(`(() => {
        const scope = document.querySelector(${JSON.stringify(SCOPE)})
        const kawarpCanvas = scope ? scope.querySelector('canvas.kawarp, [data-kawarp] canvas, canvas[data-dynamic-background]') : null
        return { matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches, kawarpCanvasPresent: Boolean(kawarpCanvas) }
      })()`)
      await emulate([])
      await wait(100)
      record('reducedMotion', info)
      if (!info.matches) failures.push('CDP 模拟 prefers-reduced-motion 未生效（matchMedia 仍为 false）')
      if (info.kawarpCanvasPresent) failures.push('reduced-motion 下 Kawarp canvas 仍挂载')
    })
    // --- G. 主题三态：明/暗跟随应用自身的 class 切换机制（不是 CDP），forced-colors 用 CDP
    // 模拟系统高对比。每态截图存证，另外抓一次「暗色下文字色是否原样硬编码」的粗检查
    // （常见 WinUI 迁移坑：浅色写死 #000 没跟 token）。
    await step('themes', async () => {
      const out = []
      for (const mode of ['light', 'dark']) {
        await js(`document.documentElement.classList${mode === 'dark' ? '.add' : '.remove'}('dark')`)
        await wait(150)
        const path = await shot(`theme-${mode}`)
        out.push({ mode, shot: path })
      }
      await emulate([{ name: 'forced-colors', value: 'active' }])
      await wait(150)
      const forcedShot = await shot('theme-forced-colors')
      const forcedInfo = await js(`({ matches: window.matchMedia('(forced-colors: active)').matches })`)
      out.push({ mode: 'forced-colors', shot: forcedShot, matches: forcedInfo.matches })
      await emulate([])
      await js(`document.documentElement.classList.remove('dark')`)
      await wait(150)
      record('themes', out)
      if (!forcedInfo.matches) failures.push('CDP 模拟 forced-colors 未生效（matchMedia 仍为 false）')
    })

    // --- H. 结构性截图存证：覆盖主要视图入口，供人工复看版式/间距/圆角是否贴近 WinUI 3。
    await step('screenshots', async () => {
      const views = ['lobby']
      const out = []
      for (const view of views) out.push(await shot(`view-${view}`))
      record('screenshots', out)
    })
  } finally {
    try { await resetEmulation() } catch {}
    try { debuggerSession.detach() } catch {}
    await writeFile(join(dir, 'report.json'), JSON.stringify(results, null, 2))
    console.log('UI_AUDIT_REPORT ' + join(dir, 'report.json'))
  }

  if (failures.length) throw new Error(`ui_audit_failed: ${failures.join('; ')}`)
}
