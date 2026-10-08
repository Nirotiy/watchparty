"""Snapshot the VPS catalog for offline conflict checks; never copy a live SQLite file."""
import json
import pathlib
import shutil
import sqlite3
import sys

source = pathlib.Path('/opt/watchparty-deployment-20261001/data')
destination = pathlib.Path(sys.argv[1]).resolve()
if destination.parent != pathlib.Path('/opt/watchparty-offline-20261001') or destination.exists():
    raise RuntimeError('A new independent snapshot directory is required')
destination.mkdir(mode=0o700)
database_path = destination / 'watchparty-catalog.sqlite'
with sqlite3.connect(f'file:{source / "watchparty-catalog.sqlite"}?mode=ro', uri=True) as database:
    database.execute('VACUUM INTO ?', (str(database_path),))
posters = destination / 'poster-cache'
posters.mkdir(mode=0o700)
with sqlite3.connect(database_path) as database:
    integrity = database.execute('PRAGMA integrity_check').fetchall()
    if integrity != [('ok',)]:
        raise RuntimeError('Snapshot integrity failed')
    for item_id, cache_path in database.execute('SELECT item_id,cache_path FROM poster_files').fetchall():
        cached = pathlib.Path(cache_path)
        if cached.parent == pathlib.Path('/app/data/poster-cache'):
            cached = source / 'poster-cache' / cached.name
        original = cached.resolve()
        if original.parent != (source / 'poster-cache').resolve() or original.is_symlink():
            raise RuntimeError('Unexpected poster path')
        copied = posters / original.name
        shutil.copyfile(original, copied)
        database.execute('UPDATE poster_files SET cache_path=? WHERE item_id=?', (str(copied), item_id))
    counts = {table: database.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
              for table in ['catalog_items', 'catalog_children', 'catalog_approvals', 'catalog_scan']}
(destination / 'MANIFEST.txt').write_text(json.dumps({'integrity': 'ok', 'counts': counts, 'productionWritten': False}, indent=2) + '\n')
print(json.dumps({'integrity': 'ok', 'counts': counts, 'productionWritten': False}))
