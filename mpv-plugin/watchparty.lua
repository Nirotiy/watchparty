-- watchparty.lua — WatchParty MPV 侧支客户端
-- 阶段 1：壳 + 加入流程 + 只读同步（媒体/暂停/倍速/进度），本地操作回传在阶段 2 加入。
--
-- 浏览器是唯一控制台：MPV 用网页"发射到 MPV"生成的一次性交接码加入房间
-- （Ctrl+J 读剪贴板，或 script-message watchparty-join <交接码>），
-- 之后以 2s 轮询快照并应用房间状态。
--
-- script-opts（~~/script-opts/watchparty.conf 或 --script-opts=watchparty-xxx=...）：
--   backend_origin      后端地址，例如 http://127.0.0.1:8080（必填）
--   room_id             预设房间号（可选；与持久化 token 一致时静默重连）
--   site_basic_auth     生产 Caddy 全站 Basic Auth 凭据 "user:password"（可选，仅存内存；
--                       用于所有 WatchParty API 请求与 /p/ 回退播放）
--   media_basic_auth    site_basic_auth 的旧名兼容别名
--   poll_interval       快照轮询间隔秒（默认 2）
--   sync_seek_threshold 追帧 seek 阈值秒（默认 1.0）
--   debug               打印调试日志
--
-- 交接码传递边界（spec 9.2 红线）：ticket 只能经剪贴板（Ctrl+J）或
-- mpv IPC socket（script-message，自动化/E2E 用）传入，
-- 绝不提供 script-opts 项，避免 ticket 被持久化到 watchparty.conf。

local mp = require "mp"
local msg = require "mp.msg"
local opt = require "mp.options"
local unpack = unpack or table.unpack -- LuaJIT / Lua 5.4 兼容

local o = {
    backend_origin = "",
    room_id = "",
    site_basic_auth = "",
    media_basic_auth = "", -- 旧名兼容别名：等价于 site_basic_auth
    poll_interval = 2,
    sync_seek_threshold = 1.0,
    debug = false,
}
opt.read_options(o, "watchparty")

-- 站点凭据（生产 Caddy 全站 Basic Auth）：新名 site_basic_auth；
-- media_basic_auth 为旧名兼容别名。仅存内存，不落盘、不进日志。
if o.site_basic_auth == "" and o.media_basic_auth ~= "" then
    o.site_basic_auth = o.media_basic_auth
end

-- ============================================================
-- 常量
-- ============================================================

-- 必须与后端 PROTOCOL_VERSION 一致（spec 9.1）；不一致服务端 426 硬拒绝。
local PROTOCOL_VERSION = 2
-- gate 实测：百度直链与 OpenList /p/ 代理均要求该 UA，缺失会挂起。
local REQUIRED_USER_AGENT = "pan.baidu.com"
-- 响应上限：快照很小，但外挂字幕服务端允许到 5MB（SUBTITLE_CAP_BYTES）。
local MAX_RESPONSE_BYTES = 6 * 1024 * 1024
local CONNECT_TIMEOUT = 5
local OVERALL_TIMEOUT = 12
-- 网络连续失败的轮询退避序列（秒）；恢复后回到 poll_interval。
local BACKOFF_STEPS = { 4, 8, 16 }
-- 远端状态应用后抑制本地回传的窗口（阶段 2 的 observer 依赖此标记）。
local REMOTE_SUPPRESS_SECONDS = 1.0
-- 时钟偏移样本的跳变阈值：超过则丢弃样本（系统时钟跳变/服务端异常）。
local CLOCK_JUMP_GUARD_MS = 5000

local PROTOCOL_MISMATCH = "PROTOCOL_VERSION_MISMATCH"

-- ============================================================
-- 前置声明与状态
-- ============================================================

-- 所有异步回调（HTTP 响应、file-loaded、end-file）都必须校验 loadGeneration，
-- 旧媒体的回调不得覆盖新媒体状态（spec 9.4 / 风险表）。
local state = {
    joined = false,
    roomId = nil,
    accessToken = nil,
    clientId = nil,
    lastRevision = nil,
    failCount = 0,
    inFlight = false,
    pollTimer = nil,
    loadGeneration = 0,
    currentMediaKey = nil,
    lastSnapshot = nil,
    mediaLoaded = false,
    fallbackUsed = false,
    resolveRetried = false,
    -- 时钟偏移（serverTimeMs - 本地估计 epoch，毫秒）；RTT 中点 + 样本中位数。
    clockSamples = {},
    clockOffsetMs = 0,
    -- 远端状态应用标记：应用快照触发的属性变化不得回传命令（阶段 2）。
    applyingRemote = false,
    suppressDeadline = 0,
    -- 最近一次远端纠偏 seek 的目标位置（用于区分远端纠偏与用户 seek）。
    lastRemoteSeekTarget = nil,
    -- 外挂字幕临时文件路径与已加载代次（换片/退出时清理）。
    tempSubtitleFiles = nil,
    subtitlesLoadedGen = nil,
    -- 微调追帧的临时倍速（不在房间状态里，收敛后恢复房间倍速）。
    nudge = nil,
    -- 锁定房间 FORBIDDEN 的 OSD 节流。
    forbiddenQuietUntil = 0,
}

-- 本地 epoch 毫秒估计：os.time()（整数秒）锚定 + mp 单调钟细分。
-- 常量偏移不影响同步数学（偏移估计与外推使用同一时钟，误差相消），
-- 且系统时钟跳变不影响 mp 单调钟。
local epochBaseMs = os.time() * 1000 - math.floor(mp.get_time() * 1000)

local function now_ms()
    return epochBaseMs + mp.get_time() * 1000
end

local poll_snapshot -- forward declarations（互相递归的调度链）
local schedule_poll
local update_clock
local apply_snapshot
local load_media
local cleanup_subtitle_files

-- ============================================================
-- 最小 JSON 实现（mpv Lua 环境无内置 JSON 库）
-- ============================================================

local json = {}
local null = setmetatable({}, { __tostring = function() return "null" end })
json.null = null

