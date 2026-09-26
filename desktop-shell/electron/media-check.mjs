import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as wait } from 'node:timers/promises'

/** 只给加源用例补凭据：从仓库根 .env 读，值不落日志、不进断言消息。 */
async function openlistLogin() {
  try {
    const env = await readFile(new URL('../../.env', import.meta.url), 'utf8')
    const read = name => env.split(/\r?\n/).find(line => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? ''
    return { username: read('OPENLIST_USERNAME'), password: read('OPENLIST_PASSWORD') }
  } catch {
    return { username: '', password: '' }
  }
}

/**
 * Media library acceptance (multi-source phase 1) against a **real local stack**, not a
 * fixture: real libraries, real files, real screenshot. The folder browser only exists
 * inside a room, so this enters one first.
 *
 *   node electron/launch.mjs --media-check
 *
 * Env: WATCHPARTY_MEDIA_CHECK_ORIGIN (default http://127.0.0.1:8080).
 */
export async function runMediaCheck(window, native) {
  const invoke = (command, args = {}) => window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`)
  const js = source => window.webContents.executeJavaScript(source)
  async function until(check, label, timeout = 20000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { if (await check()) return; await wait(100) }
    throw new Error(label)
  }
  const origin = process.env.WATCHPARTY_MEDIA_CHECK_ORIGIN?.trim() || 'http://127.0.0.1:8080'
  const step = async (label, work) => {
    try { const value = await work(); console.log('MEDIA_CHECK_STEP ' + JSON.stringify({ label, ok: true })); return value }
    catch (error) { console.log('MEDIA_CHECK_STEP ' + JSON.stringify({ label, ok: false, code: error?.code ?? null, message: error?.message ?? String(error) })); throw error }
  }
  const settings = await step('getDesktopSettings', () => invoke('getDesktopSettings'))
  // 首启向导会占住 home 视图，大厅 UI 就不存在：本 harness 自带临时 profile，直接置完成位。
  await step('updateDesktopSettings', () => invoke('updateDesktopSettings', { input: {
    backendOrigin: origin, allowRemoteHttp: settings.allowRemoteHttp, nickname: settings.nickname,
    theme: settings.theme, windowMaterial: settings.windowMaterial,
    playerPreferences: settings.playerPreferences, setupCompleted: true,
  } }))
  await step('verifyBackend', () => invoke('verifyBackend'))
  // 上一轮跑挂在中途时可能留下测试源：先清干净，这一轮的行数断言才有意义。
  await purgeTestSources(invoke)
  // 写设置是异步进 React 的（native 广播 desktop://settings），大厅得等它换掉向导。
  await until(() => js(`Boolean(document.querySelector('.banguru-lobby'))`), 'banguru lobby', 15000)
  // 走大厅 UI 建房（只有 UI 那条路才会把视图切进房间）：昵称 + 「创建并进入」。
  await step('lobby-create-room', () => js(`(() => {
    const lobby = document.querySelector('.banguru-lobby')
    if (!lobby) throw new Error('banguru lobby missing')
    const input = Array.from(lobby.querySelectorAll('input')).find(node => node.placeholder === '显示给房间成员')
    if (!input) throw new Error('nickname field missing')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'MediaCheck')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`))
  await until(() => js(`(() => { const button = Array.from(document.querySelectorAll('.banguru-lobby button')).find(node => node.textContent.trim() === '创建并进入'); return Boolean(button && !button.disabled) })()`), 'lobby create enabled')
  await js(`Array.from(document.querySelectorAll('.banguru-lobby button')).find(node => node.textContent.trim() === '创建并进入').click()`)
  await until(() => js(`Boolean(document.querySelector('button[aria-label="添加媒体"]'))`), 'room media button', 25000)
  await js(`document.querySelector('button[aria-label="添加媒体"]').click()`)
  await until(() => js(`Boolean(document.querySelector('.media-lib-chip'))`), 'library switcher')
  // 库列表与首页目录都是异步的：等卡片或空态落定再量。
  await wait(1200)
  const state = await js(`(() => ({
    chips: Array.from(document.querySelectorAll('.media-lib-chip')).map(node => node.textContent.trim()),
    health: Array.from(document.querySelectorAll('.media-lib-chip .media-lib-health')).map(node => node.className.replace('media-lib-health', '').trim() || 'ok'),
    selected: Array.from(document.querySelectorAll('.media-lib-chip')).filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.textContent.trim()),
    headerButtons: Array.from(document.querySelectorAll('.desktop-page header button')).map(node => node.textContent.trim()),
    cards: document.querySelectorAll('.media-card').length,
    folders: Array.from(document.querySelectorAll('.media-card')).filter(node => node.textContent.includes('文件夹')).length,
    badges: Array.from(document.querySelectorAll('.media-card-badge')).map(node => node.textContent.trim()),
    crumbs: Array.from(document.querySelectorAll('.desktop-page nav[aria-label="目录路径"] button')).map(node => node.textContent.trim()),
    message: document.querySelector('.desktop-page [role="status"]')?.textContent?.trim() ?? null,
  }))()`)
  const dir = join(tmpdir(), 'watchparty-media-check')
  await mkdir(dir, { recursive: true })
  const shotPath = join(dir, 'media-library.png')
  await writeFile(shotPath, (await window.webContents.capturePage()).toPNG())
  console.log('MEDIA_LIBRARY_EVIDENCE ' + JSON.stringify({ origin, ...state, shot: shotPath }))
  assert.ok(state.chips.length >= 1, `切换器里没有库: ${JSON.stringify(state)}`)
  // 旧三根联合若还活着，表头就是三个普通按钮而不是带 kind 标签的 chip。
  assert.ok(state.headerButtons.length > 0 && state.headerButtons.every(text => state.chips.includes(text)), `表头仍有非库 chip 的按钮（旧三根联合）: ${JSON.stringify(state.headerButtons)}`)
  assert.ok(state.cards > 0, `目录里没有卡片: ${JSON.stringify(state)}`)
  assert.ok(state.crumbs.length >= 1, `没有面包屑: ${JSON.stringify(state)}`)
  assert.equal(new Set(state.crumbs).size, state.crumbs.length, `面包屑有重复项: ${JSON.stringify(state.crumbs)}`)
  assert.equal(state.selected.length, 1, `没有选中态（或选了多个库）: ${JSON.stringify(state)}`)

  // 管理端：保存一个连不上的源必须整体被拒（计划：任一路径浅列非 200 就不写入）。
  // 这里走的是裸 IPC，拿到的就是侧车的 {status, body}，状态码得自己看（渲染层那份包装在 ipc.ts）。
  const save = await invoke('mediaRequest', {
    method: 'POST', path: '/api/admin/media-sources', query: null,
    body: { name: 'Dead check', internalBaseUrl: 'http://127.0.0.1:1', publicBaseUrl: 'http://127.0.0.1:1', username: '', password: '', libraries: [{ name: 'Dead', kind: 'other', path: '/' }] },
  })
  const saved = (() => { try { return JSON.parse(save.body) } catch { return {} } })()
  const saveCode = String(saved.code ?? saved.error ?? '')
  console.log('MEDIA_SOURCE_SAVE ' + JSON.stringify({ status: save.status, code: saveCode }))
  assert.ok(save.status >= 400, `连不上的源竟然保存成功了: ${JSON.stringify(save)}`)
  assert.ok(['SOURCE_UNREACHABLE', 'LIBRARY_ROOT_NOT_FOUND', 'SOURCE_AUTH_FAILED'].includes(saveCode), `拒绝原因不是预期的源健康码: ${JSON.stringify(save)}`)
  // 半写状态是禁止的：被拒的源不得留下任何一行。
  const sources = await invoke('mediaRequest', { method: 'GET', path: '/api/admin/media-sources', query: null, body: null })
  const rows = (() => { try { return JSON.parse(sources.body).sources ?? [] } catch { return [] } })()
  console.log('MEDIA_SOURCE_ROWS ' + JSON.stringify(rows.map(row => row.name)))
  assert.equal(rows.some(row => row.name === 'Dead check'), false, `被拒的源写进去了: ${JSON.stringify(rows)}`)

  // 客户端白名单之外的路由在 sidecar 就被拒，码要能到渲染层（P1-1 的保真映射）。
  const denied = await invoke('mediaRequest', { method: 'GET', path: '/api/media/roots', query: null, body: null }).then(() => null, error => error)
  assert.equal(denied?.code, 'MEDIA_ROUTE_DENIED', `白名单外没有被拒: ${JSON.stringify(denied)}`)
  console.log('MEDIA_LIBRARY_CHECK_OK')
  await runArtworkCheck({ window, js, until, step })
  await runSourceFormCheck({ window, js, invoke, until, step })
  await runSourceIsolationCheck({ js, invoke, until, step, origin })
  await runPlayCheck({ js, until, step })
}

/**
 * 相位 2：目录自己的封面。用真实库里唯一带 poster.jpg 的目录（偶像大师 (2011)）验，
 * 断言的是 `<img>` 真的解码出像素（naturalWidth > 0）——那一步只有整条链路
 * （资产服务器 → 侧车带站点凭据 → OpenList 字节）都通了才会成立。
 */
async function runArtworkCheck({ window, js, until, step }) {
  await step('artwork-missing', async () => {
    // 走 HTML 的 <img>（渲染层 CSP 允许 img-src 'self'），不 fetch。
    const loaded = await js(`new Promise(resolve => {
      const image = new Image()
      image.onload = () => resolve({ ok: true, width: image.naturalWidth })
      image.onerror = () => resolve({ ok: false })
      image.src = '/artwork/' + encodeURIComponent('v2.not.a.real.id')
      setTimeout(() => resolve({ ok: false, timeout: true }), 8000)
    })`)
    console.log('MEDIA_ARTWORK_MISSING ' + JSON.stringify(loaded))
    assert.equal(loaded.ok, false, `编造的 mediaId 竟然出了图: ${JSON.stringify(loaded)}`)
  })

  await step('artwork-folder', async () => {
    const listOnce = query => window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke('mediaRequest', { method: 'GET', path: '/api/media/list', query: ${JSON.stringify(query)}, body: null })`)
      .then(reply => { try { return JSON.parse(reply.body) } catch { return {} } })
    const root = await listOnce('libraryId=lib_anime&path=%2F')
    const folder = (root.items ?? []).find(item => item.type === 'dir' && item.name.includes('偶像大师'))
    assert.ok(folder, `真实库里没找到带封面的目录: ${JSON.stringify((root.items ?? []).slice(0, 4).map(item => item.name))}`)
    const inside = await listOnce(`libraryId=lib_anime&path=${encodeURIComponent(folder.relativePath)}`)
    // 先证传输：直接问侧车要这张图，看清是链路问题还是渲染问题。
    const probe = await window.webContents.executeJavaScript(`window.watchpartyDesktop.invoke('mediaArtwork', { mediaId: ${JSON.stringify(inside.posterId ?? '')} }).then(
      value => ({ ok: true, contentType: value?.contentType ?? null, bytes: (value?.base64 ?? '').length }),
      error => ({ ok: false, code: error?.code ?? String(error) })
    )`)
    console.log('MEDIA_ARTWORK_TRANSPORT ' + JSON.stringify({ folder: folder.name, folderPosterId: Boolean(inside.posterId), ...probe }))
    assert.ok(inside.posterId, `这个目录本来该有封面: ${JSON.stringify({ folder: folder.name })}`)
    assert.equal(probe.ok, true, `侧车取不到这张封面: ${JSON.stringify(probe)}`)
    assert.ok(probe.bytes > 1000, `封面字节太少: ${JSON.stringify(probe)}`)
    await until(() => js(`Array.from(document.querySelectorAll('.media-card-open')).some(node => node.textContent.includes(${JSON.stringify(folder.name)}))`), 'poster folder card', 20000)
    await js(`Array.from(document.querySelectorAll('.media-card-open')).find(node => node.textContent.includes(${JSON.stringify(folder.name)})).click()`)
    await until(() => js(`Boolean(document.querySelector('.media-folder-banner img'))`), 'folder banner', 25000)
    const banner = await js(`new Promise(resolve => {
      const image = document.querySelector('.media-folder-banner img')
      const done = () => resolve({
        complete: image.complete,
        width: image.naturalWidth,
        height: image.naturalHeight,
        name: document.querySelector('.media-folder-banner-name')?.textContent?.trim() ?? null,
      })
      if (image.complete) return done()
      image.addEventListener('load', done, { once: true })
      image.addEventListener('error', done, { once: true })
      setTimeout(done, 15000)
    })`)
    const dir = join(tmpdir(), 'watchparty-media-check')
    await mkdir(dir, { recursive: true })
    const shot = join(dir, 'media-folder-cover.png')
    await wait(400)
    await writeFile(shot, (await window.webContents.capturePage()).toPNG())
    console.log('MEDIA_ARTWORK_BANNER ' + JSON.stringify({ folder: folder.name, ...banner, shot }))
    assert.ok(banner.width > 0 && banner.height > 0, `横幅图没有解码出像素: ${JSON.stringify(banner)}`)
  })

  // 卡片封面：需要一个既有 poster.jpg 又有视频文件的目录 —— 真实库里没有这种目录
  // （偶像大师那个只有图和 nfo），所以这一条跑在夹具源上：先
  // `node electron/artwork-fixture.mjs start`，没有那个库时这一步自动跳过。
  await step('artwork-card', async () => {
    const hasFixture = await js(`Array.from(document.querySelectorAll('.media-lib-chip')).some(node => node.textContent.includes('Fixture'))`)
    if (!hasFixture) {
      console.log('MEDIA_ARTWORK_CARD_SKIPPED {"reason":"夹具源不在库列表里"}')
      return
    }
    await js(`Array.from(document.querySelectorAll('.media-lib-chip')).find(node => node.textContent.includes('Fixture')).click()`)
    await until(() => js(`Array.from(document.querySelectorAll('.media-card')).some(node => node.textContent.includes('Fixture.Movie.2024.mkv'))`), 'fixture card', 20000)
    await until(() => js(`Boolean(Array.from(document.querySelectorAll('.media-card')).find(node => node.textContent.includes('.mkv'))?.querySelector('.media-card-art img'))`), 'card thumbnail', 20000)
    const video = await js(`new Promise(resolve => {
      const image = Array.from(document.querySelectorAll('.media-card')).find(node => node.textContent.includes('.mkv')).querySelector('.media-card-art img')
      const done = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
      if (image.complete) return done()
      image.addEventListener('load', done, { once: true })
      image.addEventListener('error', done, { once: true })
      setTimeout(done, 15000)
    })`)
    const stills = await js(`Array.from(document.querySelectorAll('.media-card')).filter(node => /\\.(jpg|png|webp)/i.test(node.textContent)).map(node => ({ name: node.textContent.trim().slice(0, 16), hasImage: Boolean(node.querySelector('.media-card-art img')) }))`)
    const dir = join(tmpdir(), 'watchparty-media-check')
    await mkdir(dir, { recursive: true })
    const shot = join(dir, 'media-card-cover.png')
    await wait(400)
    await writeFile(shot, (await window.webContents.capturePage()).toPNG())
    console.log('MEDIA_ARTWORK_CARD ' + JSON.stringify({ video, stills, shot }))
    assert.ok(video.width > 0 && video.height > 0, `视频卡片的封面没有解码出像素: ${JSON.stringify(video)}`)
    assert.equal(stills.some(still => still.hasImage), false, `图片文件不该有封面缩略图: ${JSON.stringify(stills)}`)
  })
}

