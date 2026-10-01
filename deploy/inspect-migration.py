"""Read migration facts and probe OpenList without printing source credentials."""
import json
import pathlib
import sqlite3
import sys
import urllib.error
import urllib.request

root = pathlib.Path(sys.argv[1]).resolve()
library = sqlite3.connect(f"file:{root / 'data/watchparty-library.sqlite'}?mode=ro", uri=True)
catalog = sqlite3.connect(f"file:{root / 'data/watchparty-catalog.sqlite'}?mode=ro", uri=True)
print(json.dumps({"libraryIntegrity": library.execute("PRAGMA integrity_check").fetchone()[0], "catalogIntegrity": catalog.execute("PRAGMA integrity_check").fetchone()[0], "sources": library.execute("SELECT count(*) FROM media_sources").fetchone()[0], "libraries": library.execute("SELECT id, kind FROM media_libraries").fetchall()}))
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for source_id, username, password in library.execute("SELECT id, username, password FROM media_sources"):
    request = urllib.request.Request("http://127.0.0.1:5244/api/auth/login", data=json.dumps({"username": username, "password": password}).encode(), headers={"Content-Type": "application/json"})
    try:
        with opener.open(request, timeout=15) as response:
            value = json.load(response)
        print(json.dumps({"sourceId": source_id, "openlistLoginCode": value.get("code")}))
    except (urllib.error.URLError, ValueError):
        print(json.dumps({"sourceId": source_id, "openlistLoginCode": "unavailable"}))
library.close()
catalog.close()
