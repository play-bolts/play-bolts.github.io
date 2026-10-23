"""Run an isolated, low-priority capacity benchmark on the existing idle VM.
No release switch, production database access, listener, or provisioning.
Verify account, CloudFormation destination and bucket privacy before staging.
"""
import hashlib, importlib.util, json, subprocess, tarfile, time
from pathlib import Path
spec=importlib.util.spec_from_file_location('aws_command',Path(__file__).with_name('aws-command.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
out=Path('temp/lobby-capacity');out.mkdir(parents=True,exist_ok=True)
bucket='bolts-backend-storagebucket-knjq5mfjcxi7';instance='i-0bd1adb3fc8b01688';account='780705957578'
def aws(*args):
 return json.loads(subprocess.check_output(['aws',*args,'--region','us-west-2','--output','json'],env=module.aws_env()))
assert aws('sts','get-caller-identity')['Account']==account
stack=aws('cloudformation','describe-stacks','--stack-name','bolts-backend')['Stacks'][0]
outputs={r['OutputKey']:r['OutputValue'] for r in stack['Outputs']}
assert outputs['StorageBucket']==bucket and outputs['InstanceId']==instance
assert all(aws('s3api','get-public-access-block','--bucket',bucket,'--expected-bucket-owner',account)['PublicAccessBlockConfiguration'].values())
assert not aws('s3api','get-bucket-policy-status','--bucket',bucket,'--expected-bucket-owner',account)['PolicyStatus']['IsPublic']
archive=out/'source.tar.gz'
with tarfile.open(archive,'w:gz') as tar:
 for item in ['server/Cargo.toml','server/Cargo.lock','server/schema.sql','server/src','src/generated/hitboxData.json','src/generated/handCollisionData.json','scripts/benchmark-lobby-capacity.rs']:
  tar.add(item,arcname=item)
digest=hashlib.sha256(archive.read_bytes()).hexdigest();key=f'releases/benchmark-lobby-capacity-{digest}.tar.gz'
aws('s3api','put-object','--bucket',bucket,'--expected-bucket-owner',account,'--key',key,'--body',str(archive))
remote=f'/var/tmp/bolts-lobby-capacity-{digest[:12]}'
script=f'''set -euo pipefail
python3 - <<'CHECK'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:8080/api/lobbies',timeout=5) as r: data=json.load(r)
assert data['lobbies'] and all(r['players']==0 for r in data['lobbies']), 'live players present'
CHECK
install -d -o bolts-build -g bolts-build {remote}
aws s3 cp s3://{bucket}/{key} {remote}/source.tar.gz --region us-west-2 --only-show-errors
echo '{digest}  {remote}/source.tar.gz' | sha256sum -c -
tar -xzf {remote}/source.tar.gz -C {remote}
chown -R bolts-build:bolts-build {remote}
cat > {remote}/run.sh <<'BENCH'
#!/bin/bash
set -euo pipefail
cd {remote}
export PATH=/opt/bolts-build/.cargo/bin:$PATH
export CARGO_HOME=/opt/bolts-build/.cargo
export RUSTUP_HOME=/opt/bolts-build/.rustup
export BENCH_CLOCK_TICKS=$(getconf CLK_TCK)
export BENCH_OCCUPANCY_URL=http://127.0.0.1:8080/api/lobbies
cargo build --locked --release --jobs 1 --manifest-path server/Cargo.toml --example lobby-capacity > build.log 2>&1
for rooms in 1 4 8 16 29; do
 for mode in humans bots; do
  server/target/release/examples/lobby-capacity "$rooms" "$mode" 20 | tee -a results.jsonl
 done
done
BENCH
chown bolts-build:bolts-build {remote}/run.sh
systemd-run --quiet --wait --pipe --collect --unit=bolts-capacity-{digest[:12]} -p User=bolts-build -p Nice=15 -p CPUQuota=60% -p MemoryMax=700M -p IOSchedulingClass=idle -p RuntimeMaxSec=1800 /bin/bash {remote}/run.sh
'''
sent=aws('ssm','send-command','--instance-ids',instance,'--document-name','AWS-RunShellScript','--timeout-seconds','1800','--parameters',json.dumps({'commands':[script],'executionTimeout':['1800']}),'--comment','Isolated lobby capacity benchmark; no production changes')
command=sent['Command']['CommandId'];(out/'benchmark-command.json').write_text(json.dumps({'id':command,'remote':remote,'sourceSha256':digest,'key':key},indent=2));print(json.dumps({'command':command,'remote':remote}),flush=True)
for i in range(360):
 time.sleep(5)
 result=aws('ssm','get-command-invocation','--command-id',command,'--instance-id',instance)
 if result['Status'] not in ('Pending','InProgress','Delayed'):
  (out/'benchmark-result.json').write_text(json.dumps(result,indent=2))
  print(result['StandardOutputContent']);print(result['StandardErrorContent']);
  if result['Status']!='Success': raise SystemExit(result['Status'])
  aws('s3api','delete-object','--bucket',bucket,'--expected-bucket-owner',account,'--key',key)
  break
 if i%12==0:print('Benchmark job in progress',flush=True)
