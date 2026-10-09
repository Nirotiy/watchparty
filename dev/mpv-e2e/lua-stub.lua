local mp_stub = {
  get_time = function() return 123.5 end,
  get_property = function(_, k) if k == 'platform' then return 'windows' end return nil end,
  set_property = function() end, set_property_bool = function() end,
  set_property_number = function() end, get_property_bool = function() return true end,
  get_property_number = function() return 1 end,
  osd_message = function() end, commandv = function() end,
  command_native = function(_, t) return '/tmp/watchparty.json' end,
  command_native_async = function(t, cb) cb(false, nil, 'stub') end,
  add_timeout = function() return { kill = function() end } end,
  add_periodic_timer = function() return { kill = function() end } end,
  add_key_binding = function() end, register_script_message = function() end,
  register_event = function() end, add_hook = function() end, observe_property = function() end,
  msg = { debug = function() end, warn = function() end, error = function() end },
}
package.preload['mp'] = function() return mp_stub end
package.preload['mp.msg'] = function() return mp_stub.msg end
package.preload['mp.options'] = function() return { read_options = function(t) end } end
package.preload['mp.utils'] = function() return {} end
