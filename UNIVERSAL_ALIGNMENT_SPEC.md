# 🛰️ WatchParty v1.0 前后端唯一权威共享契约规范 (Universal Alignment Specification)

> **版本**：v1.0.0-FINAL  
> **性质**：前后端 Agent 唯一权威共享契约，包含数据结构、生命周期、安全鉴权、错误码、权威时钟校准算法、OpenList 直连协议与验收测试矩阵。  
> **网络拓扑**：后端 Node.js 独立常驻 `8080`；前端 Next.js 服务端通过 `BACKEND_ORIGIN=http://localhost:8080` 代理 `/api/*` 与 `/socket.io/*`，浏览器仅发同源请求。

---

## 1. 领域模型与基础数据结构 (Domain Models)

### 1.1 媒体源定义 (`MediaSource`)
```ts
export type MediaSource =
  | {
      kind: "openlist";
      mediaId: string;       // opaque ID (禁止包含绝对路径)
      title: string;
      container: string;     // 例如 "mp4", "webm", "mkv"
      displayPath?: string;  // 仅用于 UI 面包屑展示，严禁用作后端解析
    }
  | {
      kind: "http";
      url: string;           // 仅允许以 https:// 开头
      title?: string;
    }
  | {
      kind: "hls";
      url: string;           // 仅允许以 https:// 开头且以 .m3u8 结尾
      title?: string;
    }
  | {
      kind: "youtube";
      videoId: string;       // 11位 YouTube 视频 ID (^[a-zA-Z0-9_-]{11}$)
      title?: string;
    };
```

### 1.2 稳定播放列表条目 (`PlaylistItem`)
```ts
export interface PlaylistItem {
  id: string;                // crypto.randomUUID() 生成的条目稳定 UUID
  media: MediaSource;
  addedByClientId: string;
  addedAtMs: number;
}
```

### 1.3 房间权威快照 (`RoomSnapshot`)
```ts
export interface RoomSnapshot {
  revision: number;                    // 递增版本号，用于乐观并发控制
  source: MediaSource | null;          // 当前播放媒体源
  currentPlaylistItemId?: string;      // 当前处于播放状态的播放列表条目 ID
  positionSeconds: number;             // 当前播放进度 (秒)
  serverTimeMs: number;                // 服务端下发快照时的绝对物理时间戳 (ms)
  paused: boolean;                     // 播放/暂停
  playbackRate: number;                // 倍速: 0.25 ~ 2.0 (步进 0.25)
  loop: boolean;                       // 是否循环播放
  locked: boolean;                     // 房主控制锁 (true: 仅房主可调进度/换片/改清单)
  ownerClientId: string;               // 当前房主的 clientId
  playlist: PlaylistItem[];            // 播放列表条目数组 (严格上限 200 项)
}
```

### 1.4 在线成员与身份 (`RoomMember`)
```ts
export interface RoomMember {
  clientId: string;                    // UUID
  name: string;                        // 长度 1 ~ 24 字符
  isOwner: boolean;
}
```

---

## 2. 稳定错误码字典 (Error Codes)

所有 HTTP 异常与 Socket Ack 失败均使用以下标准错误码：

| 错误码 (`code`) | HTTP 状态码 | 含义说明 |
| :--- | :---: | :--- |
| `INVALID_REQUEST` | 400 | 请求字段缺失、类型错误、超长或 URL 非 HTTPS |
| `ROOM_NOT_FOUND` | 404 | 房间不存在、已解散或已过期回收 (不再返回 200 exists:false) |
| `INVALID_PIN` | 401 | 房间受保护且 PIN 码错误 |
| `RATE_LIMITED` | 429 | 访问频次超限 (同一 IP + 房间 5 分钟内连续 5 次 PIN 失败触发) |
| `ACCESS_TOKEN_INVALID` | 401 | 成员访问凭据无效、伪造或房间已销毁 |
| `OWNER_TOKEN_INVALID` | 403 | 房主凭据无效、已被转让轮换或伪造 |
| `FORBIDDEN` | 403 | 房间处于锁定状态，非房主成员尝试执行写操作 |
| `OPENLIST_UNAVAILABLE` | 502 | OpenList 服务无响应或返回异常 |
| `MEDIA_NOT_FOUND` | 404 | 指定的 mediaId 不存在或已下架 |
| `MEDIA_UNSUPPORTED` | 400 | 媒体格式不受支持 (如需要自定义 Request Headers 的私有直链) |
| `PLAYLIST_FULL` | 400 | 播放列表已达 200 项硬上限 |
| `REVISION_CONFLICT` | 409 | 客户端提交的 `expectedRevision` 与服务端当前版本不一致 |
| `OWNER_TARGET_OFFLINE` | 400 | 房主转让的目标成员已离线或不存在 |
| `PROTOCOL_VERSION_MISMATCH` | 426 | 客户端协议版本与服务端不兼容，拒绝连接（见第 9 节） |
| `HANDOFF_TICKET_INVALID` | 401 | MPV 交接票据不存在、过期、已使用或房间不符 |

