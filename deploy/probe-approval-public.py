"""Report only status and content type for the public approval route."""
import base64
import json
import pathlib
import urllib.error
import urllib.request

root = pathlib.Path('/opt/watchparty-deployment-20261001')
operator = json.loads((root / 'vps-config-20261001/operator-input.json').read_text())
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
result = []
for origin in ('http://127.0.0.1:18000', 'https://watchparty.nirotiy.top'):
    for path, method in [('/api/catalog-approval/settings', 'GET'), ('/api/catalog-approval/libraries/deployment_missing_library/approval', 'POST')]:
        auth = operator['approvalUsername'] + ':' + operator['approvalPassword']
        headers = {'Authorization': 'Basic ' + base64.b64encode(auth.encode()).decode(), 'Origin': 'https://watchparty.nirotiy.top', 'Content-Type': 'application/json', 'User-Agent': 'WatchParty-VPS-Validation/1.0'}
        request = urllib.request.Request(origin + path, method=method, headers=headers, data=b'{}' if method == 'POST' else None)
        try:
            response = client.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            payload = response.read()
            content_type = response.headers.get_content_type()
            value = json.loads(payload) if content_type == 'application/json' else {}
            plain_code = payload.decode(errors='replace').strip() if payload.startswith(b'error code:') and len(payload) < 40 else None
            result.append({'origin': origin, 'method': method, 'route': path, 'status': response.status, 'contentType': content_type, 'code': value.get('code'), 'edgeCode': plain_code, 'server': response.headers.get('Server'), 'cloudflareChallenge': response.headers.get('cf-mitigated') == 'challenge', 'rayPresent': bool(response.headers.get('CF-Ray'))})
print(json.dumps(result))
