# 方案 C′ · React + shadcn/ui 实现源码（对接 desktop-shell）

本目录是 `dev/desktop-redesign-c.html`（设计基线）的 **React 19 + Tailwind v4 + shadcn/ui 实现**，
按 `desktop-shell/src` 的现行约定编写（`@/` 别名、`cn()`、`MaterialSymbol`、无分号风格、React 19 函数组件），
desktop 会话可直接把文件并入 `desktop-shell/src`。

## 文件 → 落位映射

| 本目录文件 | 落位（desktop-shell/src/） | 说明 |
|---|---|---|
| `src/lib/entry-intent.ts` | 原样并入 `src/lib/` | 首页智能输入的意图识别纯函数（可单测） |
| `src/components/home-view.tsx` | 原样并入 `src/components/` | **统一入口首页**，替换无会话态的 `SessionGate` |
| `src/components/settings-view.tsx` | 原样并入 `src/components/` | 站点凭据表单（替换 DeferredView 的 settings 分支） |
| `src/components/media-library-view.tsx` | 原样并入 `src/components/` | 媒体库（无海报网格骨架，等 IPC 接入后填 items） |
| `INTEGRATION.md` | 不并入 | 本说明 |

## App.tsx 接线差异（对照现状）

1. 无会话态（`!state`）：`view === "room"` 时渲染 `<HomeView …/>`（替代 `<SessionGate …/>`）；
   `view === "media"` / `"settings"` 渲染对应新组件（替代 `<DeferredView …/>`）。
2. `HomeView` 新 props 需要的新 IPC（Rust 侧）：
   - `joinRoom(roomId, pin, nickname)` —— REST `/access` 封装；受保护房间未带 PIN 时
     返回约定值 `"pin_required"`（组件就地展开 PIN 输入）
   - `createRoom(nickname, pin, initialMedia)` —— REST `/api/rooms` 的 `initialMedia`
     封装（http / hls / youtube 源由 `entry-intent.ts` 产出）
   - `setSiteCredentials / clearSiteCredentials` —— 系统凭据库 + native `SiteBasicAuth`
   - `listMedia / searchMedia / fetchThumbnail` —— 媒体库数据（二期可先无海报网格）
3. 播放页（`RoomView`）**无需改动**：当前实现已含全出血 overlay / 自动隐藏 / 右缘抽屉 /
   MaterialSymbol（本次交付的播放页设计即以它为准）。

## 交互契约速查（与设计基线一致）

- 意图识别：`watchparty://` / `room-` 房号 → 加入；`http(s)://`（`.m3u8` → hls；YouTube → 解析 videoId）→ 创建并开播
- 一步直进：昵称记忆上次值；受保护房间 401 后行内展开 PIN；链接模式可选 PIN
- 恢复条：上次房间仍存活时显示「返回房间」，否则隐藏
- 状态行：后端连接 + 站点凭据状态（未配置 → 去设置）
- 图标：MaterialSymbol（本地 sprite，禁 CDN / 禁 lucide 混用）

## 已知边界

- `credentialsConfigured` / `backendOrigin` 需要 native 侧暴露查询命令（可先返回 null → 显示"状态未知"）
- 媒体库海报：CSP `img-src 'self' data:` 禁止远程图，等 `fetchThumbnail` IPC（base64）；本交付为无海报网格
- 队列/成员抽屉沿用现有 `RoomDrawer`