---

## 3. HTTP REST 契约基线

### 3.1 房间生命周期与访问门禁

#### `POST /api/rooms` (创建房间)
- **说明**：创建房间并获取初始房主凭据。
- **请求体**：
  ```ts
  {
    clientId: string;          // UUID v4
    nickname: string;          // 1 ~ 24 字符
    pin?: string;              // 可选，4 位数字 (^\d{4}$)；留空即免密
    initialMedia?: MediaSource; // 可选初始媒体
  }
  ```
- **响应体 (200 OK)**：
  ```ts
  {
    roomId: string;            // 由服务端生成的房号
    accessToken: string;       // 绑定 roomId + clientId 的成员访问 Token (有效至房间销毁)
    ownerToken: string;        // 房主凭据 (有效至房主转让或房间销毁)
  }
  ```

#### `GET /api/rooms/:roomId` (房间存在性与门禁探针)
- **响应体 (200 OK)**：房间存在时返回
  ```ts
  {
    roomId: string;
    isProtected: boolean;      // 是否需要 PIN 码
    onlineCount: number;
  }
  ```
- **异常响应**：
  - `404 Not Found`：`{ code: "ROOM_NOT_FOUND", message: "房间不存在或已解散" }`

#### `POST /api/rooms/:roomId/access` (获取成员访问 Token)
- **说明**：免密房间与 PIN 房间统一通过此接口获取 `accessToken`。**绝对不返回 `ownerToken`**。
- **请求体**：
  ```ts
  {
    clientId: string;          // UUID v4
    nickname: string;          // 1 ~ 24 字符
    pin?: string;              // 若房间受保护则必填 4 位数字
  }
  ```
- **响应体 (200 OK)**：
  ```ts
  {
    accessToken: string;
  }
  ```
- **异常响应**：`INVALID_PIN` (401), `RATE_LIMITED` (429), `ROOM_NOT_FOUND` (404)。

---

### 3.2 OpenList 媒体库与字幕接口

#### `GET /api/media/roots` (获取根分类)
- **鉴权**：依赖全站 Caddy Basic Auth，不要求房间 Token。
- **响应体 (200 OK)**：`["Anime", "Film", "TV Shows"]`

#### `GET /api/media/list?root=Anime&path=/&cursor=` (目录列表分页)
- **鉴权**：依赖全站 Caddy Basic Auth，不要求房间 Token。
- **参数**：
  - `root`: `"Anime" | "Film" | "TV Shows"`
  - `path`: 目录路径 (如 `/Laid-Back Camp`)
  - `cursor`: 可选不透明分页游标字符串
- **响应体 (200 OK)**：
  ```ts
  {
    root: "Anime" | "Film" | "TV Shows";
    currentPath: string;
    breadcrumbs: string[];
    hasMore: boolean;
    nextCursor?: string;
    items: Array<{
      id: string;              // opaque mediaId
      name: string;            // 文件名或目录名
      type: "file" | "dir";
      size?: number;           // bytes
      extension?: string;
      duration?: number;       // seconds
      compatibility: "supported" | "maybe" | "unsupported"; // MKV 标为 unsupported
      compatibilityReason?: string; // 例如 "浏览器不支持 MKV 封装，需 mpv 客户端"
    }>;
  }
  ```
  *注：单页固定最多返回 100 项，超过时 `hasMore: true` 并返回 `nextCursor`。*

