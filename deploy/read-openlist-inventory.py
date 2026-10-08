"""Read VPS OpenList listings only; write sanitized inventory to an operator-owned file."""
import json
import pathlib
import sqlite3
import sys
import urllib.request

root = pathlib.Path('/opt/watchparty-deployment-20261001')
output = pathlib.Path(sys.argv[1]).resolve()
if not str(output).startswith('/opt/watchparty-offline-'):
    raise RuntimeError('Unexpected output path')
output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
client = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(route, body, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = token
    request = urllib.request.Request('http://127.0.0.1:5244' + route, headers=headers, data=json.dumps(body).encode())
    with client.open(request, timeout=45) as response:
        value = json.load(response)
    if value.get('code') != 200:
        raise RuntimeError('OpenList request refused')
    return value['data']


private = root / 'openlist-credentials.json'
token = call('/api/auth/login', json.loads(private.read_text()))['token']
with sqlite3.connect(f"file:{root / 'data/watchparty-library.sqlite'}?mode=ro", uri=True) as database:
    libraries = database.execute('SELECT id,name,kind,absolute_path FROM media_libraries ORDER BY id').fetchall()
result = []
for identifier, name, kind, absolute in libraries:
    pending = [absolute]
    files = []
    while pending:
        folder = pending.pop()
        if len(pathlib.PurePosixPath(folder).relative_to(absolute).parts) > 4:
            continue
        page = 1
        while True:
            listing = call('/api/fs/list', {'path': folder, 'password': '', 'page': page, 'per_page': 200, 'refresh': False}, token)
            entries = listing.get('content') or []
            for entry in entries:
                item_path = folder.rstrip('/') + '/' + entry['name']
                if entry['is_dir']:
                    pending.append(item_path)
                elif pathlib.PurePosixPath(entry['name']).suffix.lower() in ('.mkv', '.mp4', '.webm', '.mov', '.m4v', '.avi', '.ts', '.m2ts', '.wmv', '.flv', '.strm'):
                    files.append({'relativePath': '/' + item_path[len(absolute):].lstrip('/'), 'name': entry['name'], 'size': entry.get('size')})
            if len(entries) < 200 or page * 200 >= listing.get('total', 0):
                break
            page += 1
    result.append({'libraryId': identifier, 'name': name, 'kind': kind, 'files': files})
output.write_text(json.dumps({'libraries': result}, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'libraries': [{'id': item['libraryId'], 'files': len(item['files'])} for item in result], 'credentialsLogged': False}))
