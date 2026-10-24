#!/usr/bin/env python3
"""Build only committed Rust inputs for Linux; preserve the live gateway bytes."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
GATEWAY_SHA = 'a31436c29f1772d763e9ad970a2197228651a84b5162cae03eed662d80a217da'
PRIOR_RELEASE = '7fa4e4ab209ad103978eaafcba709eee56a3127d5f95a17f7d89bccdc53dd226'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--gateway', type=Path, default=ROOT/'temp/three-deathmatches/source/artifacts/gamelift/bundle/bolts-host')
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    gateway = args.gateway.read_bytes()
    if sha(gateway) != GATEWAY_SHA:
        raise SystemExit('Preserved gateway does not match inspected production binary')
    build = source/'artifacts/gamelift'
    context = build/'telemetry-context'
    if context.exists():
        raise SystemExit('Preserve existing build context; use a new isolated source folder')
    paths = [source/name for name in ['server/Cargo.toml','server/Cargo.lock','server/schema.sql',
             'src/generated/hitboxData.json','src/generated/handCollisionData.json',
             'shared/actor-fields.json','shared/features.json','infra/gamelift/Dockerfile',
             'scripts/benchmark-lobby-capacity.rs']]
    paths += sorted((source/'server/src').glob('*.rs'))
    source_hashes = {}
    for path in paths:
        name = str(path.relative_to(source))
        if not path.is_file() or path.is_symlink():
            raise SystemExit('Invalid positive build input: '+name)
        data = path.read_bytes()
        committed = subprocess.run(['git','show',args.commit+':'+name],cwd=ROOT,
                                   capture_output=True,check=True).stdout
        if data != committed:
            raise SystemExit('Build input differs from selected commit: '+name)
        target = context/name
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(data)
        source_hashes[name] = sha(data)
    original = (source/'infra/gamelift/Dockerfile').read_text()
    rust_stage = original.split('FROM scratch AS release',1)[0]
    if 'FROM ' not in rust_stage or ' AS rust' not in rust_stage:
        raise SystemExit('Missing reviewed Rust container stage')
    dockerfile = context/'Telemetry.Dockerfile'
    dockerfile.write_text(rust_stage+'FROM scratch AS telemetry-release\nCOPY --from=rust /src/server/target/release/bolts-server /bolts-server\n')
    bundle = build/'bundle'
    bundle.mkdir(parents=True,exist_ok=True)
    command = ['docker','buildx','build','--platform','linux/amd64','--target','telemetry-release',
               '--output','type=local,dest='+str(bundle),'-f',str(dockerfile),str(context)]
    subprocess.run(command,check=True)
    shutil.copyfile(args.gateway,bundle/'bolts-host')
    (bundle/'bolts-host').chmod(0o755)
    files = {name:sha((bundle/name).read_bytes()) for name in ['bolts-host','bolts-server']}
    for name in files:
        data = (bundle/name).read_bytes()
        if data[:6] != b'\x7fELF\x02\x01' or data[18:20] != b'\x3e\x00':
            raise SystemExit('Expected native Linux x86_64 binary: '+name)
    if any(sha((source/name).read_bytes()) != digest for name,digest in source_hashes.items()):
        raise SystemExit('Source changed during build')
    provenance = {'commit':args.commit,'sourceFiles':source_hashes,'outputs':files,
                  'preservedGateway':{'release':PRIOR_RELEASE,'sha256':GATEWAY_SHA,'path':str(args.gateway.resolve())},
                  'derivedDockerfileSha256':sha(dockerfile.read_bytes()),'command':command}
    (build/'build-provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
    (build/'manifest.json').write_text(json.dumps(files,indent=2)+'\n')
    print(json.dumps({'commit':args.commit,'outputs':files,'gatewayPreserved':True}))


if __name__ == '__main__':
    main()