#### `GET /api/media/search?q=xxx&root=Anime&cursor=` (全局搜索分页)
- **鉴权**：依赖全站 Caddy Basic Auth，不要求房间 Token。
- **响应体 (200 OK)**：返回结构与 `GET /api/media/list` 保持完全一致，每项标明 `displayPath` 用于 UI 呈现。

#### `POST /api/rooms/:roomId/media/resolve` (解析临时播放直链)
- **鉴权**：`Authorization: Bearer <accessToken>`
- **请求体**：`{ mediaId: string }`
- **响应体 (200 OK)**：
  ```ts
  {
    url: string;               // 浏览器可达的绝对播放地址：OpenList 代理地址（带 sign）或 HTTPS 直链
    expiresAt?: number;        // 时间戳毫秒；签名有效期取决于 OpenList link_expiration 配置（当前实例为 0 = 不过期），客户端契约始终是失败后重新 resolve
    requiresCustomHeaders?: boolean; // 若为 true 则网页端标记不可播放，不走后端伪装代理
  }
  ```
  *注：百度网盘直链要求 `User-Agent: pan.baidu.com`（大于约 20MB 的文件，OpenList 官方文档），浏览器无法携带该请求头，因此存储需保持 `web_proxy: true`，
  `url` 实际为 OpenList 的 `/p/...?sign=` 代理地址；后端通过 `OPENLIST_PUBLIC_URL` 将其改写为浏览器可达的源。*
  *实测记录（OpenList Desktop v4.2.6，真实 462MB 百度 MP4）：双链可行性已验证——`/p/` 匿名 206 可播放可 seek，管理员 `/api/fs/link` 返回真实直链且实测仅含
  `User-Agent` 头；mpv 必须显式 `--user-agent=pan.baidu.com`（对直链与 `/p/` 回退均必需，缺失时百度侧挂起）；`web_proxy=false + ProxyTypes` 无法放行
  `/p/`（403 proxy not allowed），禁止用改配置的方式求直链；`/d/` 为 OpenList 策略路由，不属于本契约。*
  *本接口保持单链（仅 `url`）；MPV 专用双链接口（directUrl）为未实现的冻结契约，见第 9 节。*

#### `GET /api/rooms/:roomId/media/subtitle?mediaId=<opaque-id>` (字幕文件拉取)
- **鉴权**：`Authorization: Bearer <accessToken>`
- **说明**：仅允许 ASS/SSA/SRT/VTT 格式，最大 5 MiB。禁止接收前端传入的原始绝对路径。
- **响应**：直接输出字幕文本内容 (`Content-Type: text/plain; charset=utf-8`)。

#### `GET /api/rooms/:roomId/media/subtitles?mediaId=<video-media-id>` (关联字幕发现)
- **鉴权**：`Authorization: Bearer <accessToken>`
- **说明**：查找与视频关联的字幕文件；只返回不透明 ID，不返回存储路径。
- **响应体 (200 OK)**：
  ```ts
  Array<{
    id: string;
    mediaId: string;
    label: string;
    format: "ass" | "ssa" | "srt" | "vtt";
    language?: string;
    offsetSeconds?: number;
  }>
  ```

---

## 4. Socket.io 实时信令与权威时钟同步契约

### 4.1 唯一连接与握手规范
- **命名空间**：固定为**根命名空间 `/`**，通过 `path: "/socket.io"` 连接。
- **客户端连接代码**：
  ```ts
  io(window.location.origin, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: {
      roomId: string,
      clientId: string,        // 浏览器端 crypto.randomUUID()
      accessToken: string,
      ownerToken?: string,     // 仅房主持有 (可选)
    },
  });
  ```
- **握手与鉴权处理**：
  1. 服务端验证 `accessToken`（哈希比对且未过期），验证失败触发 `connect_error`（`error.data = { code: "ACCESS_TOKEN_INVALID", message: "访问凭据已失效" }`）；
  2. 若携带了 `ownerToken` 但已失效，**不能直接断开**，而应降级为普通成员准入，并在连接后向该客户端推送降级提示；
  3. 鉴权成功后，将 Socket 加入 `roomId` 分组；
  4. **连接成功后，服务端必须立即下发 `REC:snapshot` 和 `REC:members`**。

