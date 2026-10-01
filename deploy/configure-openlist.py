"""Validate VPS OpenList and update only the staged source through its admin API."""
import json
import os
import pathlib
import sqlite3
import sys
import urllib.error
import urllib.request

root = pathlib.Path(sys.argv[1]).resolve()
if root != pathlib.Path("/opt/watchparty-deployment-20261001"):
    raise RuntimeError("Unexpected deployment-copy path")
credentials_file = root / "openlist-credentials.json"
os.chmod(credentials_file, 0o600)
credentials = json.loads(credentials_file.read_text())
if set(credentials) != {"username", "password"} or any(not isinstance(value, str) or not value or value != value.strip() or "\n" in value or "\r" in value for value in credentials.values()):
    raise RuntimeError("Credentials must contain nonempty single-line username and password")
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(url, body, method="POST", token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method=method)
    try:
        with opener.open(request, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


status, login = call("http://127.0.0.1:5244/api/auth/login", credentials)
if status != 200 or login.get("code") != 200 or not isinstance(login.get("data", {}).get("token"), str):
    print(json.dumps({"openlistLogin": False, "httpStatus": status, "code": login.get("code")}))
    sys.exit(1)
token = login["data"]["token"]
with sqlite3.connect(f"file:{root / 'data/watchparty-library.sqlite'}?mode=ro", uri=True) as database:
    sources = database.execute("SELECT id FROM media_sources ORDER BY id").fetchall()
    before = database.execute("SELECT id, source_id, absolute_path FROM media_libraries ORDER BY id").fetchall()
if len(sources) != 1:
    raise RuntimeError("Multiple sources require explicit per-source credentials")
probes = []
for library_id, source_id, path in before:
    status, value = call("http://127.0.0.1:5244/api/fs/list", {"path": path, "password": "", "page": 1, "per_page": 1, "refresh": False}, token=token)
    probes.append({"libraryId": library_id, "path": path, "httpStatus": status, "code": value.get("code")})
print(json.dumps({"openlistLogin": True, "roots": probes}))
if any(probe["httpStatus"] != 200 or probe["code"] != 200 for probe in probes):
    sys.exit(1)
patch = {**credentials, "internalBaseUrl": "http://127.0.0.1:5244", "publicBaseUrl": "https://watchparty.nirotiy.top"}
status, value = call("http://127.0.0.1:18080/api/admin/media-sources/" + sources[0][0], patch, "PATCH")
if status != 200:
    print(json.dumps({"sourceUpdate": False, "httpStatus": status, "code": value.get("code")}))
    sys.exit(1)
with sqlite3.connect(f"file:{root / 'data/watchparty-library.sqlite'}?mode=ro", uri=True) as database:
    after = database.execute("SELECT id, source_id, absolute_path FROM media_libraries ORDER BY id").fetchall()
if before != after:
    raise RuntimeError("Source update changed library identities or paths")
environment = root / "backend.env"
values = {"OPENLIST_USERNAME": credentials["username"], "OPENLIST_PASSWORD": credentials["password"]}
lines = [line for line in environment.read_text().splitlines() if line.split("=", 1)[0] not in values]
temporary = root / "backend.env.openlist.tmp"
temporary.write_text("\n".join(lines + [key + "=" + value for key, value in values.items()]) + "\n")
os.chmod(temporary, 0o600)
temporary.replace(environment)
print(json.dumps({"sourceUpdate": True, "libraryIdsPreserved": True, "backendEnvironmentUpdated": True, "valuesLogged": False}))
