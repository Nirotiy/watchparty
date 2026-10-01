"""Exercise a temporary library only; keep migrated libraries untouched."""
import base64
import concurrent.futures
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

root = pathlib.Path('/opt/watchparty-deployment-20261001')
operator = json.loads((root / 'vps-config-20261001/operator-input.json').read_text())
openlist = json.loads((root / 'openlist-credentials.json').read_text())
image = 'ghcr.io/nirotiy/watchparty-backend@sha256:7a56597bc5d0fb9a12ccf03df7048892d8bbc3c18bdebb5fbd37f9c0b18f9b1d'
checks = {}
observations = {}
source_id = None
library_id = None
completed = False
before = None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def call(path, method='GET', body=None, approval=False):
    origin = os.environ.get('WATCHPARTY_APPROVAL_ORIGIN', 'http://127.0.0.1:18000') if approval else 'http://127.0.0.1:18080'
    if origin not in ('http://127.0.0.1:18080', 'http://127.0.0.1:18000', 'https://watchparty.nirotiy.top'):
        raise RuntimeError('Unexpected approval origin')
    headers = {'Content-Type': 'application/json', 'User-Agent': 'WatchParty-VPS-Validation/1.0'}
    if approval:
        identity = operator['approvalUsername'] + ':' + operator['approvalPassword']
        headers['Authorization'] = 'Basic ' + base64.b64encode(identity.encode()).decode()
        headers['Origin'] = 'https://watchparty.nirotiy.top'
    request = urllib.request.Request(origin + path, method=method, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        response = client.open(request, timeout=45)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        payload = response.read()
        return response.status, json.loads(payload) if payload and response.headers.get_content_type() == 'application/json' else {'nonJsonStatus': response.status}


def check(name, condition):
    checks[name] = bool(condition)
    print(json.dumps({'check': name, 'passed': bool(condition)}), flush=True)
    if not condition:
        raise RuntimeError(name)


def baseline():
    with sqlite3.connect(f"file:{root / 'data/watchparty-catalog.sqlite'}?mode=ro", uri=True) as db:
        return {
            'cards': db.execute("SELECT id, library_id, title, status FROM catalog_items WHERE library_id IN ('lib_anime','lib_film','lib_tv') ORDER BY id").fetchall(),
            'children': db.execute("SELECT * FROM catalog_children WHERE item_id IN (SELECT id FROM catalog_items WHERE library_id IN ('lib_anime','lib_film','lib_tv')) ORDER BY item_id, sort_index").fetchall(),
            'ledger': db.execute("SELECT count(*) FROM catalog_approvals WHERE library_id IN ('lib_anime','lib_film','lib_tv')").fetchone()[0],
        }


try:
    before = baseline()
    status, source = call('/api/admin/media-sources', 'POST', {**openlist, 'name': 'VPS isolated acceptance', 'internalBaseUrl': 'http://127.0.0.1:5244', 'publicBaseUrl': 'https://watchparty.nirotiy.top', 'libraries': [{'name': 'VPS temporary Anime', 'kind': 'anime', 'path': '/media/openlist-bdyun/Multimedia/Anime'}]})
    check('temporarySourceCreated', status == 201)
    source_id = source['id']
    library_id = source['libraries'][0]['id']
    prefix = '/api/admin/media-libraries/' + library_id
    _, pre_scan = call(prefix + '/scan')
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(call, prefix + '/scan', 'POST', {}) for _ in range(2)]
        scans = [future.result() for future in futures]
    observations['postScanStatuses'] = [status for status, _ in scans]
    check('scanPostContract', all(status in (200, 202) for status, _ in scans))
    accepted = [value for status, value in scans if status == 202]
    observations['natural202Observed'] = bool(accepted)
    if accepted:
        check('acceptedHasNoResult', all(set(value) == {'status', 'libraryId', 'running'} and value['running'] is True for value in accepted))
    deadline = time.monotonic() + 360
    while time.monotonic() < deadline:
        _, scan = call(prefix + '/scan')
        if scan['running'] is False:
            break
        time.sleep(2)
    check('scanFinishedWithNewRevision', scan['running'] is False and scan['rev'] > pre_scan['rev'] and scan['files'] > 0)
    check('concurrentScanCoalesced', scan['rev'] == pre_scan['rev'] + 1)
    observations['files'] = scan['files']
    _, pre_classify = call(prefix + '/classify')
    status, result = call(prefix + '/classify', 'POST', {})
    check('classifyPostContract', status in (200, 202))
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        _, draft = call(prefix + '/classify')
        if draft['running'] is False:
            break
        time.sleep(1)
    check('classificationChangedFromBaseline', draft['running'] is False and draft['classifiedAt'] != pre_classify['classifiedAt'] and draft['cards'] > 0)
    check('realStructuralDiff', len(draft['diff']['added']) > 0)
    status, refused = call(prefix + '/approval', 'POST', {})
    check('noHeaderApprovalDenied', status == 401 and refused.get('code') == 'CATALOG_APPROVAL_SECRET_REQUIRED')
    # An independent MCP container has no backend env_file or inherited approval secret.
    command = ['docker', 'run', '--rm', '-i', '--network', 'host', '-e', 'WATCHPARTY_API_BASE=http://127.0.0.1:18080', '--entrypoint', 'node', image]
    clean = subprocess.run(command + ['-e', "console.log(JSON.stringify({secretAbsent:!process.env.WATCHPARTY_CATALOG_APPROVAL_SECRET}))"], check=True, capture_output=True, text=True)
    check('mcpEnvironmentHasNoSecret', json.loads(clean.stdout)['secretAbsent'])
    messages = [
        {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'},
        {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'import_apply_metadata', 'arguments': {'libraryId': library_id, 'force': True}}},
        {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'import_apply_approved', 'arguments': {'libraryId': library_id, 'approvalToken': 'not-a-human-approval', 'force': True}}},
        {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'catalog_approve', 'arguments': {'libraryId': library_id}}},
    ]
    mcp = subprocess.run(command + ['server/mcp/catalog-mcp.ts'], input='\n'.join(json.dumps(message) for message in messages) + '\n', capture_output=True, text=True, timeout=45, check=True)
    replies = {value['id']: value for value in (json.loads(line) for line in mcp.stdout.splitlines() if line.startswith('{')) if 'id' in value}
    check('mcpCannotMintApproval', replies[4].get('error', {}).get('code') == -32602)
    check('mcpMetadataCannotApplyStructure', replies[2]['result']['isError'] and 'CATALOG_APPROVAL_REQUIRED' in json.dumps(replies[2]))
    check('mcpFakeApprovalRejected', replies[3]['result']['isError'] and 'CATALOG_APPROVAL_INVALID' in json.dumps(replies[3]))
    path = '/api/catalog-approval/libraries/' + library_id + '/approval'
    status, approved = call(path, 'POST', {}, approval=True)
    check('humanRouteApprovesRealDiff', status == 200 and bool(approved.get('approvalToken')))
    status, applied = call(prefix + '/apply-approved', 'POST', {'approvalToken': approved['approvalToken'], 'force': True})
    check('approvedStructureApplied', status == 200 and applied['created'] > 0 and applied['rollbackAvailable'] is True)
    status, rollback = call(path, 'POST', {'rollbackOf': approved['approvalId']}, approval=True)
    check('humanRouteApprovesRollback', status == 200 and bool(rollback.get('approvalToken')))
    status, restored = call(prefix + '/rollback', 'POST', {'rollbackOf': approved['approvalId'], 'approvalToken': rollback['approvalToken']})
    check('approvedRollback', status == 200 and restored['removed'] == applied['created'])
    completed = True
except Exception as error:
    observations['failureType'] = type(error).__name__
finally:
    if source_id:
        checks['temporarySourceCleanup'] = call('/api/admin/media-sources/' + source_id, 'DELETE')[0] == 204
    checks['migratedCatalogUnchanged'] = before is not None and baseline() == before
    report = {'checks': checks, 'observations': observations, 'completed': completed, 'passed': completed and all(checks.values()), 'approvalOrigin': os.environ.get('WATCHPARTY_APPROVAL_ORIGIN', 'http://127.0.0.1:18000'), 'scope': 'temporary library in deployment copy; OpenList read-only; no metadata judging; migrated catalog untouched'}
    (root / ('validation-catalog-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '.json')).write_text(json.dumps(report, indent=2) + '\n')
    (root / 'validation-catalog.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
    sys.exit(0 if report['passed'] else 1)
