-- 字幕单测专用 mpv stub：录制 commandv、模拟 curl、内存文件系统
-- 注意：本文件是 lua-sub-test.cjs 的配套资产，放在 dev/ 下避免 Temp 丢失。
local calls = { commandv = {}, remove = {}, configs = {} }
local files = {}
_G.__calls = calls
_G.__files = files

local mp_stub = {
    get_time = function() return 123.5 end,
    get_property = function(k) if k == "platform" then return "windows" end return nil end,
    set_property = function() end,
    set_property_bool = function() end,
    set_property_number = function() end,
    get_property_bool = function() return true end,
    get_property_number = function() return 1 end,
    osd_message = function() end,
    commandv = function(...)
        local args = {...}
        calls.commandv[#calls.commandv + 1] = args
    end,
    command_native = function(t)
        if type(t) == "table" and t.name == "subprocess" then
            return { status = 0 }
        end
        return "/tmp/watchparty.json"
    end,
    command_native_async = function(t, cb)
        local args = t.args
        local url = args[#args]
        local method = "GET"
        for i = 1, #args - 1 do
            if args[i] == "-X" then method = args[i + 1] end
            if args[i] == "--config" then
                calls.configs[#calls.configs + 1] = { path = args[i + 1], content = files[args[i + 1]] }
            end
        end
        local body = ""
        if url:find("/media/subtitles", 1, true) then
            body = _G.__test_subtitles or "[]"
        elseif url:find("/media/subtitle", 1, true) then
            local mediaId = url:match("mediaId=([^&]+)")
            body = (_G.__test_sub_content or {})[mediaId] or ""
            if body == "" then
                cb(true, { status = 0, stdout = "\n404" }, nil)
                return
            end
        end
        cb(true, { status = 0, stdout = body .. "\n200" }, nil)
    end,
    add_timeout = function() return { kill = function() end } end,
    add_periodic_timer = function() return { kill = function() end } end,
    add_key_binding = function() end,
    register_script_message = function() end,
    register_event = function(_, name, fn)
        if name == "shutdown" then _G.__shutdown_handler = fn end
    end,
    add_hook = function() end,
    observe_property = function() end,
    msg = { debug = function() end, warn = function() end, error = function() end, info = function() end },
}
package.preload["mp"] = function() return mp_stub end
package.preload["mp.msg"] = function() return mp_stub.msg end
package.preload["mp.options"] = function() return { read_options = function(t) end } end
package.preload["mp.utils"] = function() return {} end

-- 内存文件系统（fengari 无 io.open）
io.open = function(path, mode)
    if mode and mode:find("w") then
        files[path] = ""
        local handle
        handle = {
            write = function(_, ...)
                local parts = { ... }
                for _, s in ipairs(parts) do files[path] = files[path] .. tostring(s) end
                return handle
            end,
            close = function() return true end,
        }
        return handle
    end
    if files[path] then
        local content = files[path]
        return {
            read = function(_, fmt)
                if fmt == "*a" then return content end
                return content
            end,
            close = function() return true end,
        }
    end
    return nil
end

-- 真实删除语义：从内存表中移除，并记录
os.remove = function(path)
    calls.remove[#calls.remove + 1] = path
    files[path] = nil
    return true
end
