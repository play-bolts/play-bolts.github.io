#!/usr/bin/env python3
"""Deploy the reviewed abuse-control build using the existing guarded installer.

Uses an isolated source/build snapshot, preserves disabled overseas hosting and
the dedicated local lobby layout, and refuses occupied or changed deployments.
Default prepares locally after read-only inspection; --apply installs.
"""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('dedicated_release', ROOT / 'scripts/deploy-dedicated-lobbies.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.OUT = ROOT / 'temp/abuse-protection/backend'
# Validate provenance against the immutable source snapshot, not concurrent work.
release.ROOT = ROOT / 'temp/abuse-protection/source'
release.BUILD = release.ROOT / 'artifacts/gamelift'
release.EXPECTED = '4e8df188f76a6f4a1892766536a62e6aea3c69f75c5ec2ef9701d8fc24e50223'

if __name__ == '__main__':
    # The reused helper loads its installer from the working repository. Refuse
    # a concurrent installer change instead of mixing it into the pinned build.
    installer = Path('infra/gamelift/install-directory.sh')
    if (ROOT / installer).read_bytes() != (release.ROOT / installer).read_bytes():
        raise SystemExit('Directory installer differs from the reviewed snapshot.')
    release.main()
