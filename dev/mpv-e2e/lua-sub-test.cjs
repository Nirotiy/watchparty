const fengari = require("fengari");
const fs = require("fs");
const path = require("path");
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const base = "C:/Users/Nirotiy/Documents/NRT-GIT/watchparty/dev/mpv-e2e";
const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

function run(code, label) {
  const status = lauxlib.luaL_dostring(L, to_luastring(code));
  if (status !== lua.LUA_OK) {
    const err = lua.lua_tostring(L, -1);
    console.error(`FAIL at ${label}:`, Buffer.from(err).toString("latin1"));
    process.exit(1);
  }
}

run(fs.readFileSync(path.join(base, "lua-sub-stub.lua"), "utf8"), "stub");

let src = fs.readFileSync("C:/Users/Nirotiy/Documents/NRT-GIT/watchparty/mpv-plugin/watchparty.lua", "utf8");
src += "\n_G.__state = state; _G.__opts = o; _G.__discover = discover_subtitles; _G.__cleanup = cleanup_subtitle_files; _G.__handle_url = handle_watchparty_url\n";

run(src, "plugin");

const test = `
-- 场景：已加入房间、openlist 媒体已加载
local state = _G.__state
state.joined = true
state.roomId = "room-x"
state.accessToken = "tok123"
state.loadGeneration = 1
state.mediaLoaded = true
state.lastSnapshot = {
  revision = 5,
  source = { kind = "openlist", mediaId = "M1.sig", title = "Show", container = "mp4" },
  currentPlaylistItemId = nil,
  positionSeconds = 0, paused = true, playbackRate = 1,
}

-- 发现结果：srt（带语言）、ass（无语言）、未知格式（被过滤）、404 内容（跳过）
_G.__test_subtitles = '[{"id":"a","mediaId":"sub1.sig","label":"简体","format":"srt","language":"zh-Hans"},'
  .. '{"id":"b","mediaId":"sub2.sig","label":"Styling","format":"ass"},'
  .. '{"id":"c","mediaId":"sub3.sig","label":"Weird","format":"exe"}]'
_G.__test_sub_content = { ["sub1.sig"] = "SUB ONE CONTENT", ["sub2.sig"] = "ASS CONTENT" }

local calls = _G.__calls
_G.__discover(1)

assert(#calls.commandv == 2, "sub-add calls = " .. #calls.commandv)

local first = calls.commandv[1]
assert(first[1] == "sub-add", "cmd name")
assert(first[2]:find("watchparty-sub-", 1, true), "temp prefix: " .. tostring(first[2]))
assert(first[2]:match("%.srt$"), "srt extension: " .. tostring(first[2]))
assert(first[3] == "auto", "auto flag")
assert(first[4] == "简体", "label: " .. tostring(first[4]))
assert(first[5] == "zh-Hans", "lang")

local second = calls.commandv[2]
assert(second[2]:match("%.ass$"), "ass extension")
assert(second[4] == "Styling", "ass label")
assert(#second == 4, "no lang arg when missing: " .. #second)

-- 内容写入与编码
local srtPath = first[2]
assert(_G.__files[srtPath] == "SUB ONE CONTENT", "srt content")
assert(_G.__files[second[2]] == "ASS CONTENT", "ass content")

-- 认证头进 curl 临时配置（不在进程参数里）：房间 token 走专用头；
-- 未配置站点凭据时不得出现 Authorization（保留给 Caddy 站点 Basic Auth）
assert(#calls.configs >= 3, "config files recorded: " .. #calls.configs)
for _, c in ipairs(calls.configs) do
  assert(c.content and c.content:find("X-WatchParty-Token: tok123", 1, true), "token header in config")
  assert(not c.content:find("Authorization:", 1, true), "no Authorization without site credential")
end

-- 站点凭据（site_basic_auth）：附在所有 API 请求上，与 token 头并存
_G.__opts.site_basic_auth = "alice:s3cret"
_G.__calls.configs = {}
state.loadGeneration = 3
state.subtitlesLoadedGen = nil
_G.__discover(3)
assert(#calls.configs >= 3, "site-auth configs recorded: " .. #calls.configs)
for _, c in ipairs(calls.configs) do
  assert(c.content and c.content:find("X-WatchParty-Token: tok123", 1, true), "token header still present")
  assert(c.content and c.content:find("Authorization: Basic", 1, true), "site basic in config")
end
_G.__opts.site_basic_auth = ""

-- 幂等：同代次不重复加载
local before = #calls.commandv
_G.__discover(1)
assert(#calls.commandv == before, "idempotent per generation")

-- 换片清理：临时文件全部被 os.remove
_G.__cleanup()
assert(#calls.remove >= 2, "cleanup removed temp files: " .. #calls.remove)
for _, p in ipairs(calls.remove) do
  assert(_G.__files[p] == nil, "removed file gone: " .. p)
end

-- 新代次重新发现
state.loadGeneration = 2
_G.__discover(2)
assert(#calls.commandv > before, "new generation reloads subs")

-- ============ watchparty:// 快捷方式（阶段 4） ============
local state2 = _G.__state
-- 重置到未加入状态，并种子化持久化文件（stub 的 command_native 返回 /tmp/watchparty.json）
state2.joined = false
state2.roomId = nil
state2.accessToken = nil
state2.loadGeneration = 1
_G.__files["/tmp/watchparty.json"] = '{"roomId":"room-x","accessToken":"tok123","clientId":"cid1","savedAt":1}'

local handled = _G.__handle_url("watchparty://room-x")
assert(handled == true, "url recognized")
assert(state2.joined == true, "resumed joined")
assert(state2.roomId == "room-x", "roomId")
assert(state2.accessToken == "tok123", "token restored")
local stopCmd = calls.commandv[#calls.commandv]
assert(stopCmd[1] == "stop", "load cancelled via stop: " .. tostring(stopCmd[1]))

-- 无关房间：不恢复、OSD 引导
state2.roomId = "room-x" -- 保持已加入
local other = _G.__handle_url("watchparty://room-other/")
assert(other == true, "still intercepted")
assert(state2.roomId == "room-x", "no cross-room resume")

-- 非 watchparty URL：不拦截
assert(_G.__handle_url("https://example.com/v.mp4") == false, "non-wp url passes through")

-- 空 roomId
assert(_G.__handle_url("watchparty://") == true, "empty target still intercepted")

print("SUBTITLE FLOW TESTS PASS")
`;

run(test, "subtitle tests");
console.log("all good");