---

### 4.2 唯一 Ack 回执协议定义
所有 `CMD:*` 指令调用均必须提供 Ack 回执：
```ts
export type CommandAck<T = undefined> =
  | { ok: true; revision: number; data?: T }
  | { ok: false; error: { code: string; message: string } };
```

---

### 4.3 权威时钟同步与平滑校准算法 (Clock Sync)

为避免客户端本地时钟误差，建立基于 NTP 往返测量的权威时钟同步：

1. **时钟对齐信令**：
   - 客户端发送：`CMD:clockSync` 载荷 `{ clientSentAtMs: number }`
   - 服务端 Ack：`{ ok: true, revision, data: { serverTimeMs: number } }`
   - 客户端估算偏移量：
     $$\text{RTT} = \text{clientReceivedAtMs} - \text{clientSentAtMs}$$
     $$\text{Offset} = \text{serverTimeMs} - \left(\text{clientSentAtMs} + \frac{\text{RTT}}{2}\right)$$
   - 客户端连接后连续采样 5 次，取中位数作为基准时钟偏移 $\Delta t_{\text{clock}}$；后续每 30 秒进行一次微调采样。

2. **权威时钟推进与广播**：
   - 服务端为主权威时钟。播放中每 2 秒下发一次 `REC:snapshot`。
   - 客户端计算当前理论播放时间：
     $$T_{\text{expected}} = \text{snapshot.positionSeconds} + \frac{(\text{nowMs} + \Delta t_{\text{clock}} - \text{snapshot.serverTimeMs})}{1000} \times \text{snapshot.playbackRate}$$

3. **客户端三段式梯度追帧策略**：
   - $|\Delta T| \le 250\text{ms}$：**完美同步**，保持正常倍速播放，不作任何调整；
   - $250\text{ms} < |\Delta T| \le 1000\text{ms}$：**轻度偏移**，动态微调音频/视频播放速率（$\pm 5\%$）平滑收敛，避免跳音；
   - $|\Delta T| > 1000\text{ms}$：**严重脱节**，直接执行 `video.currentTime = T_expected` 强力 seek；
   - **UI 展示**：状态条展示 `已同步 (差值 < 0.3s)`，严禁向用户展示假个位数毫秒浮动。

---

### 4.4 服务端广播事件 (REC:*)

1. **`REC:snapshot`** (`RoomSnapshot`)：房间权威快照。
2. **`REC:members`** (`RoomMember[]`)：在线成员列表。
3. **`REC:ownerToken`** (`string`)：**仅定向推送给新房主客户端**。新房主收到后立即替换本地 `ownerToken` 并持久化。
4. **`REC:error`** (`{ code: string; message: string }`)：全局严重异常通知。

---

### 4.5 客户端指令集 (CMD:*)

所有修改操作均需携带客户端当前已知的 `expectedRevision: number`。若服务端当前 `revision !== expectedRevision`，直接返回 `REVISION_CONFLICT` (409)。

