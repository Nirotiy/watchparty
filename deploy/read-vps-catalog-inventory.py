"""Read the deployed backend's media IDs without loading its private environment."""
import json
import pathlib
import sys
import urllib.parse
import urllib.request

output = pathlib.Path(sys.argv[1]).resolve()
if output.parent != pathlib.Path('/opt/watchparty-offline-20261001'):
    raise RuntimeError('Independent inventory path required')
client = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get(route, query=None):
    url = 'http://127.0.0.1:18080' + route
    if query:
        url += '?' + urllib.parse.urlencode(query)
    with client.open(url, timeout=45) as response:
        return json.load(response)


libraries = get('/api/media/libraries')['libraries']
result = []
extensions = {'.mkv', '.mp4', '.webm', '.mov', '.m4v', '.avi', '.ts', '.m2ts', '.wmv', '.flv', '.strm'}
for library in libraries:
    pending = ['/']
    seen = set()
    files = []
    while pending:
        folder = pending.pop()
        if folder in seen or len(pathlib.PurePosixPath(folder).parts) - 1 > 4:
            continue
        seen.add(folder)
        cursor = None
        while True:
            query = {'libraryId': library['id'], 'path': folder}
            if cursor:
                query['cursor'] = cursor
            page = get('/api/media/list', query)
            for item in page['items']:
                if item['type'] == 'dir':
                    pending.append(item['relativePath'])
                elif pathlib.PurePosixPath(item['name']).suffix.lower() in extensions:
                    files.append({'relativePath': item['relativePath'], 'name': item['name'], 'size': item.get('size'), 'mediaId': item['id']})
            cursor = page.get('nextCursor') if page['hasMore'] else None
            if not cursor:
                break
    result.append({'libraryId': library['id'], 'files': files})
output.write_text(json.dumps({'libraries': result}, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'libraries': [{'id': library['libraryId'], 'files': len(library['files'])} for library in result]}))
