#!/usr/bin/env python3
"""Freeze this release separately from concurrent gameplay edits in the workspace."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp/abuse-protection'
SOURCE = OUT / 'source'
BASE = '07a97f4'
FILES = [
    'server/src/app.rs', 'server/src/hub.rs', 'server/src/lib.rs',
    'server/src/limits.rs', 'server/src/hub_tests.rs', 'server/src/connection_limit_tests.rs',
    'server/gamelift/directory.go', 'server/gamelift/game.go',
    'server/gamelift/limits.go', 'server/gamelift/limits_test.go',
    'scripts/test-abuse-backend.ts',
]

if __name__ == '__main__':
    if SOURCE.exists():
        raise SystemExit('Preserve the existing release snapshot; refusing to overwrite it.')
    OUT.mkdir(parents=True, exist_ok=True)
    base = subprocess.check_output(['git', 'rev-parse', BASE], cwd=ROOT, text=True).strip()
    archive = OUT / 'source-base.tar'
    subprocess.run(['git', 'archive', '--format=tar', '--output', str(archive), base], cwd=ROOT, check=True)
    SOURCE.mkdir()
    # git archive provides only the pinned, trusted repository tree.
    subprocess.run(['tar', '-xf', str(archive), '-C', str(SOURCE)], check=True)
    archive.unlink()
    hashes = {}
    for name in FILES:
        source = ROOT / name
        if source.is_symlink() or not source.is_file():
            raise SystemExit('Invalid release input: ' + name)
        shutil.copyfile(source, SOURCE / name)
        hashes[name] = hashlib.sha256((SOURCE / name).read_bytes()).hexdigest()
    (OUT / 'source-snapshot.json').write_text(json.dumps({'baseCommit': base, 'overlaidFiles': hashes}, indent=2) + '\n')
    print('Frozen reviewed release source in ' + str(SOURCE))
