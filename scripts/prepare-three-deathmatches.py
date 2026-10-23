#!/usr/bin/env python3
"""Freeze only the lobby change on top of the verified currently deployed source."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PARENT = ROOT / 'temp/todo-deploy/source'
STATE = ROOT / 'temp/todo-deploy/release-state/release.json'
OUT = ROOT / 'temp/three-deathmatches'
SOURCE = OUT / 'source'
EXPECTED = '5bdd59c9933ede00c4af61db2199153c8d5949f9fd5a6308f1999530d45aab3a'

if __name__ == '__main__':
    if SOURCE.exists():
        raise SystemExit('Preserve the existing source snapshot; refusing to overwrite it.')
    prior = json.loads(STATE.read_text())
    assert prior['release'] == EXPECTED
    for name, sha in prior['sourceFiles'].items():
        assert hashlib.sha256((PARENT / name).read_bytes()).hexdigest() == sha, name
    # Only repository files and recorded build inputs may enter this snapshot.
    names = set(subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', '2e132d6'], cwd=ROOT, text=True).splitlines())
    names.update(prior['sourceFiles'])
    for name in sorted(names):
        if ((name.startswith('server/src/') and name.endswith('.rs')) or
                (name.startswith('server/gamelift/') and name.endswith('.go'))) and name not in prior['sourceFiles']:
            continue  # Preserve the exact deployed compile/test input inventory.
        original, target = PARENT / name, SOURCE / name
        if original.is_symlink():
            raise SystemExit('Invalid baseline source: ' + name)
        target.parent.mkdir(parents=True, exist_ok=True)
        if original.is_file():
            shutil.copyfile(original, target)
        else:
            # Old one-off scripts can be absent from a release snapshot. They
            # are not build inputs; recover only their tracked repository bytes.
            assert name not in prior['sourceFiles'], name
            target.write_bytes(subprocess.check_output(['git', 'show', '2e132d6:' + name], cwd=ROOT))
    changed = ['server/src/hub.rs', 'server/src/hub_tests.rs']
    for name in changed:
        shutil.copyfile(ROOT / name, SOURCE / name)
    # Keep the deployed gateway's other behavior and update only its inventory test.
    name = 'server/gamelift/hybrid_test.go'
    marker = 'func TestRealRustOregonAdmissionAndProbeThroughDirectory('
    def test_function(text):
        start = text.index(marker)
        end = text.find('\nfunc ', start + len(marker))
        return text[start:end if end >= 0 else len(text)]
    old = subprocess.check_output(['git', 'show', '2e132d6:' + name], cwd=ROOT, text=True)
    baseline = (SOURCE / name).read_text()
    assert test_function(old) in baseline
    (SOURCE / name).write_text(baseline.replace(test_function(old), test_function((ROOT / name).read_text()), 1))
    changed.append(name)
    (OUT / 'source-snapshot.json').write_text(json.dumps({
        'parentRelease': EXPECTED,
        'parentSourceFiles': prior['sourceFiles'],
        'changedFiles': {name: hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() for name in changed},
    }, indent=2) + '\n')
    print('Frozen three-Deathmatch release source in ' + str(SOURCE))