local function json_utf8_encode(code)
    -- 用算术而非位运算，兼容 Lua 5.1
    local function b(n, shift)
        return math.floor(n / 2 ^ shift) % 256
    end
    if code < 0x800 then
        return string.char(0xC0 + b(code, 6), 0x80 + code % 64)
    elseif code < 0x10000 then
        return string.char(0xE0 + b(code, 12), 0x80 + b(code, 6) % 64, 0x80 + code % 64)
    end
    return string.char(0xF0 + b(code, 18), 0x80 + b(code, 12) % 64,
        0x80 + b(code, 6) % 64, 0x80 + code % 64)
end

local function skip_whitespace(s, pos)
    while pos <= #s do
        local c = s:sub(pos, pos)
        if c == " " or c == "\t" or c == "\n" or c == "\r" then
            pos = pos + 1
        else
            break
        end
    end
    return pos
end

local parse_value -- forward declaration

local function parse_string(s, pos)
    pos = pos + 1 -- 跳过开头引号
    local buf = {}
    while pos <= #s do
        local c = s:sub(pos, pos)
        if c == '"' then
            return table.concat(buf), pos + 1
        elseif c == "\\" then
            local esc = s:sub(pos + 1, pos + 1)
            pos = pos + 2
            if esc == '"' then
                buf[#buf + 1] = '"'
            elseif esc == "\\" then
                buf[#buf + 1] = "\\"
            elseif esc == "/" then
                buf[#buf + 1] = "/"
            elseif esc == "b" then
                buf[#buf + 1] = "\b"
            elseif esc == "f" then
                buf[#buf + 1] = "\f"
            elseif esc == "n" then
                buf[#buf + 1] = "\n"
            elseif esc == "r" then
                buf[#buf + 1] = "\r"
            elseif esc == "t" then
                buf[#buf + 1] = "\t"
            elseif esc == "u" then
                local code = tonumber(s:sub(pos, pos + 3), 16)
                if not code then return nil, pos end
                pos = pos + 4
                -- 代理对拼合（媒体标题可能含非 BMP 字符）
                if code >= 0xD800 and code <= 0xDBFF and s:sub(pos, pos + 1) == "\\u" then
                    local low = tonumber(s:sub(pos + 2, pos + 5), 16)
                    if low and low >= 0xDC00 and low <= 0xDFFF then
                        code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
                        pos = pos + 6
                    end
                end
                buf[#buf + 1] = json_utf8_encode(code)
            else
                return nil, pos
            end
        else
            buf[#buf + 1] = c
            pos = pos + 1
        end
    end
    return nil, pos
end

parse_value = function(s, pos)
    pos = skip_whitespace(s, pos)
    if pos > #s then return nil, pos end
    local c = s:sub(pos, pos)
    if c == "{" then
        local obj = {}
        pos = skip_whitespace(s, pos + 1)
        if s:sub(pos, pos) == "}" then return obj, pos + 1 end
        while pos <= #s do
            local key
            key, pos = parse_string(s, skip_whitespace(s, pos))
            if not key then return nil, pos end
            pos = skip_whitespace(s, pos)
            if s:sub(pos, pos) ~= ":" then return nil, pos end
            local value
            value, pos = parse_value(s, pos + 1)
            if value == nil then return nil, pos end
            obj[key] = value
            pos = skip_whitespace(s, pos)
            local d = s:sub(pos, pos)
            if d == "," then
                pos = pos + 1
            elseif d == "}" then
                return obj, pos + 1
            else
                return nil, pos
            end
        end
        return nil, pos
    elseif c == "[" then
        local arr = {}
        pos = skip_whitespace(s, pos + 1)
        if s:sub(pos, pos) == "]" then return arr, pos + 1 end
        while pos <= #s do
            local value
            value, pos = parse_value(s, pos)
            if value == nil then return nil, pos end
            arr[#arr + 1] = value
            pos = skip_whitespace(s, pos)
            local d = s:sub(pos, pos)
            if d == "," then
                pos = pos + 1
            elseif d == "]" then
                return arr, pos + 1
            else
                return nil, pos
            end
        end
        return nil, pos
    elseif c == '"' then
        return parse_string(s, pos)
    elseif s:sub(pos, pos + 3) == "null" then
        return null, pos + 4
    elseif s:sub(pos, pos + 3) == "true" then
        return true, pos + 4
    elseif s:sub(pos, pos + 4) == "false" then
        return false, pos + 5
    else
        local num_end = pos
        while num_end <= #s and s:sub(num_end, num_end):match("[%-%+%d%.eE]") do
            num_end = num_end + 1
        end
        local num = tonumber(s:sub(pos, num_end - 1))
        if num then return num, num_end end
        return nil, pos
    end
end

function json.parse(text)
    local value, pos = parse_value(text, 1)
    if value == nil then return nil end
    pos = skip_whitespace(text, pos)
    if pos <= #text then return nil end
    return value
end

function json.stringify(value)
    local t = type(value)
    if value == null or t == "nil" then return "null" end
    if t == "boolean" then return tostring(value) end
    if t == "number" then
        local n = math.floor(value)
        return n == value and string.format("%d", n) or string.format("%.6f", value)
    end
    if t == "string" then
        return '"' .. value:gsub('[%c"\\]', function(c)
            local map = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f",
                ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
            return map[c] or string.format("\\u%04x", c:byte())
        end) .. '"'
    end
    if t == "table" then
        local parts = {}
        if #value > 0 then
            for i = 1, #value do parts[i] = json.stringify(value[i]) end
            return "[" .. table.concat(parts, ",") .. "]"
        end
        for k, v in pairs(value) do
            parts[#parts + 1] = json.stringify(tostring(k)) .. ":" .. json.stringify(v)
        end
        return "{" .. table.concat(parts, ",") .. "}"
    end
    return "null"
end

local function base64_encode(data)
    -- 用算术而非位运算，兼容 Lua 5.1
    local chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    local function sextet(n, shift)
        local v = math.floor(n / 2 ^ shift) % 64
        return chars:sub(v + 1, v + 1)
    end
    local out = {}
    for i = 1, #data, 3 do
        local a, b, c = data:byte(i, i + 2)
        local n = (a or 0) * 0x10000 + (b or 0) * 0x100 + (c or 0)
        out[#out + 1] = sextet(n, 18) .. sextet(n, 12)
            .. (b and sextet(n, 6) or "=")
            .. (c and sextet(n, 0) or "=")
    end
    return table.concat(out)
end

-- ============================================================
-- HTTP：curl 子进程。
-- token / ticket / 请求体只经临时 curl 配置文件传入，
-- 不出现在进程列表或命令历史（spec 9.2 / 风险表：凭据泄漏）。
-- Windows 下 mpv subprocess 的 stdin_data 不能可靠地传给 curl，
-- 因此不能使用 --config -。
-- ============================================================

local function curl_escape_config(value)
    -- curl 配置文件带引号字符串的转义：反斜杠与双引号
    return value:gsub("\\", "\\\\"):gsub('"', '\\"')
end

-- req: { method, url, body(string|nil), secret_headers(list), headers(list) }
-- callback(status|nil, body|nil)：status nil = 网络/超时失败
local function http_request(req, callback)
    local config_lines = {}
    for _, h in ipairs(req.secret_headers or {}) do
        config_lines[#config_lines + 1] = 'header = "' .. curl_escape_config(h) .. '"'
    end
    if req.body then
        config_lines[#config_lines + 1] = 'data = "' .. curl_escape_config(req.body) .. '"'
    end

    local config_path = os.tmpname()
    local config_file = io.open(config_path, "w")
    if not config_file then
        callback(nil, nil)
        return
    end
    config_file:write(table.concat(config_lines, "\n"), "\n")
    config_file:close()
    -- Windows：%TEMP% 与用户 profile 目录默认 ACL 已限制为当前用户，无需额外收紧。
    -- Unix 下 /tmp 全局可读：必须在启动 curl 前同步（command_native）收紧权限，
    -- 异步 chmod 会与 curl 启动竞速，留下其他本地进程可读凭据的窗口；
    -- 收紧失败时 fail closed：删除文件并放弃本次请求。
    if mp.get_property("platform") ~= "windows" then
        local chmod = mp.command_native({
            name = "subprocess",
            args = { "chmod", "600", config_path },
            playback_only = false,
        })
        if type(chmod) ~= "table" or chmod.status ~= 0 then
            os.remove(config_path)
            callback(nil, nil)
            return
        end
    end

    local function cleanup()
        os.remove(config_path)
    end

    local args = {
        "curl", "-s", "-S",
        "--connect-timeout", tostring(CONNECT_TIMEOUT),
        "--max-time", tostring(OVERALL_TIMEOUT),
        "--write-out", "\n%{http_code}",
        "--config", config_path,
        "-X", req.method,
    }
    for _, h in ipairs(req.headers or {}) do
        args[#args + 1] = "-H"
        args[#args + 1] = h
    end
    -- 所有请求统一附带 MPV 客户端标识头（spec 9.3）；协议不匹配服务端 426 硬拒绝。
    args[#args + 1] = "-H"
    args[#args + 1] = "X-WatchParty-Protocol: " .. PROTOCOL_VERSION
    args[#args + 1] = "-H"
    args[#args + 1] = "X-WatchParty-Client-Type: mpv"
    args[#args + 1] = req.url

    mp.command_native_async({
        name = "subprocess",
        args = args,
        playback_only = false,
        capture_stdout = true,
        capture_stderr = true,
    }, function(success, result, err)
        cleanup()
        if not success or not result or result.status ~= 0 then
            if o.debug then
                msg.debug("http failed: " .. tostring(err or (result and result.stderr) or "?"))
            end
            callback(nil, nil)
            return
        end
        local stdout = result.stdout or ""
        if #stdout > MAX_RESPONSE_BYTES + 16 then
            callback(nil, nil)
            return
        end
        local body, status = stdout:match("^(.*)\n(%d%d%d)%s*$")
        if not status then
            callback(nil, stdout ~= "" and stdout or nil)
            return
        end
        callback(tonumber(status), body or "")
    end)
end

local function api_url(path)
    return o.backend_origin:gsub("/+$", "") .. path
end

-- 站点 Basic 凭据头：接受 "user:password"（自动 base64）或已编码值。
local function site_basic_header()
    if o.site_basic_auth == "" then return nil end
    local value = o.site_basic_auth
    if value:find(":", 1, true) then
        value = base64_encode(value)
    end
    return "Authorization: Basic " .. value
end

local function mpv_secret_headers()
    local headers = {}
    -- 房间 token 走专用头：Authorization 保留给生产 Caddy 全站 Basic Auth，
    -- 一个请求不能同时用两种方案表达在同一头里；本地/无 Caddy 部署由服务端
    -- 兼容解析旧 Authorization Bearer。
    if state.accessToken then
        headers[#headers + 1] = "X-WatchParty-Token: " .. state.accessToken
    end
    local basic = site_basic_header()
    if basic then
        headers[#headers + 1] = basic
    end
    return headers
end

-- ============================================================
-- OSD
-- ============================================================

local function osd(text, seconds)
    mp.osd_message("WatchParty: " .. text, seconds or 3)
end

-- ============================================================
-- 持久化：仅为当前房间保存短期重启便利（roomId/accessToken/clientId）。
-- directUrl、headers、media_basic_auth 一律不落盘（spec 9.4/9.5）。
-- ============================================================

local function persist_file()
    return mp.command_native({ "expand-path", "~~/watchparty.json" })
end

local function persist_save()
    local path = persist_file()
    local f = io.open(path, "w")
    if not f then
        msg.warn("cannot write " .. tostring(path))
        return
    end
    f:write(json.stringify({
        roomId = state.roomId,
        accessToken = state.accessToken,
        clientId = state.clientId,
        savedAt = math.floor(now_ms()),
    }))
    f:close()
    -- 同步收紧权限，理由同 http_request（消除异步 chmod 竞态窗口）。
    if mp.get_property("platform") ~= "windows" then
        local chmod = mp.command_native({
            name = "subprocess",
            args = { "chmod", "600", path },
            playback_only = false,
        })
        if type(chmod) ~= "table" or chmod.status ~= 0 then
            msg.warn("cannot restrict permissions on " .. tostring(path))
        end
    end
end

local function persist_load()
    local f = io.open(persist_file(), "r")
    if not f then return nil end
    local content = f:read("*a")
    f:close()
    return json.parse(content)
end

local function persist_clear()
    os.remove(persist_file())
end

-- ============================================================
-- 轮询调度
-- ============================================================

local function stop_polling()
    if state.pollTimer then
        state.pollTimer:kill()
        state.pollTimer = nil
    end
end

schedule_poll = function()
    stop_polling()
    local delay = o.poll_interval
    if state.failCount > 0 then
        delay = BACKOFF_STEPS[math.min(state.failCount, #BACKOFF_STEPS)]
    end
    state.pollTimer = mp.add_timeout(delay, poll_snapshot)
end

local function handle_auth_failure(code)
    stop_polling()
    state.joined = false
    persist_clear()
    if code == PROTOCOL_MISMATCH then
        osd("协议版本不兼容，请升级 mpv 插件", 6)
    elseif code == "ROOM_NOT_FOUND" then
        osd("房间不存在或已解散，请重新发射", 6)
    else
        osd("凭据已失效，请重新发射", 6)
    end
end

poll_snapshot = function()
    if not state.joined or state.inFlight then
        if state.joined then schedule_poll() end
        return
    end
    state.inFlight = true
    local t0 = now_ms()
    local url = api_url("/api/rooms/" .. state.roomId .. "/mpv/snapshot")
    if state.lastRevision then url = url .. "?since=" .. state.lastRevision end
    http_request({ method = "GET", url = url, secret_headers = mpv_secret_headers() }, function(status, body)
        state.inFlight = false
        if not state.joined then return end
        if status == nil then
            state.failCount = state.failCount + 1
            if state.failCount == 1 then osd("网络异常，重试中…") end
            schedule_poll()
            return
        end
        if status == 204 then
            state.failCount = 0
            schedule_poll()
            return
        end
        if status == 401 or status == 404 or status == 426 then
            local parsed = body and json.parse(body)
            handle_auth_failure(parsed and parsed.code or nil)
            return
        end
        if status ~= 200 then
            state.failCount = state.failCount + 1
            schedule_poll()
            return
        end
        if state.failCount > 0 then osd("连接已恢复") end
        state.failCount = 0
        local snap = body and json.parse(body)
        if type(snap) == "table" and type(snap.revision) == "number" then
            -- 乱序快照保护：只接受不倒退的 revision
            if state.lastRevision == nil or snap.revision >= state.lastRevision then
                update_clock(snap, t0)
                apply_snapshot(snap)
                state.lastRevision = snap.revision
            end
        end
        schedule_poll()
    end)
end

-- RTT 中点估算：offset = serverTimeMs - (t0 + rtt/2)，滚动窗口取中位数。
-- 所有本地时间差值基于同一时钟估计，常量偏移在外推中相消。
function update_clock(snap, t0)
    if type(snap.serverTimeMs) ~= "number" then return end
    local rtt = now_ms() - t0
    local sample = snap.serverTimeMs - (t0 + rtt / 2)
    if math.abs(sample - state.clockOffsetMs) > CLOCK_JUMP_GUARD_MS then
        if state.lastRevision == nil then
            -- 首次校准直接接受
            state.clockOffsetMs = sample
            state.clockSamples = { sample }
        else
            state.clockSamples = {}
        end
        msg.debug("clock jump guard: dropping offset samples")
        return
    end
    local samples = state.clockSamples
    samples[#samples + 1] = sample
    if #samples > 5 then table.remove(samples, 1) end
    local sorted = {}
    for i, v in ipairs(samples) do sorted[i] = v end
    table.sort(sorted)
    state.clockOffsetMs = sorted[math.ceil(#sorted / 2)]
    if o.debug then
        msg.debug(string.format("rtt=%.0fms offset=%.0fms (n=%d)", rtt, state.clockOffsetMs, #samples))
    end
end

-- ============================================================
-- 快照应用（媒体、暂停、倍速、进度 + 微调追帧）
-- ============================================================

local function media_key(source)
    if not source or type(source) ~= "table" then return nil end
    if source.kind == "openlist" then return "openlist:" .. tostring(source.mediaId) end
    if source.kind == "youtube" then return "youtube:" .. tostring(source.videoId) end
    if source.kind == "http" or source.kind == "hls" then
        return source.kind .. ":" .. tostring(source.url)
    end
    return nil
end

local function source_playable_url(source)
    if source.kind == "youtube" then
        return "https://www.youtube.com/watch?v=" .. tostring(source.videoId)
    end
    return source.url
end

local function mark_remote_apply()
    state.suppressDeadline = mp.get_time() + REMOTE_SUPPRESS_SECONDS
end

-- 远端状态应用窗口期内：本地 observer 不得把远端触发的属性变化回传为命令。
local function is_suppressed()
    return state.applyingRemote or mp.get_time() < state.suppressDeadline
end

function apply_snapshot(snap)
    state.lastSnapshot = snap
    local key = media_key(snap.source)
    if key ~= state.currentMediaKey then
        load_media(snap)
        return
    end
    -- 播完推进后若新条目与当前媒体相同（mpv 已 idle），需要重新加载
    if not state.mediaLoaded and not state.loading then
        load_media(snap)
        return
    end
    if not state.mediaLoaded then return end

    -- 暂停状态
    local paused = mp.get_property_bool("pause")
    if paused ~= snap.paused then
        mark_remote_apply()
        mp.set_property_bool("pause", snap.paused)
    end

    -- 倍速（非法倍速由服务端拒绝，这里应用快照中的有效值）
    local rate = mp.get_property_number("speed")
    if rate and math.abs(rate - snap.playbackRate) > 0.001 then
        mark_remote_apply()
        mp.set_property_number("speed", snap.playbackRate)
    end

    -- 进度：暂停时不外推，但位置偏差仍需纠偏（浏览器暂停时拖动进度的场景）
    local pos = mp.get_property_number("time-pos")
    if not pos then return end
    if snap.paused then
        local rate = mp.get_property_number("speed")
        if rate and math.abs(rate - snap.playbackRate) > 0.001 then
            mark_remote_apply()
            mp.set_property_number("speed", snap.playbackRate)
        end
        if math.abs(pos - snap.positionSeconds) > o.sync_seek_threshold then
            state.lastRemoteSeekTarget = snap.positionSeconds
            mark_remote_apply()
            mp.commandv("seek", string.format("%.3f", snap.positionSeconds), "absolute", "exact")
        end
        return
    end
    local server_elapsed = (now_ms() + state.clockOffsetMs - snap.serverTimeMs) / 1000
    local target = snap.positionSeconds + server_elapsed * snap.playbackRate
    if target < 0 then target = 0 end
    local pos = mp.get_property_number("time-pos")
    if not pos then return end
    local diff = math.abs(pos - target)
    if diff <= 0.25 then
        -- 已收敛：清除微调，恢复房间倍速
        if state.nudge then
            state.nudge = nil
            mark_remote_apply()
            mp.set_property_number("speed", snap.playbackRate)
        end
    elseif diff <= o.sync_seek_threshold then
        -- 250ms ～ 1s：短暂 ±5% 微调追帧，收敛后恢复
        local desired = snap.playbackRate * (pos < target and 1.05 or 0.95)
        if not state.nudge or math.abs(state.nudge.rate - desired) > 0.001 then
            state.nudge = { rate = desired }
            mark_remote_apply()
            mp.set_property_number("speed", desired)
        end
    else
        -- 超 1s：直接纠偏 seek（产生的 seek 事件靠 lastRemoteSeekTarget 识别并抑制）
        state.nudge = nil
        state.lastRemoteSeekTarget = target
        msg.debug(string.format("sync seek: local=%.2f target=%.2f", pos, target))
        mark_remote_apply()
        mp.commandv("seek", string.format("%.3f", target), "absolute", "exact")
    end
end

-- ============================================================
-- 媒体加载：resolve-mpv → loadfile（directUrl 优先，回退 fallbackUrl）
-- ============================================================

local function resolve_mpv(gen, callback)
    local source = state.lastSnapshot and state.lastSnapshot.source
    local media_id = source and source.kind == "openlist" and source.mediaId or nil
    if not media_id then
        callback(nil)
        return
    end
    http_request({
        method = "POST",
        url = api_url("/api/rooms/" .. state.roomId .. "/media/resolve-mpv"),
        body = json.stringify({ mediaId = media_id }),
        secret_headers = mpv_secret_headers(),
        headers = { "Content-Type: application/json" },
    }, function(status, body)
        if gen ~= state.loadGeneration then return end -- 旧媒体的响应，丢弃
        if status ~= 200 then
            osd("媒体解析失败 (" .. tostring(status or "网络") .. ")", 4)
            callback(nil)
            return
        end
        callback(body and json.parse(body))
    end)
end

local function start_playback(resolved, gen)
    if gen ~= state.loadGeneration or not resolved then return end
    local url
    if resolved.directUrl and resolved.directUrl ~= json.null and resolved.directUrl ~= "" then
        url = resolved.directUrl
    else
        url = resolved.fallbackUrl
        state.fallbackUsed = true
        if state.resolveRetried then
            osd("直连失败，已切换服务器中转", 4)
        else
            osd("直连不可用，使用服务器中转", 4)
        end
    end
    if not url then
        osd("无可播放地址", 4)
        return
    end

    -- UA 对直链与回退均为硬性要求（gate 实测）；白名单后仅 UA 可透传。
    local ua = REQUIRED_USER_AGENT
    if resolved.headers and type(resolved.headers) == "table" then
        for k, v in pairs(resolved.headers) do
            if k:lower() == "user-agent" and type(v) == "string" and v ~= "" then
                ua = v
            end
        end
    end
    mp.set_property("user-agent", ua)

    -- 站点凭据仅存内存并注入请求头；不得写入 URL/日志/OSD。
    local basicHeader = site_basic_header()
    if state.fallbackUsed and basicHeader then
        mp.set_property("file-local-options/http-header-fields", basicHeader)
    else
        mp.set_property("file-local-options/http-header-fields", "")
    end

    mark_remote_apply()
    state.mediaLoaded = false
    mp.commandv("loadfile", url, "replace")
    if state.lastSnapshot and state.lastSnapshot.paused then
        mp.set_property_bool("pause", true)
    end
end

function load_media(snap)
    cleanup_subtitle_files() -- 换片：清掉上一媒体的临时字幕文件
    local key = media_key(snap.source)
    if not key then
        if state.currentMediaKey then
            state.currentMediaKey = nil
            state.mediaLoaded = false
            mark_remote_apply()
            mp.commandv("stop")
        end
        cleanup_subtitle_files()
        return
    end
    state.loadGeneration = state.loadGeneration + 1
    local gen = state.loadGeneration
    state.currentMediaKey = key
    state.fallbackUsed = false
    state.resolveRetried = false
    state.mediaLoaded = false
    state.loading = true
    state.nudge = nil
    state.lastRemoteSeekTarget = nil

    if snap.source.kind == "openlist" then
        osd("加载媒体…", 2)
        resolve_mpv(gen, function(resolved)
            start_playback(resolved, gen)
        end)
    else
        -- http / hls / youtube：mpv 直接（youtube 经 ytdl_hook）
        local url = source_playable_url(snap.source)
        if not url then
            osd("无可播放地址", 4)
            return
        end
        mp.set_property("user-agent", REQUIRED_USER_AGENT)
        mp.set_property("file-local-options/http-header-fields", "")
        mark_remote_apply()
        mp.commandv("loadfile", url, "replace")
        if snap.paused then mp.set_property_bool("pause", true) end
    end
end

-- ============================================================
-- 外挂字幕（阶段 3）：discovery → 下载 → UTF-8 临时文件 → sub-add。
-- 内嵌字幕由 mpv 原生 sid 处理，无需插件参与。临时文件在换片/退出时清理，
-- 仅存于本地临时目录，不持久化到配置（spec 9.4）。
-- ============================================================

local SUBTITLE_FORMATS = { ass = true, ssa = true, srt = true, vtt = true }

-- 临时字幕文件统一前缀：便于启动时清扫异常退出的残留（验收矩阵：异常退出后的残留清理）
local SUBTITLE_TEMP_PREFIX = "watchparty-sub-"

local function subtitle_temp_dir()
    local base = os.tmpname()
    local dir = base:match("^(.*[\\/])") or "."
    os.remove(base)
    return dir
end

local function cleanup_stale_subtitle_files()
    local dir = subtitle_temp_dir()
    local pattern = dir .. SUBTITLE_TEMP_PREFIX .. "*"
    if mp.get_property("platform") == "windows" then
        mp.command_native_async({
            name = "subprocess", args = { "cmd", "/c", "del", "/q", pattern },
            playback_only = false,
        }, function() end)
    else
        mp.command_native_async({
            name = "subprocess", args = { "sh", "-c", "rm -f '" .. pattern .. "'" },
            playback_only = false,
        }, function() end)
    end
end

function cleanup_subtitle_files()
    for _, path in ipairs(state.tempSubtitleFiles or {}) do
        local removed = os.remove(path)
        if not removed and o.debug then
            msg.debug("subtitle temp file remove failed: " .. tostring(path))
        end
    end
    state.tempSubtitleFiles = nil
    state.subtitlesLoadedGen = nil
end

local function write_subtitle_tempfile(text, format, index)
    local path = subtitle_temp_dir() .. SUBTITLE_TEMP_PREFIX .. os.time() .. "-"
        .. tostring(state.loadGeneration or 0) .. "-" .. index .. "." .. format
    local f = io.open(path, "wb")
    if not f then
        msg.warn("cannot write subtitle tempfile " .. tostring(path))
        return nil
    end
    f:write(text)
    f:close()
    return path
end

local function add_subtitle_track(path, track)
    -- sub-add <file> auto <title> <lang>：不强制选中，用户在 mpv 里切换
    local args = { "sub-add", path, "auto", tostring(track.label or "Subtitle") }
    if track.language and track.language ~= "" then
        args[#args + 1] = tostring(track.language)
    end
    mp.commandv(unpack(args))
end

local function download_subtitles(tracks, index, gen)
    if gen ~= state.loadGeneration then return end -- 换片，放弃剩余字幕
    if index > #tracks then
        osd("已加载 " .. #tracks .. " 个外挂字幕", 2)
        return
    end
    local track = tracks[index]
    http_request({
        method = "GET",
        url = api_url("/api/rooms/" .. state.roomId .. "/media/subtitle?mediaId=" .. track.mediaId),
        secret_headers = mpv_secret_headers(),
    }, function(status, body)
        if gen ~= state.loadGeneration then return end
        if status == 200 and body and body ~= "" then
            local path = write_subtitle_tempfile(body, track.format, index)
            if path then
                state.tempSubtitleFiles = state.tempSubtitleFiles or {}
                state.tempSubtitleFiles[#state.tempSubtitleFiles + 1] = path
                add_subtitle_track(path, track)
                msg.debug("subtitle added: " .. tostring(track.label))
            end
        else
            msg.debug("subtitle download failed: " .. tostring(track.label) .. " status=" .. tostring(status))
        end
        download_subtitles(tracks, index + 1, gen)
    end)
end

local function discover_subtitles(gen)
    if state.subtitlesLoadedGen == gen then return end
    local source = state.lastSnapshot and state.lastSnapshot.source
    if not source or source.kind ~= "openlist" or not source.mediaId then return end
    state.subtitlesLoadedGen = gen
    http_request({
        method = "GET",
        url = api_url("/api/rooms/" .. state.roomId .. "/media/subtitles?mediaId=" .. source.mediaId),
        secret_headers = mpv_secret_headers(),
    }, function(status, body)
        if gen ~= state.loadGeneration then return end
        if status ~= 200 then
            msg.debug("subtitle discovery failed: status=" .. tostring(status))
            return
        end
        local tracks = body and json.parse(body)
        if type(tracks) ~= "table" then return end
        local usable = {}
        for _, track in ipairs(tracks) do
            if type(track) == "table" and type(track.mediaId) == "string"
                and SUBTITLE_FORMATS[track.format] then
                usable[#usable + 1] = track
            end
        end
        if #usable == 0 then return end
        download_subtitles(usable, 1, gen)
    end)
end

-- ============================================================
-- 本地操作回传（阶段 2）：pause/play、seek、rate → CMD:*
-- 乐观执行；REVISION_CONFLICT 时让位服务端快照并最多重试一次。
-- ============================================================

-- 立即拉取一次快照（绕开轮询节奏），用于冲突后快速收敛/取新 revision。
local function fetch_snapshot(callback)
    http_request({
        method = "GET",
        url = api_url("/api/rooms/" .. state.roomId .. "/mpv/snapshot"),
        secret_headers = mpv_secret_headers(),
    }, function(status, body)
        if status == 200 and body then
            local snap = json.parse(body)
            if type(snap) == "table" and type(snap.revision) == "number"
                and (state.lastRevision == nil or snap.revision >= state.lastRevision) then
                update_clock(snap, now_ms())
                apply_snapshot(snap)
                state.lastRevision = snap.revision
            end
        end
        if callback then callback() end
    end)
end

local function send_command(payload, on_ok)
    if not state.joined then return end
    payload.expectedRevision = state.lastRevision or 0
    local attempt = 0
    local function dispatch()
        payload.expectedRevision = state.lastRevision or 0
        http_request({
            method = "POST",
            url = api_url("/api/rooms/" .. state.roomId .. "/mpv/command"),
            body = json.stringify(payload),
            secret_headers = mpv_secret_headers(),
            headers = { "Content-Type: application/json" },
        }, function(status, body)
            if not state.joined then return end
            local ack = status and body and json.parse(body)
            if ack and ack.ok then
                state.lastRevision = ack.revision
                if on_ok then on_ok() end
                -- ack 对应的新快照无法通过后续 since=rev 轮询获得（会 204），
                -- 必须立即拉取，否则 lastSnapshot 停留在旧状态（如旧倍速）
                fetch_snapshot()
                return
            end
            local code = ack and ack.error and ack.error.code
            if code == "REVISION_CONFLICT" and attempt == 0 then
                attempt = attempt + 1
                -- 先拉最新快照（让位服务端状态），只有 revision 变化才重试。
                local conflictedRevision = state.lastRevision
                fetch_snapshot(function()
                    if state.lastRevision == conflictedRevision then return end
                    dispatch()
                end)
                return
            end
            if code == "FORBIDDEN" then
                -- 锁定房间：只提示一次，不刷屏（spec 9.4）
                if mp.get_time() > state.forbiddenQuietUntil then
                    state.forbiddenQuietUntil = mp.get_time() + 30
                    osd("房间已锁定，只有房主可以操作", 4)
                end
                return
            end
            -- 其他错误：静默让位，等待快照收敛
        end)
    end
    dispatch()
end

-- ============================================================
-- 播放器事件
-- ============================================================

mp.register_event("file-loaded", function()
    state.mediaLoaded = true
    state.loading = false
    if state.lastSnapshot and state.joined then
        apply_snapshot(state.lastSnapshot)
        discover_subtitles(state.loadGeneration)
    end
end)

-- 正常播完（eof）：仍对应当前条目时驱动列表推进；
-- 双 MPV 竞态由服务端 expectedCurrentPlaylistItemId + revision 收敛，失败方静默。
-- 错误结束由下方有限状态机处理，禁止无限重试。
mp.register_event("end-file", function(event)
    local snap = state.lastSnapshot
    if event.reason == "eof" then
        if state.joined and snap and snap.currentPlaylistItemId
            and state.currentMediaKey == media_key(snap.source)
            and state.mediaLoaded then
            send_command({
                type = "playlistNext",
                expectedCurrentPlaylistItemId = snap.currentPlaylistItemId,
            }, function()
                state.mediaLoaded = false
                -- Ack 已推进 revision，但不包含新快照；立即拉取完整快照触发同媒体重载。
                fetch_snapshot()
            end)
        end
        return
    end
    if event.reason ~= "error" then return end
    if not state.joined or not state.currentMediaKey or not state.lastSnapshot then return end
    if state.fallbackUsed or state.resolveRetried then
        osd("播放失败，媒体不可用", 5)
        return
    end
    state.resolveRetried = true
    msg.debug("playback error, re-resolving for fallback")
    local gen = state.loadGeneration
    resolve_mpv(gen, function(resolved)
        if not resolved then return end
        -- directUrl 刚刚失败过，强制走 fallback
        resolved.directUrl = nil
        start_playback(resolved, gen)
    end)
end)

-- ============================================================
-- 本地操作回传的 property observers（远端应用被抑制标记拦截）
-- ============================================================

mp.observe_property("pause", "bool", function(_, value)
    if value == nil then return end
    if not state.joined or not state.mediaLoaded then return end
    if is_suppressed() then return end
    local snap = state.lastSnapshot
    if snap and snap.paused == value then return end -- 与房间状态一致，无需回传
    send_command({ type = value and "pause" or "play" })
end)

-- 本地 seek：拖动结束后 400ms debounce 发送一次 CMD:seek；
-- 远端纠偏产生的 seek 在窗口期内且位置与纠偏目标吻合时被识别并抑制（spec 9.4）。
local seek_timer = nil
mp.register_event("seek", function()
    if not state.joined or not state.mediaLoaded then return end
    if seek_timer then seek_timer:kill() end
    seek_timer = mp.add_timeout(0.4, function()
        seek_timer = nil
        if not state.joined or not state.mediaLoaded then return end
        local pos = mp.get_property_number("time-pos")
        if not pos or pos < 0 then return end
        if mp.get_time() < state.suppressDeadline and state.lastRemoteSeekTarget
            and math.abs(pos - state.lastRemoteSeekTarget) < 0.75 then
            state.lastRemoteSeekTarget = nil
            msg.debug("seek event is our own remote apply, suppressed")
            return
        end
        state.lastRemoteSeekTarget = nil
        msg.debug(string.format("user seek: %.2f", pos))
        send_command({ type = "seek", positionSeconds = pos })
    end)
end)

mp.observe_property("speed", "number", function(_, value)
    if value == nil then return end
    if not state.joined or not state.mediaLoaded then return end
    local snap = state.lastSnapshot
    local roomRate = snap and snap.playbackRate or 1
    -- 值判别代替时间窗：远端应用只会把 speed 设成房间倍速（含重置）或微调值，
    -- 其他任何值都来自用户操作，即使在抑制窗口内也必须回传。
    if math.abs(value - roomRate) < 0.001 then return end
    if state.nudge and math.abs(value - state.nudge.rate) < 0.001 then return end
    if value < 0.25 or value > 2 then return end -- 服务端会拒绝；等快照回写有效值
    msg.debug("user rate change: " .. tostring(value))
    send_command({ type = "rate", rate = value })
end)

-- on_load hook：拦截 watchparty://<roomId> 快捷方式（阶段 4）。
-- URL 只携带 roomId，票据永远不进命令行（spec 9.2 红线）；
-- 已加入过的房间用持久化 token 直接恢复，否则 OSD 引导首次加入。
local function resume_persisted_room(target_room_id)
    local saved = persist_load()
    if saved and saved.accessToken and saved.clientId and saved.roomId
        and saved.roomId == target_room_id then
        if state.joined then
            osd("已在房间 " .. tostring(state.roomId), 3)
            return true
        end
        state.joined = true
        state.roomId = saved.roomId
        state.accessToken = saved.accessToken
        state.clientId = saved.clientId
        state.lastRevision = nil
        msg.debug("resuming room " .. tostring(saved.roomId) .. " from persisted token")
        osd("正在恢复房间连接…", 2)
        poll_snapshot()
        return true
    end
    return false
end

-- 拦截 watchparty://<roomId>：返回是否识别为快捷方式（供 on_load hook 使用）；
-- 识别为快捷方式时自行取消这次伪协议加载。
local function handle_watchparty_url(filename)
    if filename:sub(1, 13) ~= "watchparty://" then return false end
    local target = filename:sub(14):gsub("[/]+$", "")
    if target == "" then
        osd("URL 缺少房间号：watchparty://<roomId>", 5)
    elseif resume_persisted_room(target) then
        msg.info("watchparty:// resumed " .. tostring(target))
    else
        osd("尚未加入房间 " .. tostring(target) .. "：请先在网页发射并用 Ctrl+J 加入", 6)
    end
    -- 拦截完成：取消这次伪协议加载，回 idle
    mp.commandv("stop")
    return true
end

mp.add_hook("on_load", 50, function()
    local filename = mp.get_property("stream-open-filename", "")
    handle_watchparty_url(filename)
end)

-- 退出时清理外挂字幕临时文件
mp.register_event("shutdown", cleanup_subtitle_files)

-- ============================================================
-- 加入流程
-- ============================================================

local function join_with_ticket(ticket)
    if o.backend_origin == "" then
        osd("未配置 backend_origin（watchparty.conf 或 --script-opts）", 6)
        return
    end
    osd("正在加入房间…", 2)
    http_request({
        method = "POST",
        url = api_url("/api/mpv/handoff"),
        body = json.stringify({ ticket = ticket }),
        secret_headers = {},
        headers = { "Content-Type: application/json" },
    }, function(status, body)
        if status == 200 then
            local result = body and json.parse(body)
            if not result or type(result.protocolVersion) ~= "number" then
                osd("服务端响应异常", 5)
                return
            end
            if result.protocolVersion ~= PROTOCOL_VERSION then
                osd("协议版本不兼容，请升级 mpv 插件", 6)
                return
            end
            stop_polling()
            state.joined = true
            state.roomId = result.roomId
            state.accessToken = result.accessToken
            state.clientId = result.clientId
            state.lastRevision = nil
            state.failCount = 0
            state.currentMediaKey = nil
            state.lastSnapshot = nil
            state.mediaLoaded = false
            state.clockSamples = {}
            persist_save()
            osd("已加入房间 " .. tostring(result.roomId), 4)
            poll_snapshot()
        elseif status == 401 then
            osd("交接码无效、已使用或已过期，请重新发射", 6)
        elseif status == 404 then
            osd("房间不存在或已解散，请重新发射", 6)
        elseif status == 426 then
            osd("协议版本不兼容，请升级 mpv 插件", 6)
        else
            osd("加入失败 (" .. tostring(status or "网络") .. ")", 5)
        end
    end)
end

-- 剪贴板读取：票据不进入 URL、命令行或日志（spec 9.2）
local function read_clipboard(callback)
    local candidates
    local platform = mp.get_property("platform")
    if platform == "windows" then
        candidates = { { "powershell", "-NoProfile", "-Command", "Get-Clipboard" } }
    elseif platform == "darwin" then
        candidates = { { "pbpaste" } }
    else
        candidates = {
            { "wl-paste", "--no-newline" },
            { "xclip", "-selection", "clipboard", "-out" },
            { "xsel", "--clipboard", "--output" },
        }
    end
    local attempt = 0
    local function next_attempt()
        attempt = attempt + 1
        local cmd = candidates[attempt]
        if not cmd then
            callback(nil)
            return
        end
        mp.command_native_async({
            name = "subprocess",
            args = cmd,
            playback_only = false,
            capture_stdout = true,
        }, function(success, result)
            local out = success and result and result.stdout or ""
            out = (out or ""):gsub("^%s+", ""):gsub("%s+$", "")
            if out ~= "" then
                callback(out)
            else
                next_attempt()
            end
        end)
    end
    next_attempt()
end

-- join_flow(ticket_arg)：ticket_arg 只允许来自 mpv IPC socket 的
-- script-message（本地 socket 通道，供自动化/E2E 使用）；
-- 交互路径只有 Ctrl+J 剪贴板。交接码绝不写入 watchparty.conf 或
-- 进程命令行（--script-msg）（spec 9.2 红线）。
local function join_flow(ticket_arg)
    if state.joined then
        osd("已在房间 " .. tostring(state.roomId), 3)
        return
    end
    if ticket_arg and ticket_arg ~= "" then
        join_with_ticket(ticket_arg)
        return
    end
    read_clipboard(function(ticket)
        if state.joined then return end
        if ticket then
            join_with_ticket(ticket)
        else
            osd("无法读取剪贴板：请复制网页交接码后按 Ctrl+J 重试", 6)
        end
    end)
end

-- ============================================================
-- 启动
-- ============================================================

local function startup()
    -- 能力探测：缺失能力时提示最低版本并放弃网络功能
    if not mp.command_native_async or not mp.observe_property or not mp.add_timeout then
        mp.osd_message("WatchParty: mpv 版本过低（需要 v0.33+ 的 command_native_async）", 8)
        msg.error("mpv too old: command_native_async unavailable")
        return
    end

    mp.add_key_binding("ctrl+j", "watchparty-join", function() join_flow() end)
    -- 清扫上次异常退出残留的临时字幕文件（正常退出已由 shutdown 事件清理）
    cleanup_stale_subtitle_files()
    -- IPC 专用入口：ticket 只允许经本地 IPC socket 传入（不进命令行/配置）
    mp.register_script_message("watchparty-join", function(...)
        local count = select("#", ...)
        if count > 0 then
            join_flow((select(1, ...)))
        else
            join_flow()
        end
    end)

    -- 持久化 token 且（未预设 room_id 或与预设一致）→ 静默恢复
    local saved = persist_load()
    if saved and saved.accessToken and saved.clientId and saved.roomId then
        resume_persisted_room(o.room_id ~= "" and o.room_id or saved.roomId)
    end
end

startup()
