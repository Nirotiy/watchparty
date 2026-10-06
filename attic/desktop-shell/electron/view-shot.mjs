import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as wait } from 'node:timers/promises'

/**
 * M2-2/M2-3 视觉探针：种完成位后依次进「设置·基础」与「Linkle 大厅·创建对话框」，
 * 截图 + 读取关键控件的计算几何（Fluent Switch 拇指 / Checkbox 盒子 / 统一 tab 的
 * ARIA 与键盘切换），供人核对，不写任何产品状态。
 *
 *   node electron/launch.mjs --view-shot
 *
 * 说明：全新 profile 里 Linkle 没有凭据，工具条「创建房间」是禁用态；探针在 DOM 上
 * 临时解除禁用再点，只为把对话框渲染出来看 Checkbox 几何——窗口随即关闭，不落盘。
 */

export async function runViewShot(window) {
  const dir = await mkdtemp(join(tmpdir(), 'watchparty-view-shot-'))
  const js = source => window.webContents.executeJavaScript(source)
  const until = async (test, label, ms = 20000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await test()) return; await wait(100) }
    throw new Error(`timeout: ${label}`)
  }
  const frame = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const shot = async name => {
    const image = await window.webContents.capturePage()
    const target = join(dir, `${name}.png`)
    await writeFile(target, image.toPNG())
    console.log(`SHOT ${target}`)
  }
  const evidence = {}

  // 1) 设置·基础：统一 tab（下划线）与 Fluent Switch 覆写后的几何
  await js(`document.querySelector('.desktop-settings-link button[aria-label="设置"]')?.click()`)
  await until(() => js(`Boolean(document.querySelector('.fluent-settings-nav'))`), 'settings nav')
  await frame()
  await shot('settings-general')
  evidence.alignment = await js(`(() => {
    const center = node => { const rect = node.getBoundingClientRect(); return rect.top + rect.height / 2 }
    const round = value => Math.round(value * 10) / 10
    const navTitle = document.querySelector('.fluent-settings-nav-title')
    const activeTab = document.querySelector('.fluent-settings-nav [role="tab"][aria-selected="true"]')
    const indicator = document.querySelector('.fui-Switch__indicator')
    const knob = indicator ? indicator.firstElementChild : null
    const track = indicator ? indicator.getBoundingClientRect() : null
    const knobRect = knob ? knob.getBoundingClientRect() : null
    return {
      navTitleCenter: navTitle ? round(center(navTitle)) : null,
      activeTabCenter: activeTab ? round(center(activeTab)) : null,
      tabCenterOffset: navTitle && activeTab ? round(center(activeTab) - center(navTitle)) : null,
      switchTrack: track ? { w: Math.round(track.width), h: Math.round(track.height) } : null,
      switchKnob: knobRect ? { w: Math.round(knobRect.width), h: Math.round(knobRect.height) } : null,
      switchCenterOffset: track && knobRect ? round(knobRect.top + knobRect.height / 2 - (track.top + track.height / 2)) : null,
      switchLeftInset: track && knobRect ? Math.round(knobRect.left - track.left) : null,
      switchRightInset: track && knobRect ? Math.round(track.right - knobRect.right) : null,
    }
  })()`)

  console.log('VIEW_SHOT_PARTIAL ' + JSON.stringify(evidence))

  // 2) 键盘语义：焦点入选中 tab，ArrowRight 应移到下一项并切换（自动激活 + roving tabindex）
  // 先走 Electron 真键盘管道（keyCode 用加速器名 Right），不动再合成 DOM 事件兜底取证。
  const tabState = () => js(`(() => ({
    active: document.activeElement?.id ?? null,
    panelLabelledBy: document.getElementById('settings-panel')?.getAttribute('aria-labelledby') ?? null,
    tabs: Array.from(document.querySelectorAll('.fluent-settings-nav [role="tab"]')).map(tab => ({ id: tab.id, selected: tab.getAttribute('aria-selected'), tabindex: tab.getAttribute('tabindex'), controls: tab.getAttribute('aria-controls') })),
  }))()`)
  await js(`document.getElementById('settings-tab-general')?.focus()`)
  const tabs = { activeBeforeArrow: await js(`document.activeElement?.id ?? null`) }
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
  await frame(); await frame()
  tabs.afterSendInputEvent = await tabState()
  if (tabs.afterSendInputEvent.active === tabs.activeBeforeArrow) {
    await js(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`)
    await frame(); await frame()
    tabs.afterSyntheticEvent = await tabState()
  }
  evidence.tabs = tabs
  await shot('settings-after-arrow')
  console.log('VIEW_SHOT_PARTIAL ' + JSON.stringify(evidence))

  // 2.5) 设置·播放：B 版几何的滑杆（默认音量 compact / 字幕字号 default，两档几何已收敛）
  await js(`document.getElementById('settings-tab-playback')?.click()`)
  await until(() => js(`Boolean(document.querySelector('.fluent-settings-volume .winui-slider'))`), 'playback sliders')
  await frame()
  await shot('settings-playback')
  evidence.sliders = await js(`(() => {
    const read = root => {
      if (!root) return null
      const track = root.querySelector('.winui-slider-track')
      const thumb = root.querySelector('.winui-slider-thumb')
      const range = root.querySelector('.winui-slider-range')
      const box = node => { const rect = node.getBoundingClientRect(); return { w: Math.round(rect.width), h: Math.round(rect.height) } }
      return { variant: root.getAttribute('data-variant'), size: root.getAttribute('data-size'), track: box(track), thumb: box(thumb), fill: getComputedStyle(range).backgroundColor }
    }
    return { volume: read(document.querySelector('.fluent-settings-volume .winui-slider')), number: read(document.querySelector('.fluent-settings-slider .winui-slider')) }
  })()`)
  evidence.switchOff = await js(`(() => {
    const row = Array.from(document.querySelectorAll('.fluent-settings-row')).find(node => node.textContent.includes('ASS 样式覆盖'))
    const indicator = row?.querySelector('.fui-Switch__indicator')
    const knob = indicator?.firstElementChild
    if (!indicator || !knob) return null
    const track = indicator.getBoundingClientRect()
    const knobRect = knob.getBoundingClientRect()
    return {
      leftInset: Math.round(knobRect.left - track.left),
      rightInset: Math.round(track.right - knobRect.right),
      centerOffset: Math.round((knobRect.top + knobRect.height / 2 - track.top - track.height / 2) * 10) / 10,
    }
  })()`)
  console.log('VIEW_SHOT_PARTIAL ' + JSON.stringify(evidence))
  // 回到「基础」，避免带着焦点环影响后续截图
  await js(`document.getElementById('settings-tab-general')?.click()`)
  await frame()

  // 2.8) Banguru 首页（2026-10-02 方案 B）：单卡段选「加入/创建」；创建模式不再有房号输入
  await js(`document.querySelector('.desktop-service-nav button[aria-label="Banguru 一起看"]')?.click()`)
  await until(() => js(`Boolean(document.querySelector('.banguru-lobby'))`), 'banguru lobby', 30000)
  await frame(); await wait(300)
  await shot('banguru-join')
  evidence.banguruJoin = await js(`(() => ({
    segment: Array.from(document.querySelectorAll('.banguru-lobby .bh-seg button')).map(button => ({ text: button.textContent.trim(), pressed: button.getAttribute('aria-pressed') })),
    hasRoomField: Boolean(document.querySelector('.banguru-lobby #banguru-room-id')),
    joinButton: Array.from(document.querySelectorAll('.banguru-lobby button')).some(button => button.textContent.trim() === '加入房间'),
  }))()`)
  await js(`Array.from(document.querySelectorAll('.banguru-lobby .bh-seg button')).find(button => button.textContent.trim() === '创建')?.click()`)
  await frame(); await wait(300)
  await shot('banguru-create')
  evidence.banguruCreate = await js(`(() => ({
    hasRoomField: Boolean(document.querySelector('.banguru-lobby #banguru-room-id')),
    hint: document.querySelector('.banguru-lobby .bh-seg-hint')?.textContent ?? null,
    createButton: Array.from(document.querySelectorAll('.banguru-lobby button')).some(button => button.textContent.trim() === '创建房间'),
    legacyCombinedButton: Array.from(document.querySelectorAll('.banguru-lobby button')).some(button => button.textContent.trim() === '创建并进入'),
  }))()`)
  console.log('VIEW_SHOT_PARTIAL ' + JSON.stringify(evidence))

  // 3) Linkle 大厅创建对话框：Checkbox 覆写后 20px
  await js(`document.querySelector('.desktop-service-nav button[aria-label="Linkle 一起听"]')?.click()`)
  await until(() => js(`Boolean(document.querySelector('.linkle-lobby'))`), 'linkle lobby', 30000)
  await frame()
  await shot('linkle-lobby')
  // 3.0) 单连接卡（B 版）：未连接是游客表单 + 邀请码次行；连不上时探测读数与格式错误分开
  evidence.linkleConnect = await js(`(() => ({
    form: Boolean(document.querySelector('.lobby-connect-form')),
    originField: document.querySelector('input[aria-label="Linkle 服务器地址"]')?.value ?? null,
    nicknameField: document.querySelector('input[aria-label="Linkle 昵称"]')?.value ?? null,
    inviteRow: Boolean(document.querySelector('.lobby-invite input')),
    kv: Boolean(document.querySelector('.lobby-card .lobby-kv')),
    cardCount: document.querySelectorAll('.lobby-card').length,
  }))()`)
  await js(`(() => { const input = document.querySelector('input[aria-label="Linkle 服务器地址"]'); if (!input) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'http://127.0.0.1:1'); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await frame()
  await js(`Array.from(document.querySelectorAll('.lobby-card button')).find(button => button.textContent.trim().includes('检查服务器'))?.click()`)
  await until(() => js(`Boolean(document.querySelector('.lobby-card .lobby-note.no'))`), 'probe failure reading', 20000).catch(() => undefined)
  await frame(); await wait(300)
  await shot('linkle-probe-checked')
  evidence.linkleProbeFailure = await js(`document.querySelector('.lobby-card .lobby-note.no')?.textContent ?? null`)
  // 检查服务器只做只读探测：不得顺手提交连接表单，也不得改掉当前服务地址
  evidence.linkleProbeIsolated = await js(`(() => ({
    connectErrorBar: Boolean(document.querySelector('.lobby-card .lobby-connect-error')),
    kvServer: document.querySelector('.lobby-card .lobby-kv dd')?.textContent ?? null,
  }))()`)
  console.log('VIEW_SHOT_PARTIAL ' + JSON.stringify(evidence))
  // 3.1) 「服务与账号」面板两行：输入框与图标按钮的垂直居中
  await js(`Array.from(document.querySelectorAll('.lobby-card-actions button')).find(button => button.textContent.includes('服务与账号'))?.click()`)
  await until(() => js(`Boolean(document.querySelector('.lobby-account-panel input'))`), 'account panel')
  await frame()
  await shot('linkle-account-panel')
  evidence.serviceRows = await js(`(() => {
    const measure = (inputSelector, buttonSelector) => {
      const input = document.querySelector(inputSelector)
      const button = document.querySelector(buttonSelector)
      if (!input || !button) return null
      const box = node => { const rect = node.getBoundingClientRect(); return { cy: Math.round((rect.top + rect.height / 2) * 10) / 10, h: Math.round(rect.height) } }
      return { input: box(input), button: box(button), centerOffset: Math.round((box(button).cy - box(input).cy) * 10) / 10 }
    }
    return {
      serviceRow: measure('.lobby-account-panel input[aria-label="Linkle 服务地址"]', '.lobby-account-panel button[aria-label="保存服务"]'),
      inviteRow: measure('.lobby-account-panel input[aria-label="Linkle 邀请码"]', '.lobby-account-panel button[aria-label="兑换并进入"]'),
    }
  })()`)
  console.log('VIEW_SHOT_PARTIAL ' + JSON.stringify(evidence))
  await js(`document.querySelector('.lobby-head-right button[aria-label="返回服务器信息"]')?.click()`)
  await frame()
  evidence.createClick = await js(`(() => {
    const buttons = Array.from(document.querySelectorAll('.lobby-rooms-actions button'))
    const button = buttons.find(item => item.textContent.includes('创建房间'))
    if (!button) return { found: false, seen: buttons.map(item => item.textContent.trim()) }
    const wasDisabled = button.disabled
    button.disabled = false
    button.click()
    const afterDomClick = Boolean(document.querySelector('.lobby-dialog[open]'))
    if (!afterDomClick) {
      // DOM 点击没生效时，直达 React 的 onClick 再试一次（诊断用，不改产品代码路径）
      const propsKey = Object.keys(button).find(key => key.startsWith('__reactProps'))
      button[propsKey]?.onClick?.({})
      return { found: true, wasDisabled, afterDomClick, afterReactProps: Boolean(document.querySelector('.lobby-dialog[open]')) }
    }
    return { found: true, wasDisabled, afterDomClick }
  })()`)
  console.log('VIEW_SHOT_CREATE_CLICK ' + JSON.stringify(evidence.createClick))
  await until(() => js(`Boolean(document.querySelector('.lobby-dialog[open]'))`), 'create dialog', 15000)
  await frame()
  await shot('linkle-create-dialog')
  evidence.checkbox = await js(`(() => {
    const indicator = document.querySelector('.lobby-dialog .fui-Checkbox__indicator')
    if (!indicator) return null
    const rect = indicator.getBoundingClientRect()
    const style = getComputedStyle(indicator)
    return { w: Math.round(rect.width), h: Math.round(rect.height), radius: style.borderRadius, fontSize: style.fontSize }
  })()`)
  await js(`Array.from(document.querySelectorAll('.lobby-dialog footer button')).find(button => button.textContent.includes('取消'))?.click()`)

  console.log('VIEW_SHOT_EVIDENCE ' + JSON.stringify(evidence, null, 2))
  console.log('VIEW_SHOT_DIR ' + dir)
}