1. **`CMD:name`**：`{ name: string }` ➔ 修改自身昵称
2. **`CMD:clockSync`**：`{ clientSentAtMs: number }` ➔ 返回 `{ serverTimeMs: number }`
3. **`CMD:play`**：`{ expectedRevision: number }` ➔ 播放
4. **`CMD:pause`**：`{ expectedRevision: number }` ➔ 暂停
5. **`CMD:seek`**：`{ positionSeconds: number; expectedRevision: number }` ➔ 调整进度
6. **`CMD:rate`**：`{ rate: number; expectedRevision: number }` ➔ 调整倍速 (0.25 ~ 2.0)
7. **`CMD:loop`**：`{ loop: boolean; expectedRevision: number }` ➔ 切换循环
8. **`CMD:lock`**：`{ locked: boolean; expectedRevision: number }` ➔ 切换房主锁 (仅房主)
9. **`CMD:mediaSet`**：`{ media: MediaSource; expectedRevision: number }` ➔ 切换当前播放媒体
10. **`CMD:playlistAdd`**：`{ media: MediaSource; expectedRevision: number }` ➔ 追加到播放列表 (上限 200 项)
11. **`CMD:playlistRemove`**：`{ itemId: string; expectedRevision: number }` ➔ 按条目 ID 移除
12. **`CMD:playlistMove`**：`{ itemId: string; targetIndex: number; expectedRevision: number }` ➔ 拖动重排
13. **`CMD:playlistPlay`**：`{ itemId: string; expectedRevision: number }` ➔ 播放指定条目
14. **`CMD:playlistNext`**：`{ expectedRevision: number }` ➔ 播放下一条目
15. **`CMD:transferOwner`**：`{ targetClientId: string; expectedRevision: number }` ➔ 房主转让 (仅房主)
    - **原子转让流程**：
      1. 服务端校验目标 `targetClientId` 当前必须在线，否则返回 `OWNER_TARGET_OFFLINE`；
      2. 服务端生成新的 `newOwnerToken`，向目标 Socket 定向发送 `REC:ownerToken`；
      3. 确认定向发送后，原子化变更 `snapshot.ownerClientId`，旧 `ownerToken` 立即作废；
      4. 广播新的 `REC:snapshot` 与 `REC:members`。

---

## 5. WatchParty ↔ OpenList 直连协议

WatchParty 后端**直接连接 OpenList 的 HTTP API**（不再存在独立 Gateway 进程，也不使用共享密钥头）：

1. **环境变量**：
   - `OPENLIST_URL`：后端自身访问 OpenList 的地址（本机 `http://127.0.0.1:5244`，Docker 下 `http://host.docker.internal:5244`）；
   - `OPENLIST_PUBLIC_URL`：**浏览器**可达的 OpenList 源（仅支持 origin，不支持路径前缀）；VPS 部署时指向 Caddy 暴露的 `https://<域名>`，缺省回退到 `OPENLIST_URL`；
   - `OPENLIST_USERNAME` / `OPENLIST_PASSWORD`：OpenList 管理员凭据（`/api/fs/link` 是管理员接口，见 9.6 的凭据边界）；
   - `WATCHPARTY_MEDIA_ID_KEY`：mediaId 签名密钥；**生产模式必须配置，否则拒绝启动**。
2. **安全要求**：
   - OpenList 管理后台不得暴露公网；浏览器仅通过 Caddy 同源代理 `/p/*`（媒体流）访问，且受同一 Basic Auth 保护；
   - `mediaId` 为 HMAC-SHA256 签名的 opaque 值，每次使用都重新校验所属白名单根目录；
   - 严格限定白名单根目录：`Anime`, `Film`, `TV Shows`，禁止 `../` 路径穿越；
   - **流媒体直出**：视频字节由浏览器直连 OpenList（`/p/*` 流式代理），**绝不经由 WatchParty Node.js 转发**。
3. **百度网盘约束**：大于约 20MB 的文件下载要求 `User-Agent: pan.baidu.com`（OpenList 官方文档），普通 `<video>` 无法注入该请求头，因此百度存储必须保持 `web_proxy: true`，`resolve` 返回 OpenList 的 `/p/...?sign=` 代理地址（签名有效期取决于 `link_expiration` 配置，当前实例为 0 = 不过期）。
4. **请求边界**：目录列表与搜索单次请求固定 `per_page: 2000`，响应体在解析前就由上游截断，内存峰值有界；WatchParty 在这批结果内自然排序并按 100 条分页，超出部分不返回。
5. **部署容量**：每位观看者产生独立的 OpenList 代理流量（无跨用户缓存）；首期限定 3 个并发观看者、1080p、不转码。瓶颈为线路质量、百度限速、VPS 端口速率与月流量额度，而非 CPU/内存（流式转发，无转码）。

---

## 6. 房间生命周期管理 (Lifecycle)

1. **内存化存储**：房间状态与 Token 纯内存维护，服务端重启后所有房间销毁；
2. **安全哈希**：服务端仅保存 Token 的 SHA-256 哈希值，不存储明文；
3. **延迟回收**：当房间内所有成员离线 (`onlineCount === 0`) 时，启动 8 小时倒计时定时器；若 8 小时内无人重连，则执行内存清理回收；
4. **所有权持久**：房主断线后不自动转让所有权；房主重新打开页面凭本地保存的 `ownerToken` 重新连接即可恢复房主身份。

