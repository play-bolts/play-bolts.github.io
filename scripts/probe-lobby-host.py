"""Read-only EC2/SSM capacity inventory; evidence lives under temp/."""
import importlib.util, json, subprocess, time
from pathlib import Path
spec=importlib.util.spec_from_file_location('aws_command',Path(__file__).with_name('aws-command.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
out=Path('temp/lobby-capacity');out.mkdir(parents=True,exist_ok=True)
def aws(*args):
 return json.loads(subprocess.check_output(['aws',*args,'--region','us-west-2','--output','json'],env=module.aws_env()))
script='''set -eu
uname -m
nproc
free -m
uptime
systemctl show bolts.service -p MemoryCurrent -p MemoryMax -p CPUUsageNSec -p MainPID
curl --fail --silent http://127.0.0.1:8080/api/lobbies
printf '\\n'
command -v cargo || true
ls -d /opt/bolts-build/.cargo/bin/cargo /opt/bolts-build/.rustup /opt/bolts/current 2>/dev/null || true
grep '^BOLTS_MAX_ROOMS=' /etc/bolts.env
'''
sent=aws('ssm','send-command','--instance-ids','i-0bd1adb3fc8b01688','--document-name','AWS-RunShellScript','--parameters',json.dumps({'commands':[script]}),'--comment','Read-only lobby capacity inventory')
command=sent['Command']['CommandId'];(out/'probe-command.json').write_text(json.dumps({'id':command}))
for _ in range(30):
 time.sleep(1)
 result=aws('ssm','get-command-invocation','--command-id',command,'--instance-id','i-0bd1adb3fc8b01688')
 if result['Status'] not in ('Pending','InProgress','Delayed'):
  (out/'host-inventory.json').write_text(json.dumps(result,indent=2))
  print(result['StandardOutputContent']);print(result['StandardErrorContent']);break
