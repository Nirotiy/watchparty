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
--   ticket              直接写在配置里的交接码（可选，调试用）
--   media_basic_auth    生产 /p/ 回退的凭据 "user:password"（可选，仅存内存）
--   poll_interval       快照轮询间隔秒（默认 2）
--   sync_seek_threshold 追帧 seek 阈值秒（默认 1.0）
--   debug               打印调试日志

local mp = require "mp"
local msg = require "mp.msg"
local opt = require "mp.options"

local o = {
    backend_origin = "",
    room_id = "",
    ticket = "",
    media_basic_auth = "",
    poll_interval = 2,
    sync_seek_threshold = 1.0,
    debug = false,
}
opt.read_options(o, "watchparty")

-- ============================================================
-- 常量
-- ============================================================

-- 必须与后端 PROTOCOL_VERSION 一致（spec 9.1）；不一致服务端 426 硬拒绝。
local PROTOCOL_VERSION = 2
-- gate 实测：百度直链与 OpenList /p/ 代理均要求该 UA，缺失会挂起。
local REQUIRED_USER_AGENT = "pan.baidu.com"
local MAX_RESPONSE_BYTES = 1024 * 1024
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
-- token / ticket / 请求体只经 stdin 的 curl 配置（-K -）传入，
-- 不出现在进程列表或命令历史（spec 9.2 / 风险表：凭据泄漏）。
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

    local args = {
        "curl", "-s", "-S",
        "--connect-timeout", tostring(CONNECT_TIMEOUT),
        "--max-time", tostring(OVERALL_TIMEOUT),
        "--write-out", "\n%{http_code}",
        "--config", "-",
        "-X", req.method,
    }
    for _, h in ipairs(req.headers or {}) do
        args[#args + 1] = "-H"
        args[#args + 1] = h
    end
    args[#args + 1] = req.url

    mp.command_native_async({
        name = "subprocess",
        args = args,
        stdin_data = table.concat(config_lines, "\n"),
        playback_only = false,
        capture_stdout = true,
        capture_stderr = true,
    }, function(success, result, err)
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

local function mpv_secret_headers()
    local headers = {}
    if state.accessToken then
        headers[#headers + 1] = "Authorization: Bearer " .. state.accessToken
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
    if mp.get_property("platform") ~= "windows" then
        mp.command_native_async({
            name = "subprocess",
            args = { "chmod", "600", path },
            playback_only = false,
        }, function() end)
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
-- 快照应用（阶段 1 只读：媒体、暂停、倍速、进度）
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

function apply_snapshot(snap)
    state.lastSnapshot = snap
    local key = media_key(snap.source)
    if key ~= state.currentMediaKey then
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
    local rate = mp.get_property_number("playback-rate")
    if rate and math.abs(rate - snap.playbackRate) > 0.001 then
        mark_remote_apply()
        mp.set_property_number("playback-rate", snap.playbackRate)
    end

    -- 进度：以快照时刻为锚点，按服务器节奏外推目标位置
    if snap.paused then return end
    local server_elapsed = (now_ms() + state.clockOffsetMs - snap.serverTimeMs) / 1000
    local target = snap.positionSeconds + server_elapsed * snap.playbackRate
    if target < 0 then target = 0 end
    local pos = mp.get_property_number("time-pos")
    if not pos then return end
    local diff = math.abs(pos - target)
    if diff > o.sync_seek_threshold then
        msg.debug(string.format("sync seek: local=%.2f target=%.2f", pos, target))
        mark_remote_apply()
        mp.commandv("seek", string.format("%.3f", target), "absolute", "exact")
    end
    -- 阈值以内的偏差由 2s 快照节奏自然收敛；微调追帧留给阶段 2。
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

    -- media_basic_auth 仅存内存并注入请求头；不得写入 URL/日志/OSD。
    if state.fallbackUsed and o.media_basic_auth ~= "" then
        local auth = o.media_basic_auth
        if auth:find(":", 1, true) then
            auth = base64_encode(auth)
        end
        mp.set_property("file-local-options/http-header-fields", "Authorization: Basic " .. auth)
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
    local key = media_key(snap.source)
    if not key then
        if state.currentMediaKey then
            state.currentMediaKey = nil
            state.mediaLoaded = false
            mark_remote_apply()
            mp.commandv("stop")
        end
        return
    end
    state.loadGeneration = state.loadGeneration + 1
    local gen = state.loadGeneration
    state.currentMediaKey = key
    state.fallbackUsed = false
    state.resolveRetried = false
    state.mediaLoaded = false

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
-- 播放器事件
-- ============================================================

mp.register_event("file-loaded", function()
    state.mediaLoaded = true
    if state.lastSnapshot and state.joined then
        apply_snapshot(state.lastSnapshot)
    end
end)

-- end-file：错误结束 → 有限重试（re-resolve 一次 → fallback），禁止无限循环
mp.register_event("end-file", function(event)
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

-- on_load hook：预留 watchparty:// 拦截（v2 再做系统注册与完整拦截）
mp.add_hook("on_load", 50, function()
    local filename = mp.get_property("stream-open-filename", "")
    if filename:sub(1, 13) == "watchparty://" then
        msg.warn("watchparty:// handling arrives in v2")
    end
end)

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
        headers = {
            "Content-Type: application/json",
            "X-WatchParty-Protocol: " .. PROTOCOL_VERSION,
            "X-WatchParty-Client-Type: mpv",
        },
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

local function join_flow(ticket_arg)
    if state.joined then
        osd("已在房间 " .. tostring(state.roomId), 3)
        return
    end
    if ticket_arg and ticket_arg ~= "" then
        join_with_ticket(ticket_arg)
        return
    end
    if o.ticket ~= "" then
        join_with_ticket(o.ticket)
        return
    end
    read_clipboard(function(ticket)
        if state.joined then return end
        if ticket then
            join_with_ticket(ticket)
        else
            osd("无法读取剪贴板：请复制网页交接码后重试，或写入 script-opts 的 ticket 项", 6)
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
    if saved and saved.accessToken and saved.clientId and saved.roomId
        and (o.room_id == "" or o.room_id == saved.roomId) then
        state.joined = true
        state.roomId = saved.roomId
        state.accessToken = saved.accessToken
        state.clientId = saved.clientId
        msg.debug("resuming room " .. tostring(saved.roomId) .. " from persisted token")
        osd("正在恢复房间连接…", 2)
        poll_snapshot()
    end
end

startup()