---

## 7. 真实播放器内核与字幕规范

1. **播放器内核调度**：
   - HTML5 原生 `<video>`：用于 HTTPS MP4 / WebM；
   - `hls.js`：用于 `.m3u8` 流媒体；
   - YouTube IFrame API：用于 YouTube 视频；
   - OpenList 直链失效处理：遇到 403 / 410 失效时，**前端仅自动调用一次 `/resolve` 重新获取直链**，若重试仍失败则弹出错误提示并暂停。
2. **字幕渲染与本地隔离**：
   - ASS/SSA：使用 WASM libass 引擎 (`jassub`) 进行高帧率矢量特效渲染；
   - SRT/VTT：解析为标准 WebVTT TextTrack 挂载；
   - **本地偏好隔离**：字幕选择、外挂加载及时间偏移 ($\pm 0.1\text{s}$) **纯本地生效，严禁向房间状态广播**。
3. **低 GPU 纯黑设计要求**：
   - 纯黑（`#000`）背景与高对比度文字；
   - **严禁使用任何 `animate-pulse`、`animate-spin`、`animate-bounce` 等高刷新重绘 CSS 动画**。

---

## 8. 验收测试矩阵 (Acceptance Criteria)

前端与后端必须同时通过以下全部测试方可验收完成：

1. **代码质量**：
   - 前端 `npm run build` 成功，`npm run lint` 0 error 0 warning；
   - 后端 `npm test` 与 `tsc` 0 错误；
   - 彻底清除所有 mock 假数据降级代码。
2. **E2E 双浏览器联调场景**：
   - **场景 A（免密房间）**：浏览器 A 创建免密房间并选定 OpenList 初始视频；浏览器 B 通过房号直接进入，两者通过时钟校准实现毫秒级同步播放；
   - **场景 B（PIN 房间与限速）**：浏览器 A 创建 4 位 PIN 房间；浏览器 B 未输入 PIN 受到门禁拦截，输入错误 5 次触发 429 限速，输入正确 PIN 成功准入；
   - **场景 C（房主锁与防越权）**：房主开启锁定；访客尝试播放、暂停、seek 均被拒绝并提示 `FORBIDDEN`；房主解锁后访客可正常操作；
   - **场景 D（并发版本冲突）**：两客户端并发提交 `CMD:playlistAdd`，版本落后者正确收到 `REVISION_CONFLICT` 并自动拉取最新快照重试；
   - **场景 E（房主转让）**：房主将所有权转让给访客 B；B 收到 `REC:ownerToken` 成为新房主；A 的旧 `ownerToken` 作废降级为普通访客；B 刷新页面后凭 `ownerToken` 恢复房主身份；
   - **场景 F（OpenList 检索与字幕）**：在媒体库中按 A-Z 快速过滤与全局搜索，批量入队自然排序剧集；加载 ASS 字幕并在本地微调偏移 $\pm 0.2\text{s}$。

---

## 9. MPV 客户端扩展（契约冻结，未实现）

> **状态**：本节为已冻结的契约定义，代码尚未实现。实现完成前，MPV 插件仅可开发"壳"与本地播放器控制。
> **实测基线**：双链可行性已验证（见 3.2 resolve 注记）；过期恢复链路未强测，待插件集成测试；生产 Caddy `/p/` 回退认证未验证（见 9.5）。

### 9.1 协议版本
- 常量 `PROTOCOL_VERSION = 2`（v1 = 纯浏览器协议，仅作历史参考）。
- Socket 握手 `auth` 与所有 `/api/mpv/*` 请求必须携带 `clientProtocol: 2`。
- 服务端版本不匹配时返回 `PROTOCOL_VERSION_MISMATCH` (426) 并拒绝连接，不做降级。

