local json = _G.__json
local raw = '{"revision":3,"source":{"kind":"openlist","mediaId":"abc","title":"Title A&B"},'
  .. '"positionSeconds":12.5,"serverTimeMs":1700000000000,"paused":false,"playbackRate":1.5,'
  .. '"loop":false,"locked":true,"ownerClientId":"x","playlist":[{"id":"i1","media":{"kind":"http","url":"https://a/b?p=1&q=2"},"addedByClientId":"o","addedAtMs":1}]}'
local v = json.parse(raw)
assert(v.revision == 3, 'revision')
assert(v.source.title == 'Title A&B', 'title: ' .. tostring(v.source.title))
assert(v.source.kind == 'openlist')
assert(v.playlist[1].media.url == 'https://a/b?p=1&q=2', 'url: ' .. tostring(v.playlist[1].media.url))
assert(v.playbackRate == 1.5, 'rate')
assert(json.parse('null') == json.null, 'null sentinel')
assert(json.parse('"\\u4e2d\\u6587"') == '\228\184\173\230\150\135', 'unicode: ' .. tostring(json.parse('"\\u4e2d\\u6587"')))
assert(json.parse('"\\ud83d\\ude00"') == '\240\159\152\128', 'surrogate pair')
local roundtrip = json.parse(json.stringify({ticket = 'abc_ABC-123'}))
assert(roundtrip.ticket == 'abc_ABC-123', 'roundtrip')
assert(json.stringify('a"b\\c') == '"a\\"b\\\\c"', 'escape: ' .. json.stringify('a"b\\c'))
assert(_G.__b64('user:pass') == 'dXNlcjpwYXNz', 'b64: ' .. _G.__b64('user:pass'))
assert(_G.__media_key({kind = 'openlist', mediaId = 'm1'}) == 'openlist:m1', 'mediakey')
assert(_G.__media_key({kind = 'youtube', videoId = 'v1'}) == 'youtube:v1', 'mediakey yt')
assert(_G.__media_key(nil) == nil, 'mediakey nil')
print('JSON/BASE64/MEDIAKEY TESTS PASS')
