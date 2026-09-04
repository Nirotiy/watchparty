# WatchParty MPV 插件（watchparty.lua）

MPV 侧支客户端：浏览器是唯一控制台，MPV 是被"发射"出来的纯渲染端。
通过一次性交接码加入房间后，自动起播房间当前媒体，并与浏览器成员保持
暂停 / 倍速 / 进度双向同步（MPV 本地操作会回传到房间）。

## 安装

1. 把 `watchparty.lua` 放入 mpv 脚本目录：
   - Windows：`%APPDATA%\mpv\scripts\watchparty.lua`
   - macOS/Linux：`~/.config/mpv/scripts/watchparty.lua`
2. 配置后端地址（`~~/script-opts/watchparty.conf`）：

   ```ini
   backend_origin=http://your-server:8080
   # 可选：
   # room_id=room-xxxxxxxx
   # site_basic_auth=user:password （生产 Caddy 全站 Basic Auth，用于所有 API 与 /p/ 回退；仅存内存）
   # media_basic_auth=...         （旧名兼容别名，等价 site_basic_auth）
   # debug=yes
   ```

   或启动时用 `--script-opts=watchparty-backend_origin=http://...`。

最低要求：mpv v0.33+（依赖 `mp.command_native_async`）与系统 `curl`。

## 使用

1. 在房间网页点击顶栏"发射到 MPV"，生成一次性交接码（5 分钟内有效，
   会自动复制到剪贴板）。
2. 打开 mpv，按 **Ctrl+J**（默认键位 `watchparty-join`）读取剪贴板加入房间。
   自动化/E2E 场景可通过 mpv IPC socket（`--input-ipc-server`）发送
   `script-message watchparty-join <交接码>`；交接码只允许经剪贴板或
   IPC socket 传递，禁止写入配置文件或进程命令行（如 `--script-msg`）。
3. 加入成功后 OSD 提示房间号并自动起播；之后每 2 秒轮询房间快照。
4. 在 MPV 中暂停 / 播放、拖动进度或调整倍速，会回传为房间命令；发生 revision 冲突时，
   脚本先拉取最新快照并最多重试一次。

重启 mpv 时，脚本会用本地保存的 token（`~~/watchparty.json`）静默重连
当前房间；token 失效（401/404）或服务端重启后自动清除并要求重新发射。
directUrl、响应头、`site_basic_auth`/`media_basic_auth` 不会写入磁盘。

## 行为边界（spec 第 9 节）

- MPV 永远是普通成员（`clientType=mpv`），不能获得房主权限。
- 交接码一次性、5 分钟 TTL，不进入 URL、日志、shell 命令、配置文件或进程命令行。
- 直连百度直链（`directUrl`）失败时自动回退 OpenList `/p/` 中转并 OSD 提示；
  每个媒体至多重试一次，不会无限循环。
- 双链均强制 `User-Agent: pan.baidu.com`（缺失会挂起，gate 实测）。
- 锁定房间中 MPV 收到 FORBIDDEN 只提示一次，不刷屏。
- 本地暂停 / 播放、seek、倍速和播放结束后的下一项会回传到房间；远端应用产生的
  属性变化会被抑制，避免回环。
- 外挂字幕：OpenList 媒体加载后自动发现同目录字幕（ass/ssa/srt/vtt），带凭据
  下载到 UTF-8 临时文件后 `sub-add`（auto，不强制选中，用户在 mpv 里切换）；
  内嵌字幕走 mpv 原生 `sid`。临时文件在换片和退出时清理，不进入配置目录。

## 快捷方式：watchparty:// 链接（阶段 4）

已加入过的房间可以用浏览器直接打开 `watchparty://<roomId>` 恢复连接
（插件用本地已保存的凭据静默重连）。

URL 模板在 `mpv-plugin/url-scheme/`（Windows .reg / Linux .desktop）。

> 兼容性说明：安装 Tauri 桌面端后，`watchparty://` 必须由 Tauri 独占注册。
> 下方 MPV 模板只保留给未安装 Tauri 的旧版/调试环境；不要在同一台机器上安装两种处理器，
> 否则后安装者会覆盖系统关联。外部 MPV 仍可通过交接码或 IPC 加入房间。
安全边界：URL 只携带 roomId，**交接票据永远不进入 URL 或命令行**；
首次加入仍走网页发射 + Ctrl+J 剪贴板流程；未加入过的房间会 OSD 引导。

## 故障排查

| OSD 提示 | 含义 |
| --- | --- |
| 交接码无效、已使用或已过期 | 重新在网页生成 |
| 协议版本不兼容 | 插件与服务端版本不匹配，更新后重试 |
| 凭据已失效，请重新发射 | token 过期或服务端重启，已自动清除本地保存 |
| 直连失败，已切换服务器中转 | 直链失效，正在走服务器回退链路 |

调试：`--script-opts=watchparty-debug=yes`，日志输出到 mpv 终端（含
RTT / 时钟偏移采样，敏感凭据不会打印）。HTTP 请求中的 token、交接码和 JSON 请求体
通过临时 curl 配置文件传递，不使用 subprocess stdin，因此兼容 Windows mpv；
Unix 下该文件在启动请求前同步收紧为仅当前用户可读（chmod 600），
Windows 依赖 %TEMP% 目录默认的用户级 ACL。
