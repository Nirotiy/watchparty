import assert from 'node:assert/strict'
import { setTimeout as wait } from 'node:timers/promises'

// G5：首启向导（形态 A）端到端检查。
// 交给它的一定是全新 profile（main.mjs 单独分支、不种 setupCompleted），所以向导必然出现。
// 全流程只用既有 IPC，地址用必然失败的 http://127.0.0.1:9，不连任何真实 Banguru / Linkle 服务。
// 断言口径见 temp-html/setup-guide-frontend-handoff.md §5；按钮一律在向导根节点内查找，
// 不要用全文档 endsWith 文本匹配（那正是 --acceptance 第一次点到向导按钮的坑）。

const GUIDE = 'section[aria-label="首次使用设置向导"]'
const FAILED_ORIGIN = 'http://127.0.0.1:9'
const RETIRED_PORTS = ['18381', '18082']

async function until(test, label, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test()) return; await wait(100) }
  throw new Error(`timeout: ${label}`)
}

export async function runSetupGuideCheck(window, native) {
  const js = code => window.webContents.executeJavaScript(code)
  const root = JSON.stringify(GUIDE)
  // 等 React 提交完状态再读 DOM：两帧足够，短 sleep 会让断言空转（播放条那次的教训）。
  const frame = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const settings = () => js("window.watchpartyDesktop.invoke('getDesktopSettings')")
  const guidePresent = () => js(`Boolean(document.querySelector(${root}))`)
  const guideAbsent = () => js(`document.querySelector(${root}) === null`)
  const guideText = () => js(`document.querySelector(${root})?.textContent ?? ''`)
  /** 只在向导内部求值；向导已卸载时返回 null。 */
  const guideEval = body => js(`(() => { const guide = document.querySelector(${root}); if (!guide) return null; ${body} })()`)
  const buttonState = text => guideEval(`const button = Array.from(guide.querySelectorAll('button')).find(item => item.textContent.trim().endsWith(${JSON.stringify(text)}))
    return button ? { found: true, disabled: button.disabled, label: button.textContent.trim() } : { found: false }`)
  const clickButton = async (text, when) => {
    const clicked = await guideEval(`const button = Array.from(guide.querySelectorAll('button')).find(item => item.textContent.trim().endsWith(${JSON.stringify(text)}))
      if (!button) return false
      button.click()
      return true`)
    assert.equal(clicked, true, `${when}：向导里找不到按钮「${text}」`)
    await frame()
  }
  const assertButton = async (text, disabled, when) => {
    const state = await buttonState(text)
    assert.ok(state.found, `${when}：向导里找不到按钮「${text}」`)
    assert.equal(state.disabled, disabled, `${when}：「${text}」disabled=${state.disabled}，期望 ${disabled}`)
    return state
  }
  /** 步骤条：{ count, current, labels }，current 是 li[aria-current="step"] 的下标。 */
  const rail = () => guideEval(`const items = Array.from(guide.querySelectorAll('ol[aria-label="设置进度"] li'))
    return { count: items.length, current: items.findIndex(item => item.getAttribute('aria-current') === 'step'), labels: items.map(item => item.textContent.trim()) }`)
  const fill = (selector, value) => guideEval(`const input = guide.querySelector(${JSON.stringify(selector)})
    if (!input) throw new Error('missing_input: ' + ${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value`)
  /** 每个步骤都扫一遍：退役端口 18381 / 18082 不得出现在向导文案里。 */
  const scanRetiredPorts = async when => {
    const text = await guideText()
    for (const port of RETIRED_PORTS) assert.ok(!text.includes(port), `${when}：向导文案出现退役端口 ${port}`)
  }

  const evidence = { failedOrigin: FAILED_ORIGIN, steps: [] }

  // 首启：全新 profile 里完成位必须是 false，向导必须直接顶在首屏。
  assert.equal((await settings()).setupCompleted, false, '首启完成位应为 false：harness 不得预置种子')
  await until(guidePresent, 'setup guide on a brand new profile')

  // 1. 第 1 步：5 步步骤条停在第一步，地址不预填，下一步禁用，侧栏两个服务入口禁用。
  const firstRail = await rail()
  assert.equal(firstRail.count, 5, `步骤条应有 5 步：${JSON.stringify(firstRail)}`)
  assert.equal(firstRail.current, 0, `首启应停在第 1 步：${JSON.stringify(firstRail)}`)
  assert.ok(firstRail.labels[0].includes('Banguru 服务器'), `第 1 步标题不对：${JSON.stringify(firstRail.labels)}`)
  assert.equal(await js(`document.querySelector('#setup-banguru-origin')?.value ?? null`), '', '首启地址框不得预填')
  await assertButton('下一步：验证连接', true, '地址为空时')
  const sidebar = await js(`(() => { const pick = label => document.querySelector('aside.desktop-sidebar button[aria-label="' + label + '"]')?.disabled ?? null
    return { banguru: pick('Banguru 一起看'), linkle: pick('Linkle 一起听') } })()`)
  assert.equal(sidebar.banguru, true, '向导期间侧栏 Banguru 入口应禁用')
  assert.equal(sidebar.linkle, true, '向导期间侧栏 Linkle 入口应禁用')
  await scanRetiredPorts('第 1 步')
  evidence.steps.push({ step: 1, rail: firstRail.labels })

  // 2. 填一个必然连不上的地址：验证失败文案出现，且「保存并继续」只进下一步、不写完成位。
  assert.equal(await fill('#setup-banguru-origin', FAILED_ORIGIN), FAILED_ORIGIN)
  await assertButton('下一步：验证连接', false, '地址非空时')
  await clickButton('下一步：验证连接', '第 1 步')
  await until(async () => (await rail())?.current === 1, 'verify step')
  await until(async () => (await guideText()).includes('无法连接'), 'verify failure copy', 30000)
  const verifyText = await guideText()
  assert.ok(verifyText.includes(FAILED_ORIGIN), `失败文案应带上目标地址：${verifyText.slice(0, 200)}`)
  await scanRetiredPorts('第 2 步')
  evidence.steps.push({ step: 2, failureCopy: verifyText.includes('无法连接') })
  await clickButton('保存并继续', '第 2 步')
  await until(async () => (await rail())?.current === 2, 'account step')
  assert.equal((await settings()).setupCompleted, false, '验证失败后「保存并继续」不得写完成位')
  await scanRetiredPorts('第 3 步')

  // 3. 昵称：全新 profile 预置一个 8 位字母数字 ID（不再是空框），清空后仍拦截。
  // loadInitial 是异步的，先等默认值落到输入框，避免与首帧空值赛跑。
  await until(async () => /^[a-z0-9]{8}$/.test(await js(`document.querySelector('#setup-nickname')?.value ?? ''`)), 'generated nickname default lands')
  const seeded = await js(`(() => { const node = document.querySelector('#setup-nickname'); return node ? node.value : null })()`)
  assert.ok(typeof seeded === 'string' && /^[a-z0-9]{8}$/.test(seeded), `全新 profile 应预置 8 位字母数字昵称，实际：${JSON.stringify(seeded)}`)
  await assertButton('下一步：Linkle 服务器', false, '昵称已预置时')
  assert.equal(await fill('#setup-nickname', ''), '')
  await frame()
  await assertButton('下一步：Linkle 服务器', true, '昵称为空时')
  assert.equal(await fill('#setup-nickname', 'GuideCheck'), 'GuideCheck')
  await frame()
  await assertButton('下一步：Linkle 服务器', false, '昵称非空时')
  await clickButton('下一步：Linkle 服务器', '第 3 步')
  await until(async () => (await rail())?.current === 3, 'linkle origin step')
  evidence.steps.push({ step: 3, defaultNickname: seeded, nickname: 'GuideCheck' })

  // 4. Linkle 是可选的：可整体跳过，仍停在正确的端口口径上（18380 保留，退役端口不出现）。
  const linkleText = await guideText()
  assert.ok(linkleText.includes('18380'), 'Linkle 步骤应保留本地栈 18380 文案')
  await scanRetiredPorts('第 4 步')
  await clickButton('跳过 Linkle', '第 4 步')

  // 5. 卸向导 → 完成位落盘 → 大厅横幅显示刚保存的站点。
  await until(guideAbsent, 'guide unmounts after 跳过 Linkle')
  const finished = await settings()
  assert.equal(finished.setupCompleted, true, '跳过 Linkle 后完成位应为 true')
  assert.equal(finished.nickname, 'GuideCheck', `昵称应落盘：${finished.nickname}`)
  assert.equal(finished.backendOrigin, FAILED_ORIGIN, `第 1 步保存的站点应保留：${finished.backendOrigin}`)
  await until(() => js(`Boolean(Array.from(document.querySelectorAll('.banguru-lobby button')).find(button => button.textContent.trim() === '重新配置'))`), 'lobby reconfigure banner')
  const banner = await js(`(() => { const button = Array.from(document.querySelectorAll('.banguru-lobby button')).find(item => item.textContent.trim() === '重新配置'); return button?.parentElement?.textContent?.trim() ?? null })()`)
  assert.ok(banner.includes('配置完成'), `大厅横幅应显示配置完成：${banner}`)
  assert.ok(banner.includes(FAILED_ORIGIN), `大厅横幅应显示已保存站点：${banner}`)
  evidence.banner = banner

  // 6. 重新配置＝只重置完成位：向导再现、已存配置还在（地址回填、昵称没被清）。
  await js(`(() => { const button = Array.from(document.querySelectorAll('.banguru-lobby button')).find(item => item.textContent.trim() === '重新配置'); button.click(); return true })()`)
  await until(guidePresent, 'guide reappears after 重新配置')
  const reconfigured = await settings()
  assert.equal(reconfigured.setupCompleted, false, '重新配置后完成位应为 false')
  assert.equal(reconfigured.nickname, 'GuideCheck', '重新配置不得清掉昵称')
  assert.equal(reconfigured.backendOrigin, FAILED_ORIGIN, '重新配置不得清掉站点地址')
  await until(async () => (await js(`document.querySelector('#setup-banguru-origin')?.value ?? null`)) === FAILED_ORIGIN, 'reconfigure preloads the saved origin')
  const reconfiguredRail = await rail()
  assert.equal(reconfiguredRail.current, 0, `重新配置应回到第 1 步：${JSON.stringify(reconfiguredRail)}`)
  await scanRetiredPorts('重新配置后')
  evidence.reconfigured = { nickname: reconfigured.nickname, origin: reconfigured.backendOrigin }

  // 7. 「跳过向导」也能收尾，并且不动已存配置。
  await clickButton('跳过向导', '重新配置后的第 1 步')
  await until(guideAbsent, 'guide unmounts after 跳过向导')
  const skipped = await settings()
  assert.equal(skipped.setupCompleted, true, '跳过向导后完成位应为 true')
  assert.equal(skipped.nickname, 'GuideCheck', '跳过向导不得清掉昵称')
  assert.equal(skipped.backendOrigin, FAILED_ORIGIN, '跳过向导不得清掉站点地址')
  // 8. 收尾再扫一遍首屏：向导卸载后退役端口同样不该留在壳里。
  const shellText = await js(`document.querySelector('.desktop-page')?.textContent ?? ''`)
  for (const port of RETIRED_PORTS) assert.ok(!shellText.includes(port), `首屏出现退役端口 ${port}`)

  console.log(JSON.stringify({ check: 'setup-guide-first-run', ...evidence }))
  console.log('SETUP_GUIDE_CHECK_OK')
}
