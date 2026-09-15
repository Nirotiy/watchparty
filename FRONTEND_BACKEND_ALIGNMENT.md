# 🛰️ WatchParty 前后端接口与协同协议对齐规范 (Frontend ⇄ Backend Alignment Spec)

> **版本**：v1.0.0  
> **对接对象**：Next.js 前端应用 (`web/`) ⇄ Node.js / Express + Socket.io 核心服务端 (`server/`)  
> **设计原则**：极简极客、类型安全（TypeScript）、低延迟（Lock-Step 同步）、状态完备。

---

## 1. 系统整体架构与网络模型

- **HTTP 端口**：默认 `8080` (由 `server/config.ts` 决定)，前端 Next.js 代理至后端。
- **WebSocket 连接方式**：Socket.io 客户端通过带 `roomId` 查询参数建立长连接：
  `io(SERVER_URL, { query: { roomId }, transports: ["websocket"] })`

---

## 2. HTTP REST 接口需求列表

| 路径 (Path) | 方法 | 前端调用场景 | 请求载荷 (Request Body / Query) | 响应数据 (Response) | 状态码 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/ping` | `GET` | 心跳检测 / 服务健康探针 | 无 | `"pong"` | 200 |
| `/createRoom` | `POST` | 首页 Omnibar / 快速生成房间 | `{ video?: string, playlist?: string[], password?: string }` | `{ name: string, isProtected?: boolean }` | 200 / 500 |
| `/roomInfo/:roomId` | `GET` | 房间准入前状态探查（是否加锁、是否有密码） | `params: { roomId: string }` | `{ roomId: string, exists: boolean, isProtected: boolean, onlineCount: number }` | 200 / 404 |
| `/verifyRoomPin` | `POST` | 鉴权拦截页密码校验 (纯 HTTP 校验或基于 token) | `{ roomId: string, pin: string }` | `{ valid: boolean, token?: string, error?: string }` | 200 / 401 |
| `/generateName` | `GET` | 身份名牌随机昵称 | 无 | `string` (如 `"Cyber_314"`) | 200 |
| `/youtube` | `GET` | 播放器搜索 YouTube 片源 | `query: { q: string }` | `YouTubeSearchResult[]` | 200 / 500 |
| `/youtubePlaylist/:id` | `GET` | 导入 YouTube 播放列表 | `params: { id: string }` | `PlaylistItem[]` | 200 / 500 |

---

## 3. WebSocket 实时信令协议 (Socket.io)

### 3.1 客户端上行指令 (`ClientToServerEvents` / `CMD:*`)

前端调用 `socket.emit(event, ...args)`：

| 事件名 (`Event`) | 载荷参数 (`Args`) | 触发场景 |
| :--- | :--- | :--- |
| `CMD:askHost` | 无 | 刚进入房间时请求全量房间状态快照 (`REC:host`) |
| `CMD:name` | `name: string` | 用户修改昵称或初次进入名牌同步 |
| `CMD:host` | `url: string` | 切换主播放视频源 (直连 MP4/HLS/YouTube) |
| `CMD:play` | 无 | 点击播放 (需检查房主锁) |
| `CMD:pause` | 无 | 点击暂停 (需检查房主锁) |
| `CMD:seek` | `t: number` (秒) | 拖动进度条 / 点击章节跳转 |
| `CMD:playbackRate`| `rate: number` (如 `1.0`, `1.25`) | 调节倍速 |
| `CMD:loop` | `on: boolean` | 开启 / 关闭单曲循环 |
| `CMD:ts` | `t: number` (当前播放秒数) | 前端每 2~3 秒上报本地播放器进度（用于房间同步） |
| `CMD:chatV2` | `{ msg: string, replyToId?: string }` | 发送聊天消息 / 弹幕 |
| `CMD:lock` | `locked: boolean` | 房主开启 / 关闭房间控制锁 (Host Only Lock) |
| `CMD:playlistAdd` | `url: string` | 往播放清单追加新媒体 URL |
| `CMD:playlistMove`| `{ index: number, toIndex: number }` | 拖拽调整播放列表顺序 |
| `CMD:playlistDelete`| `index: number` | 删除播放列表项 |
| `CMD:playlistNext`| `url?: string` | 切到下一集 |

---

### 3.2 服务端下行广播 (`ServerToClientEvents` / `REC:*`)

前端通过 `socket.on(event, (data) => ...)` 监听：

| 事件名 (`Event`) | 载荷数据 (`Payload`) | 前端处理行为 |
| :--- | :--- | :--- |
| `REC:host` | `WireHostState` (视频URL、当前秒数、播放状态、倍速等) | 全量初始化播放器视频、进度与控制状态 |
| `REC:play` | `videoUrl: string` | 触发原生播放器 `video.play()` |
| `REC:pause` | 无 | 触发原生播放器 `video.pause()` |
| `REC:seek` | `t: number` (秒) | 触发原生播放器 `video.currentTime = t` |
| `REC:playbackRate`| `rate: number` | 更新播放器 `video.playbackRate = rate` |
| `REC:loop` | `on: boolean` | 更新循环状态角标 |
| `REC:lock` | `lock: string` / `boolean` | 更新顶部房主锁状态徽标 (`HostLock` 图标与交互限制) |
| `REC:nameMap` | `{ [clientId: string]: string }` | 更新所有在线成员的名字映射表 |
| `REC:tsMap` | `{ [clientId: string]: number }` | 计算房间成员间的 **时钟偏差 (Clock Offset / ms)** |
| `roster` | `User[]` | 更新右下角 / 顶部 在线人数及成员列表 |
| `playlist` | `PlaylistVideo[]` | 更新播放清单抽屉中的列表项 |
| `REC:chat` | `ChatMessage` | 接收聊天消息并追加至聊天池 / 弹幕层 |

---

## 4. 房间鉴权与 PIN 码机制 (Room Gate Auth)

1. **创建带密码的房间**：
   - 前端通过 `/createRoom` 传入可选 `password` (4位 PIN 或字符串)；
   - 后端在 `RoomState` 中标记 `isProtected: true`，存储 PIN 哈希。
2. **进入房间鉴权流程**：
   - 前端访问 `/room/:id`，先请求 `/roomInfo/:id` 获取房间状态；
   - 若 `isProtected: true` 且客户端无有效 Token：
     - 前端渲染 **纯黑 PIN 码跳格拦截屏**；
     - 用户输入 4 位 PIN 码后发送验证请求；
     - 校验通过后建立 Socket 连接并携带鉴权标识，平滑淡入 `RoomPlayer`。

---

## 5. 时钟偏差与 Lock-Step 追帧对齐规范

1. **上报周期**：客户端每 **`2000ms`** 向后端发送一次 `CMD:ts(video.currentTime)`；
2. **偏差计算公式**：
   $$\Delta t = |t_{\text{local}} - t_{\text{host}}| \times 1000\text{ (ms)}$$
3. **前端偏差三态渲染**：
   - **`Δt < 50ms` (完美绿标)**：`bg-emerald-950 text-emerald-400`，表示严丝合缝同步；
   - **`50ms ≤ Δt ≤ 200ms` (微差黄标)**：`bg-amber-950 text-amber-400`，常规网络抖动；
   - **`Δt > 200ms` (滞后红标)**：`bg-rose-950 text-rose-300 animate-pulse`，提示用户点击一键追帧对齐。

---

## 6. 数据字典与 TypeScript 类型定义

```typescript
// 1. 核心播放宿主状态
export interface WireHostState {
  video: string;        // 当前视频 URL
  videoTS: number;      // 当前基准秒数 (如 444.2)
  subtitle: string;     // 外挂字幕 URL / 标识
  paused: boolean;      // 是否暂停
  playbackRate: number; // 播放倍速 (0.5 ~ 2.0)
  loop: boolean;        // 是否循环
  controller?: string;  // 当前房主 / 控制者 ClientId
  isLocked?: boolean;   // 是否开启房主控制锁
}

// 2. 在线用户信息
export interface User {
  id: string;
  name: string;
  picture?: string;
  isHost?: boolean;
}

// 3. 播放清单项
export interface PlaylistVideo {
  id: string;
  title: string;
  url: string;
  duration?: string;
  type?: "youtube" | "direct" | "hls";
}

// 4. 聊天与消息
export interface ChatMessage {
  id: string;
  user: string;
  msg: string;
  timestamp: string;
  replyToId?: string;
}
```

---

### 🚀 对接行动项 (Action Items for Backend Agent)

1. [ ] **完善 HTTP `/roomInfo/:roomId` 接口**：支持前端进入动态路由时探查房间是否存在及是否受密码保护；
2. [ ] **支持创建/校验 PIN 码**：在 `RoomRegistry` 的房间元数据中支持 `pin` / `password` 字段并在鉴权时比对；
3. [ ] **支持 `CMD:lock` / `REC:lock` 事件**：当房主在前端点击「房主锁」时，后端更新房间的 `isLocked` 状态并向全房广播，非房主发送控制指令时后端直接拒绝。