### 9.2 Handoff 票据（浏览器 → MPV 交接）
- `POST /api/rooms/:roomId/handoff`（浏览器 accessToken 鉴权）→ `{ ticket, ticketExpiresAt }`。
- ticket：128-bit 随机值，TTL 120 秒，**一次性**；签发时记录 roomId 与发起方浏览器 clientId（仅审计）。
- `POST /api/mpv/handoff` `{ ticket }` → 一次性兑换：服务端为 MPV 生成**独立** clientId 与 accessToken（token 记录 `clientType=mpv`），响应含 `protocolVersion`、房间摘要与首个 `RoomSnapshot`。
- 票据不可续期；MPV 重连使用本地保存的 accessToken，不再经票据。ownerToken 不经票据传递——MPV 永远是普通成员，房主身份留在浏览器。

### 9.3 MPV 专用接口（`clientType=mpv` 的 token 鉴权，浏览器 token 调用返回 403）
- `GET /api/rooms/:roomId/mpv/snapshot?since=<revision>`：revision 落后时返回完整 `RoomSnapshot`；相同则 `204 No Content`。轮询间隔建议 2s，与浏览器快照节奏一致。
- `POST /api/rooms/:roomId/mpv/command` `{ type, expectedRevision, ...payload }`：`CommandAck` 语义与 Socket `CMD:*` 完全一致（type 即事件名去掉 `CMD:` 前缀）；`clockSync` 不需要——权威时钟由 `snapshot.serverTimeMs` 提供。
- `POST /api/rooms/:roomId/media/resolve-mpv` `{ mediaId }` → `{ directUrl?, headers, fallbackUrl }`：
  - `directUrl` 来自管理员 `/api/fs/link`；**headers 为服务端白名单过滤后的结果，仅允许 `User-Agent`**，`Cookie`/`Authorization`/`Referer` 等一律剔除；若上游直链必需被剔除的头，则 `directUrl` 置空（不可用），MPV 直接使用 `fallbackUrl`；
  - `fallbackUrl` = 与浏览器相同的 `/p/` 代理地址（MPV 直连失败时的回退）；
  - 浏览器 resolve 保持单链（仅 `url`）；MPV 隔离由 `clientType=mpv` token 在服务端强制，而非文字约定。

### 9.4 客户端行为契约
- MPV 必须显式设置 `--user-agent=pan.baidu.com`（对 `directUrl` 与 `fallbackUrl` 均必需）。
- 乐观执行本地操作，revision 冲突时让位服务端快照。
- `end-file`（正常播完）→ 发 `playlistNext`；多 MPV 竞态由 revision 冲突自然收敛，失败方静默。
- 播放失败（连接错误/401/403/410）→ 重新 `resolve-mpv` 一次；仍失败 → 切换 `fallbackUrl` 并 OSD 提示"直连失败，已切换服务器中转"；单个观众独立回退，不影响房间。
- `directUrl`、headers 仅存在于 MPV 进程内存，不写入任何广播或持久化。

### 9.5 生产回退认证（未验证，列为部署阶段 E2E 项）
- 生产中 `/p/*` 位于 Caddy Basic Auth 之后；MPV 回退播放需要凭据。
- 方案：MPV 插件本地配置项 `media_basic_auth`（一次性人工配置，存放于 MPV 配置目录），仅用于 `fallbackUrl` 播放；票据与 `resolve-mpv` 响应**不携带** Basic Auth 凭据（站点级凭据不得扩散到房间成员）。
- 生产 E2E（Caddy + Basic Auth + MPV 回退播放 + seek）为部署阶段必过项。

### 9.6 管理员凭据边界（默认：接受）
- WatchParty 后端持有 OpenList 管理员凭据（`fs/list`、`fs/get`、`fs/link` 所需）。约束：
  1. OpenList 仅监听回环/内网地址，不经 Caddy 暴露管理接口；
  2. 凭据仅存于后端环境变量，不写日志、不回传客户端；
  3. `resolve-mpv` 的请求头白名单在服务端执行（9.3），即使上游返回 Cookie 也不会泄漏；
  4. "实测仅返回 User-Agent" 是经验观察而非契约，白名单才是长期保证。
- 若不接受该边界，替代方案是放弃 `directUrl`（全员走 `/p/` 代理、消耗 VPS 带宽）——需用户明确选择。
