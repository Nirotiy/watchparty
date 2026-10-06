import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

// M3 封面取色对比度护栏的纯函数测试。
// 约定与 setup-guide.test.mjs 相同：手工转译 TS 后在 vm 里跑，不起 Electron；
// accentVars 的画布路径无法在这里跑，测的是护栏与颜色数学本身。

const testsDir = path.dirname(fileURLToPath(import.meta.url))
const shellRoot = path.resolve(testsDir, '..')
const componentsDir = path.join(shellRoot, 'src', 'components')
const nodeRequire = createRequire(path.join(shellRoot, 'package.json'))

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
}

function resolveSource(request, fromDir) {
  const base = request.startsWith('@/') ? path.join(shellRoot, 'src', request.slice(2))
    : request.startsWith('.') ? path.resolve(fromDir, request) : request
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
  const hit = candidates.find((candidate) => existsSync(candidate))
  if (!hit) throw new Error(`cover-palette test cannot resolve ${request} from ${fromDir}`)
  return hit
}

function loadModule(relativePath) {
  const entry = resolveSource(`./${relativePath}`, componentsDir)
  const cache = new Map()
  const load = (filename) => {
    if (cache.has(filename)) return cache.get(filename)
    const module = { exports: {} }
    cache.set(filename, module)
    const source = readFileSync(filename, 'utf8')
    const js = ts.transpile(source, compilerOptions, filename)
    const localRequire = (id) => {
      if (id.startsWith('.') || id.startsWith('@/')) return load(resolveSource(id, path.dirname(filename))).exports
      return nodeRequire(id)
    }
    vm.runInNewContext(js, {
      require: localRequire,
      exports: module.exports,
      module,
      console,
      process,
      URL,
      setTimeout,
      clearTimeout,
    }, { filename })
    return module
  }
  return load(entry).exports
}

const { relativeLuminance, contrastRatio, hslToRgb, guardAccentLightness } = loadModule('cover-palette.ts')

const luminanceOfHsl = (h, s, l) => relativeLuminance(...hslToRgb(h, s, l))
const SHELL_DARK = relativeLuminance(10 / 255, 10 / 255, 10 / 255)
const SHELL_LIGHT = relativeLuminance(243 / 255, 243 / 255, 243 / 255)

test('相对亮度与对比度的基本标定', () => {
  assert.equal(relativeLuminance(1, 1, 1), 1)
  assert.equal(relativeLuminance(0, 0, 0), 0)
  const defaultAccent = relativeLuminance(76 / 255, 194 / 255, 1)
  assert.ok(Math.abs(defaultAccent - 0.4733) < 0.002, `默认 accent 亮度应约 0.4733，实际 ${defaultAccent}`)
  assert.equal(contrastRatio(1, 0), 21)
  assert.ok(contrastRatio(1, 0.5) < 21 && contrastRatio(1, 0.5) > 1)
})

test('护栏：暗色下深蓝被推到 4.5:1（clamp 明度救不了它）', () => {
  const base = luminanceOfHsl(240, 0.85, 0.62)
  assert.ok(contrastRatio(base, SHELL_DARK) < 4.5, `深蓝原始对比应不足（防回归），实际 ${contrastRatio(base, SHELL_DARK)}`)
  const guarded = guardAccentLightness(240, 0.85, 0.62, true)
  assert.notEqual(guarded, null)
  assert.ok(guarded > 0.62, '应向亮侧推进')
  assert.ok(contrastRatio(luminanceOfHsl(240, 0.85, guarded), SHELL_DARK) >= 4.5)
})

test('护栏：暗色下亮黄本就达标，不动它', () => {
  const guarded = guardAccentLightness(50, 0.8, 0.7, true)
  assert.equal(guarded, 0.7, '达标颜色不应被抬亮')
})

test('护栏：亮色下亮黄被压暗到 4.5:1', () => {
  const base = luminanceOfHsl(50, 0.8, 0.4)
  assert.ok(contrastRatio(base, SHELL_LIGHT) < 4.5, `亮黄原始对比应不足，实际 ${contrastRatio(base, SHELL_LIGHT)}`)
  const guarded = guardAccentLightness(50, 0.8, 0.4, false)
  assert.notEqual(guarded, null)
  assert.ok(guarded < 0.4, '应向暗侧推进')
  assert.ok(contrastRatio(luminanceOfHsl(50, 0.8, guarded), SHELL_LIGHT) >= 4.5)
})

test('护栏：亮色下深蓝达标不动，亮色深色两种底都对结果成立', () => {
  const blueLight = guardAccentLightness(240, 0.8, 0.4, false)
  assert.notEqual(blueLight, null)
  assert.ok(contrastRatio(luminanceOfHsl(240, 0.8, blueLight), SHELL_LIGHT) >= 4.5)
  for (const [h, s, l] of [[0, 0.7, 0.5], [120, 0.6, 0.45], [300, 0.85, 0.75], [210, 0.5, 0.65]]) {
    const dark = guardAccentLightness(h, s, l, true)
    const light = guardAccentLightness(h, s, l, false)
    assert.notEqual(dark, null, `dark ${h}`)
    assert.notEqual(light, null, `light ${h}`)
    assert.ok(contrastRatio(luminanceOfHsl(h, s, dark), SHELL_DARK) >= 4.5, `dark ${h} 对比不足`)
    assert.ok(contrastRatio(luminanceOfHsl(h, s, light), SHELL_LIGHT) >= 4.5, `light ${h} 对比不足`)
  }
})

test('护栏结果同时守住 accent 按钮上的标签对比', () => {
  // 暗色下标签取 #0a0a0a（与外壳同亮度），亮色下取 #fff：两对同亮度，4.5 门槛自动覆盖。
  const dark = guardAccentLightness(240, 0.85, 0.62, true)
  assert.ok(contrastRatio(luminanceOfHsl(240, 0.85, dark), SHELL_DARK) >= 4.5)
  const light = guardAccentLightness(50, 0.8, 0.4, false)
  assert.ok(contrastRatio(luminanceOfHsl(50, 0.8, light), 1) >= 4.5, '白字标签对比也要达标')
})

test('护栏全色相扫描：无 hover/press 反相、hover 守卫在亮色下落回基准', () => {
  for (let h = 0; h < 360; h += 15) for (const s of [0.42, 0.7, 0.85]) {
    // dark：hover = l+0.07、press = l-0.10，范围与护栏抬升（实测 ≤0.06）不冲突
    const darkL = guardAccentLightness(h, s, 0.62, true)
    assert.notEqual(darkL, null)
    assert.ok(Math.min(Math.max(darkL + 0.07, 0.6), 0.86) >= darkL, `dark hover 反相 @${h}`)
    assert.ok(Math.min(Math.max(darkL - 0.10, 0.5), 0.7) <= darkL, `dark press 反相 @${h}`)
    // light：press 压暗更暗于基准；hover 若过不了守卫则落回基准（不会更亮跌对比）
    for (const base of [0.30, 0.46]) {
      const lightL = guardAccentLightness(h, s, base, false)
      assert.notEqual(lightL, null)
      const press = Math.min(Math.min(Math.max(lightL - 0.08, 0.2), 0.4), lightL - 0.02)
      assert.ok(press <= lightL, `light press 反相 @${h}`)
      const hoverBase = Math.min(Math.max(lightL + 0.08, 0.3), 0.55)
      const hover = guardAccentLightness(h, s, hoverBase, false) ?? lightL
      assert.ok(contrastRatio(luminanceOfHsl(h, s, hover), SHELL_LIGHT) >= 4.5, `light hover 对比不足 @${h}`)
    }
  }
})