/**
 * P1-5：坏源隔离。做法是把第二台源指向本进程的 TCP 转发口，存的时候是活的，
 * 之后掐掉转发 —— 这是「源在保存后掉线」唯一能在本地复现的路径（保存时探不通的源服务端整单拒绝）。
 */
async function runSourceIsolationCheck({ js, invoke, until, step, origin }) {
  const net = await import('node:net')
  const sockets = new Set()
  const forwarder = net.createServer(socket => {
    const upstream = net.connect(5349, '127.0.0.1')
    sockets.add(socket); sockets.add(upstream)
    socket.pipe(upstream); upstream.pipe(socket)
    const drop = () => { sockets.delete(socket); sockets.delete(upstream); socket.destroy(); upstream.destroy() }
    socket.on('close', drop); upstream.on('close', drop)
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
  })
  await new Promise(resolve => forwarder.listen(0, '127.0.0.1', resolve))
  const port = forwarder.address().port
  const login = await openlistLogin()
  const created = await invoke('mediaRequest', { method: 'POST', path: '/api/admin/media-sources', query: null, body: {
    name: 'Isolation check', internalBaseUrl: `http://127.0.0.1:${port}`, publicBaseUrl: `http://127.0.0.1:${port}`,
    username: login.username, password: login.password,
    libraries: [{ name: 'Isolation', kind: 'other', path: '/media/openlist-bdyun/Multimedia/Anime' }],
  } })
  const source = (() => { try { return JSON.parse(created.body) } catch { return {} } })()
  console.log('MEDIA_ISOLATION_CREATE ' + JSON.stringify({ status: created.status, id: source.id ?? null, libraries: source.libraries?.map(library => library.name) ?? null }))
  assert.equal(created.status, 201, `转发口上的源没建起来: ${JSON.stringify(created)}`)

  const healthOf = async () => {
    const listed = await invoke('mediaRequest', { method: 'GET', path: '/api/media/libraries', query: null, body: null })
    const rows = (() => { try { return JSON.parse(listed.body).libraries ?? [] } catch { return [] } })()
    return rows.map(row => [row.name, row.health])
  }
  await step('isolation-live', async () => {
    const rows = await healthOf()
    console.log('MEDIA_ISOLATION_LIVE ' + JSON.stringify(rows))
    assert.equal(rows.filter(([name]) => name === 'Isolation').length, 1, `这台源的行数不是 1（有上一次跑剩下的？）: ${JSON.stringify(rows)}`)
    assert.ok(rows.some(([name, health]) => name === 'Isolation' && health === 'ok'), `转发口上的库不是 ok: ${JSON.stringify(rows)}`)
  })

  // 掐掉转发口，等过健康缓存（5s）再读：这台源变坏，别的库不受影响。
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => forwarder.close(resolve))
  await wait(6000)
  await step('isolation-dead', async () => {
    const rows = await healthOf()
    console.log('MEDIA_ISOLATION_DEAD ' + JSON.stringify(rows))
    assert.ok(rows.some(([name, health]) => name === 'Isolation' && health !== 'ok'), `掉线的源没有变坏: ${JSON.stringify(rows)}`)
    assert.ok(rows.some(([name, health]) => name === 'Anime' && health === 'ok'), `好库被坏源带坏了: ${JSON.stringify(rows)}`)
  })

  // UI：切到坏的库要给出码映射后的提示，切回好库要照常出卡片。
  // 库列表和健康位是「打开选择器时读一次」（handoff F1，不挂定时器），
  // 所以建源之后要重进一次媒体视图才会看到新 chip。
  await step('isolation-ui', async () => {
    const clickButton = label => js(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim() === ${JSON.stringify(label)})
      if (!button) throw new Error('missing button ' + ${JSON.stringify(label)})
      button.click()
      return true
    })()`)
    await clickButton('返回当前会话')
    await until(() => js(`Boolean(document.querySelector('button[aria-label="添加媒体"]'))`), 'room media button again', 20000)
    await js(`document.querySelector('button[aria-label="添加媒体"]').click()`)
    await until(() => js(`document.querySelectorAll('.media-lib-chip').length >= 4`), 'isolation chip', 20000)
    await wait(600)
    const chips = await js(`Array.from(document.querySelectorAll('.media-lib-chip')).map(node => ({ text: node.textContent.trim(), health: node.querySelector('.media-lib-health')?.className.replace('media-lib-health', '').trim() || 'ok' }))`)
    const clickChip = name => js(`(() => {
      const chip = Array.from(document.querySelectorAll('.media-lib-chip')).find(node => node.textContent.includes(${JSON.stringify(name)}))
      if (!chip) throw new Error('missing chip ' + ${JSON.stringify(name)})
      chip.click()
      return true
    })()`)
    await clickChip('Isolation')
    await until(() => js(`Boolean(document.querySelector('.desktop-page [role="status"]'))`), 'dead library banner', 20000)
    await wait(1200)
    const dead = await js(`(() => ({
      message: document.querySelector('.desktop-page [role="status"]')?.textContent?.trim() ?? null,
      cards: document.querySelectorAll('.media-card').length,
      retry: Boolean(Array.from(document.querySelectorAll('.desktop-page button')).find(node => node.textContent.trim() === '重试')),
    }))()`)
    await clickChip('Anime')
    await until(() => js(`!document.querySelector('.desktop-page [role="status"]') && document.querySelectorAll('.media-card').length > 0`), 'good library cards back', 20000)
    const alive = await js(`(() => ({ cards: document.querySelectorAll('.media-card').length, message: document.querySelector('.desktop-page [role="status"]')?.textContent?.trim() ?? null }))()`)
    console.log('MEDIA_ISOLATION_UI ' + JSON.stringify({ chips, dead, alive }))
    assert.ok(chips.some(chip => chip.text.includes('Isolation') && chip.health !== 'ok'), `坏源在切换器里没有标志成坏: ${JSON.stringify(chips)}`)
    assert.ok(chips.some(chip => chip.text.includes('Anime') && chip.health === 'ok'), `好源在切换器里不是 ok: ${JSON.stringify(chips)}`)
    assert.match(dead.message ?? '', /这个库当前不可用（连不上）/, `坏库的横幅没说是连不上: ${JSON.stringify(dead)}`)
    // 换库失败不能把上一个库的卡片留在屏幕上。
    assert.equal(dead.cards, 0, `坏库下面还挂着别的库的卡片: ${JSON.stringify(dead)}`)
    assert.equal(dead.retry, true, `坏库没有重试入口: ${JSON.stringify(dead)}`)
    assert.ok(alive.cards > 0, `切回好库没有卡片: ${JSON.stringify(alive)}`)
    assert.equal(alive.message, null, `切回好库横幅没消失: ${JSON.stringify(alive)}`)
  })

  const removed = await invoke('mediaRequest', { method: 'DELETE', path: `/api/admin/media-sources/${source.id}`, query: null, body: null })
  console.log('MEDIA_ISOLATION_CLEANUP ' + JSON.stringify({ id: source.id ?? null, status: removed.status, origin }))
  assert.equal(removed.status, 204, `清理没成功: ${JSON.stringify(removed)}`)
}

/**
 * P1-5 最后一段：真的从卡片点一次播放。走的是既有的房间 resolve（v2 mediaId），
 * 断言的是「标题进了房间状态」——播放器本身由 libmpv 承担，不在这个 harness 的职责里。
 */
async function runPlayCheck({ js, until, step }) {
  await step('play-resolve', async () => {
    const target = await js(`(() => {
      const card = Array.from(document.querySelectorAll('article.media-card')).find(node =>
        Array.from(node.querySelectorAll('button')).some(button => button.textContent.trim() === '播放' && !button.disabled))
      if (!card) return null
      const title = card.querySelector('.media-card-open span span')?.textContent?.trim() ?? ''
      Array.from(card.querySelectorAll('button')).find(button => button.textContent.trim() === '播放').click()
      return title
    })()`)
    assert.ok(target, '目录里没有可播的文件卡片')
    await until(() => js(`document.body.innerText.includes(${JSON.stringify(target)}) && !document.querySelector('.media-lib-chip')`), 'room shows the media', 30000)
    // 时长是播放器读了容器才有的：mpv 起得慢，得等它，不能点完就读。
    await until(() => js(`/[0-9]{2}:[0-9]{2}:[0-9]{2}/.test(document.body.innerText)`), 'player duration', 40000)
    const room = await js(`(() => ({
      text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300),
      playing: /[0-9]{1,2}:[0-9]{2}:[0-9]{2}/.test(document.body.innerText),
      mediaViewGone: !document.querySelector('.media-lib-chip'),
    }))()`)
    console.log('MEDIA_PLAY_RESOLVE ' + JSON.stringify({ target, ...room }))
    assert.equal(room.mediaViewGone, true, `点播放后没有离开媒体视图: ${JSON.stringify(room)}`)
    // 房间读到了时长，说明 v2 mediaId 在服务端 resolve 成功、播放器拿到了媒体信息。
    assert.equal(room.playing, true, `房间没有时长（resolve 没成功或播放器没起）: ${JSON.stringify(room)}`)
  })
}

/** 只删本 harness 用例会建的源名，绝不碰用户自己的源。 */
async function purgeTestSources(invoke) {
  const list = await invoke('mediaRequest', { method: 'GET', path: '/api/admin/media-sources', query: null, body: null })
  const sources = (() => { try { return JSON.parse(list.body).sources ?? [] } catch { return [] } })()
  const junk = sources.filter(source => ['Isolation check', 'Second check', 'Dead check'].includes(source.name))
  for (const source of junk) {
    await invoke('mediaRequest', { method: 'DELETE', path: `/api/admin/media-sources/${source.id}`, query: null, body: null })
  }
  if (junk.length) console.log('MEDIA_TEST_SOURCE_PURGE ' + JSON.stringify(junk.map(source => source.name)))
}

/** P1-3：加源表单。admin 门 → 一次提交 → 码到中文的映射 → 成功后库切换器刷新。 */
async function runSourceFormCheck({ window, js, invoke, until, step }) {
  const fill = (label, value) => js(`(() => {
    const el = document.querySelector('input[aria-label=${JSON.stringify(label)}]')
    if (!el) throw new Error('missing field ' + ${JSON.stringify(label)})
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  const chips = () => js(`document.querySelectorAll('.media-lib-chip').length`)
  const formText = () => js(`document.querySelector('.desktop-page form [role="status"]')?.textContent?.trim() ?? null`)

  await step('form-open', async () => {
    const before = await chips()
    const visible = await js(`(() => {
      const button = Array.from(document.querySelectorAll('.desktop-page button')).find(node => node.textContent.trim() === '添加媒体源')
      if (!button) return 0
      button.click()
      return 1
    })()`)
    assert.equal(visible, 1, '添加媒体源 按钮不存在（capabilities.mediaAdmin 是 false？）')
    await until(() => js(`Boolean(document.querySelector('input[aria-label="源密码"]'))`), 'source password field')
    const shape = await js(`(() => ({
      passwordType: document.querySelector('input[aria-label="源密码"]').type,
      autocomplete: document.querySelector('input[aria-label="源密码"]').getAttribute('autocomplete'),
      rowFields: ['库名称', '库路径'].every(label => Boolean(document.querySelector('input[aria-label="' + label + '"]'))),
    }))()`)
    assert.equal(shape.passwordType, 'password', `源密码输入框不是 password 型: ${JSON.stringify(shape)}`)
    assert.equal(shape.rowFields, true, `库行字段缺失: ${JSON.stringify(shape)}`)
    const shot = join(tmpdir(), 'watchparty-media-check', 'media-source-form.png')
    await mkdir(join(tmpdir(), 'watchparty-media-check'), { recursive: true })
    // capturePage 取的是已合成的帧：表单刚挂上就截会拿到上一帧。
    await wait(400)
    await writeFile(shot, (await window.webContents.capturePage()).toPNG())
    return { before, shape, shot }
  })

  await step('form-reject', async () => {
    const before = await chips()
    await fill('源名称', 'Dead check')
    await fill('内网地址', 'http://127.0.0.1:1')
    await fill('库名称', 'Dead')
    await fill('库路径', '/')
    await until(() => js(`(() => { const b = Array.from(document.querySelectorAll('.desktop-page button')).find(n => n.textContent.trim() === '保存源'); return Boolean(b && !b.disabled) })()`), 'save enabled')
    await js(`Array.from(document.querySelectorAll('.desktop-page button')).find(node => node.textContent.trim() === '保存源').click()`)
    await until(async () => (await formText()) !== null, 'source save error text', 20000)
    const text = await formText()
    const after = await chips()
    // 密码在请求落定后必须离开组件状态。
    const cleared = await js(`document.querySelector('input[aria-label="源密码"]').value === ''`)
    const evidence = { text, before, after, passwordCleared: cleared }
    console.log('MEDIA_SOURCE_FORM_REJECT ' + JSON.stringify(evidence))
    assert.match(text, /连不上这个源/, `拒绝文案不是源健康码的映射: ${JSON.stringify(evidence)}`)
    assert.equal(after, before, `被拒的源却改了库列表: ${JSON.stringify(evidence)}`)
    assert.equal(cleared, true, `请求落定后密码还留在表单里: ${JSON.stringify(evidence)}`)
  })

  await step('form-create', async () => {
    const before = await chips()
    const login = await openlistLogin()
    assert.ok(login.username, '仓库根 .env 里没有 OPENLIST_USERNAME，加源用例拿不到凭据')
    await fill('源名称', 'Second check')
    await fill('内网地址', 'http://127.0.0.1:5349')
    await fill('外网地址', 'http://127.0.0.1:5349')
    await fill('源用户名', login.username)
    await fill('源密码', login.password)
    await fill('库名称', 'Film copy')
    await fill('库路径', '/media/openlist-bdyun/Multimedia/Film')
    await js(`Array.from(document.querySelectorAll('.desktop-page button')).find(node => node.textContent.trim() === '保存源').click()`)
    await until(async () => (await chips()) > before || (await formText()) !== null, 'source save settled', 25000)
    // 保存成功后会先刷新库列表再切库：中间态会同时看到「新 chip 已出现」和「旧库的卡片」，
    // 所以等到「已添加」这句落地才算读稳。
    await until(() => js(`(() => { const s = document.querySelector('.desktop-page [role="status"]'); return Boolean(s && s.textContent.includes('已添加')) })()`), 'create confirmation', 25000)
    await until(() => js(`document.querySelectorAll('.media-card').length > 0`), 'cards of the new library')
    const state = await js(`(() => ({
      chips: Array.from(document.querySelectorAll('.media-lib-chip')).map(node => node.textContent.trim()),
      selected: Array.from(document.querySelectorAll('.media-lib-chip')).filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.textContent.trim()),
      message: document.querySelector('.desktop-page [role="status"]')?.textContent?.trim() ?? null,
      cards: document.querySelectorAll('.media-card').length,
      formGone: !document.querySelector('input[aria-label="源密码"]'),
    }))()`)
    console.log('MEDIA_SOURCE_FORM_CREATE ' + JSON.stringify({ before, ...state }))
    assert.match(state.message ?? '', /已添加/, `加源没成功：${JSON.stringify(state)}`)
    assert.ok(state.selected.some(text => text.includes('Film copy')), `新库没有被切到前面: ${JSON.stringify(state)}`)
    assert.equal(state.chips.length, before + 1, `新源没有进切换器: ${JSON.stringify(state)}`)
    assert.equal(state.selected.length, 1, `新源保存后没有唯一选中项: ${JSON.stringify(state)}`)
    assert.equal(state.formGone, true, `保存成功后表单没有收起: ${JSON.stringify(state)}`)
    assert.ok(state.cards > 0, `新库没有渲染卡片: ${JSON.stringify(state)}`)
  })

  // 收尾：把这次测试建的源删掉，别留在用户的开发库里（下一轮 harness 的 chips 数也算得出是 4）。
  const rows = await invoke('mediaRequest', { method: 'GET', path: '/api/admin/media-sources', query: null, body: null })
  const saved = (() => { try { return (JSON.parse(rows.body).sources ?? []).find(row => row.name === 'Second check') } catch { return null } })()
  console.log('MEDIA_SOURCE_CLEANUP ' + JSON.stringify({ id: saved?.id ?? null, passwordSet: saved?.passwordSet ?? null, storedPassword: 'password' in (saved ?? {}) }))
  assert.equal(saved?.passwordSet, true, '新源没有记下密码位')
  assert.equal('password' in (saved ?? {}), false, '管理端回显了密码字段')
  const removed = await invoke('mediaRequest', { method: 'DELETE', path: `/api/admin/media-sources/${saved?.id ?? 'missing'}`, query: null, body: null })
  assert.equal(removed.status, 204, `清理没成功，开发库里留了一个测试源: ${JSON.stringify(removed)}`)
}
