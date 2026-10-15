#!/usr/bin/python3
"""SQLite online-backup API, integrity check, then an encrypted private S3 object.

No database rows, identity salts, session credentials, or chat messages are logged.
The archive includes the identity salt so recovery keeps network pseudonyms stable.
"""
import datetime
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile


def main():
    database = Path(os.environ['BOLTS_DB'])
    if not database.exists():
        return
    bucket = os.environ['BOLTS_BACKUP_BUCKET']
    prefix = os.environ['BOLTS_BACKUP_PREFIX'].strip('/')
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    with tempfile.TemporaryDirectory(prefix='backup-', dir='/var/lib/bolts-backup') as folder:
        work = Path(folder)
        snapshot = work / 'bolts.sqlite'
        # Reading the main file or copying WAL files would not be a consistent backup.
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=30)) as source:
            with closing(sqlite3.connect(snapshot, timeout=30)) as target:
                source.backup(target, pages=128, sleep=0.05)
                if target.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise RuntimeError('SQLite backup integrity check failed')
        # Closing the target checkpoints any copied WAL state before archiving
        # its main file; sqlite3's connection context manager alone does not close.
        metadata = work / 'restore.json'
        metadata.write_text(json.dumps({
            'format': 1,
            'createdAt': timestamp,
            'identitySalt': os.environ['BOLTS_IDENTITY_SALT'],
            'database': 'bolts.sqlite',
        }) + '\n')
        archive = work / 'backup.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            tar.add(snapshot, arcname='bolts.sqlite')
            tar.add(metadata, arcname='restore.json')
        env = os.environ.copy()
        env.pop('BOLTS_IDENTITY_SALT', None)
        subprocess.run([
            'aws', 's3', 'cp', str(archive), f's3://{bucket}/{prefix}/{timestamp}.tar.gz',
            '--sse', 'AES256', '--only-show-errors',
        ], check=True, env=env)
    print('Bolts database backup completed.')


if __name__ == '__main__':
    main()
