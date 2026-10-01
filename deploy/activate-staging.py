"""Fix platform-specific paths in the deployment copy and pin verified images."""
import os
import pathlib
import sqlite3
import sys

root = pathlib.Path(sys.argv[1]).resolve()
if root != pathlib.Path("/opt/watchparty-deployment-20261001"):
    raise RuntimeError("Unexpected deployment-copy path")
images = {
    "WATCHPARTY_BACKEND_IMAGE": "ghcr.io/nirotiy/watchparty-backend@sha256:7a56597bc5d0fb9a12ccf03df7048892d8bbc3c18bdebb5fbd37f9c0b18f9b1d",
    "WATCHPARTY_FRONTEND_IMAGE": "ghcr.io/nirotiy/watchparty-frontend@sha256:6820ee398fc7f27792d9923a9bb6d92fbcd7806d529585ef0e9f023a9be45409",
}
environment = root / ".env"
lines = environment.read_text().splitlines()
lines = [line for line in lines if line.split("=", 1)[0] not in images]
environment.write_text("\n".join(lines + [key + "=" + value for key, value in images.items()]) + "\n")
os.chmod(environment, 0o600)

with sqlite3.connect(root / "data/watchparty-catalog.sqlite") as database:
    posters = database.execute("SELECT item_id, cache_path FROM poster_files").fetchall()
    replacements = []
    for item_id, old_path in posters:
        filename = pathlib.PureWindowsPath(old_path).name
        if not (root / "data/poster-cache" / filename).is_file():
            raise RuntimeError("A migrated poster is missing; refusing partial path conversion")
        replacements.append(("/app/data/poster-cache/" + filename, item_id))
    database.executemany("UPDATE poster_files SET cache_path = ? WHERE item_id = ?", replacements)
    if database.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise RuntimeError("Catalog integrity failed")
print(f"Pinned two images; validated {len(replacements)} migrated poster paths")
