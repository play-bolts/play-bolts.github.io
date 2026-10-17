#!/usr/bin/env python3
"""Read-only, aggregate-only pre/post regional rollout verification via SSM.

--baseline PATH records a private baseline. --compare PATH compares a fresh
read-only inspection against it. No database, service, backup or AWS resource is
changed; the SSM command only reads files, SQLite, systemd properties and logs.
Salt and account credential digests are kept in private report files, never
printed. Names, chat text, email addresses and raw log lines are never returned.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('regional_deploy', ROOT / 'scripts/deploy-gamelift.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

REMOTE = r'''
import datetime,hashlib,json,os,re,shlex,sqlite3,subprocess,time
from pathlib import Path
cutoff=CUTOFF_VALUE
since=SINCE_VALUE
now=int(time.time()*1000)
if cutoff is None: cutoff=now
env={}
for line in Path('/etc/bolts.env').read_text().splitlines():
 key,sep,value=line.partition('=')
 if sep and key in ('BOLTS_DB','BOLTS_IDENTITY_SALT'):
  parts=shlex.split(value)
  if len(parts)!=1: raise RuntimeError('invalid required environment entry')
  env[key]=parts[0]
salt=env['BOLTS_IDENTITY_SALT']
if len(salt)<32: raise RuntimeError('identity salt is absent or invalid')
db=sqlite3.connect(Path(env['BOLTS_DB']).as_uri()+'?mode=ro',uri=True,timeout=15)
db.execute('PRAGMA query_only=ON')
db.execute('BEGIN')
tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
count=lambda query,args=():db.execute(query,args).fetchone()[0]
integrity=list(db.execute('PRAGMA integrity_check'))
foreign_keys=sum(1 for _ in db.execute('PRAGMA foreign_key_check'))
counts={name:count('SELECT count(*) FROM '+name) for name in ('players','connections','lobbies','matches','memberships','events','chat_messages','combat_events','leaderboard_names','leaderboard_events','feedback_requests','visitors','visitor_activity') if name in tables}
credentials=hashlib.sha256()
credential_count=0
for player,credential in db.execute('SELECT id,credential_hash FROM players WHERE is_bot=0 AND created_at<=? ORDER BY id',(cutoff,)):
 credentials.update(player.encode()+b'\0'+credential.encode()+b'\n');credential_count+=1
violations={
 'duplicate_open_memberships':count('SELECT count(*) FROM (SELECT 1 FROM memberships WHERE left_at IS NULL GROUP BY player_id,lobby_id HAVING count(*)>1)'),
 'combat_event_links':count("SELECT count(*) FROM combat_events c JOIN events k ON k.id=c.kill_event_id JOIN events d ON d.id=c.death_event_id WHERE k.event_type!='player_kill' OR d.event_type!='player_death' OR k.actor_player_id IS NOT c.killer_id OR k.target_player_id IS NOT c.victim_id OR d.actor_player_id IS NOT c.victim_id OR d.target_player_id IS NOT c.killer_id OR k.match_id IS NOT c.match_id OR d.match_id IS NOT c.match_id"),
 'chat_event_links':count("SELECT count(*) FROM chat_messages c JOIN events e ON e.id=c.id WHERE e.event_type!='chat' OR e.lobby_id IS NOT c.lobby_id OR e.match_id IS NOT c.match_id OR e.actor_player_id IS NOT c.player_id"),
}
regional={}
if 'cluster_cursors' in tables:
 regional={'sessions':count('SELECT count(*) FROM cluster_cursors'),'events':count('SELECT count(*) FROM events e JOIN cluster_cursors c ON c.session=e.lobby_id'),'open_memberships':count('SELECT count(*) FROM memberships m JOIN cluster_cursors c ON c.session=m.lobby_id WHERE m.left_at IS NULL')}
 violations['cursor_without_lobby']=count('SELECT count(*) FROM cluster_cursors c LEFT JOIN lobbies l ON l.id=c.session WHERE l.id IS NULL')
 violations['negative_replication_cursor']=count('SELECT count(*) FROM cluster_cursors WHERE through<0')
 if 'cluster_connection_owners' in tables:
  regional['owned_connections']=count('SELECT count(*) FROM cluster_connection_owners')
  violations['imported_connections_missing_owner']=count('SELECT count(DISTINCT e.connection_id) FROM events e JOIN cluster_cursors c ON c.session=e.lobby_id LEFT JOIN cluster_connection_owners o ON o.connection_id=e.connection_id WHERE e.connection_id IS NOT NULL AND o.connection_id IS NULL')
  violations['connection_wrong_regional_owner']=count('SELECT count(*) FROM events e JOIN cluster_connection_owners o ON o.connection_id=e.connection_id WHERE e.lobby_id IS NOT NULL AND e.lobby_id!=o.session')
  violations['owner_without_cursor']=count('SELECT count(*) FROM cluster_connection_owners o LEFT JOIN cluster_cursors c ON c.session=o.session WHERE c.session IS NULL')
  regional['restart_leave_events_since_baseline']=count("SELECT count(*) FROM events e JOIN cluster_cursors c ON c.session=e.lobby_id WHERE e.event_type='player_leave' AND json_extract(e.data,'$.reason')='server_restart' AND e.at>=?",(since,))
migrations=[r[0] for r in db.execute('SELECT version FROM schema_migrations ORDER BY version')]
db.rollback();db.close()
def props(unit):
 output=subprocess.run(['systemctl','show',unit,'--property=ActiveState,SubState,Result,ExecMainStatus'],check=True,capture_output=True,text=True).stdout
 return dict(line.split('=',1) for line in output.splitlines() if '=' in line)
def journal(unit):
 stamp=datetime.datetime.fromtimestamp(since/1000,datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
 result=subprocess.run(['journalctl','-u',unit,'--since',stamp,'--no-pager','-o','json'],check=True,capture_output=True,text=True)
 for line in result.stdout.splitlines():
  try: yield json.loads(line)
  except ValueError: continue
patterns={'persistence':r'persistence failed|persistent event failure|persistent game operation failed|storage job failed',
 'replication':r'replication deferred|replication failed|cluster request failed',
 'panic':r'panicked|panic:',
 'overload':r'catch.up.*limit|overload|dropped ticks|tick.*backlog',
 'websocket_timeout':r'websocket.*timed out|snapshot.*timed out|send timeout',
 'unavailable_region':r'directory location .* unavailable'}
errors={key:0 for key in patterns}
for row in journal('bolts.service'):
 message=row.get('MESSAGE','')
 if not isinstance(message,str): continue
 for key,pattern in patterns.items(): errors[key]+=bool(re.search(pattern,message,re.I))
backups=[int(r.get('__REALTIME_TIMESTAMP',0))//1000 for r in journal('bolts-backup.service') if r.get('MESSAGE')=='Bolts database backup completed.']
release=os.readlink('/opt/bolts/current').rsplit('/',1)[-1]
assert re.fullmatch(r'[a-f0-9]{64}',release)
print(json.dumps({'capturedAt':now,'credentialCutoff':cutoff,'release':release,'migrations':migrations,'integrityOk':integrity==[('ok',)],'foreignKeyViolations':foreign_keys,'counts':counts,'violations':violations,'regional':regional,'services':{'game':props('bolts.service'),'backup':props('bolts-backup.service'),'backupTimer':props('bolts-backup.timer')},'completedBackupsSinceBaseline':len(backups),'latestBackupAt':max(backups) if backups else None,'errorCountsSinceBaseline':errors,'private':{'saltSha256':hashlib.sha256(salt.encode()).hexdigest(),'credentialSha256':credentials.hexdigest(),'credentialCount':credential_count}},separators=(',',':')))
'''


def comparison(before, after):
    unchanged = before['private']['saltSha256'] == after['private']['saltSha256']
    credentials = all(before['private'][key] == after['private'][key] for key in ('credentialSha256', 'credentialCount'))
    return {'identitySaltPreserved': unchanged, 'existingHumanCredentialsPreserved': credentials,
            'recordCountsPreserved': all(after['counts'].get(name, -1) >= count for name, count in before['counts'].items()),
            'migrationsComplete': all(version in after['migrations'] for version in (1, 2, 3, 4))}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--baseline', type=Path)
    mode.add_argument('--compare', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--instance', default='i-0bd1adb3fc8b01688')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'i-[a-f0-9]+', args.instance): raise ValueError('Invalid instance ID')
    if args.baseline and args.baseline.exists(): raise ValueError('Baseline already exists; preserve it and use --compare')
    before = json.loads(args.compare.read_text()) if args.compare else None
    cutoff = before['credentialCutoff'] if before else None
    since = before['capturedAt'] if before else int(time.time()*1000)-24*60*60*1000
    script = 'set -euo pipefail\npython3 - <<\'BOLTS_VERIFY\'\n' + REMOTE.replace('CUTOFF_VALUE', repr(cutoff)).replace('SINCE_VALUE', str(since)) + '\nBOLTS_VERIFY\n'
    output = args.baseline or args.output or args.compare.with_name('postrollout.json')
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # SSM submission creates a command record, but its payload performs only
    # read operations; no service starts/restarts or database writes are issued.
    aws = deploy.AWS(apply=True)
    command = deploy.ssm(aws, args.instance, script, output.parent, 'Bolts read-only aggregate regional verification')
    value = json.loads(deploy.wait_ssm(aws, args.instance, command))
    value['commandId'] = command
    if before: value['comparison'] = comparison(before, value)
    deploy.save(output, value)
    summary = {key: data for key, data in value.items() if key != 'private'}
    print(json.dumps(summary, indent=2))
    healthy = value['integrityOk'] and value['foreignKeyViolations'] == 0 and not any(value['violations'].values())
    healthy = healthy and value['services']['game'].get('ActiveState') == 'active' and value['services']['backupTimer'].get('ActiveState') == 'active'
    if before: healthy = healthy and all(value['comparison'].values()) and value['completedBackupsSinceBaseline'] > 0 and value['services']['backup'].get('Result') == 'success'
    if not healthy: raise deploy.DeploymentError('One or more aggregate verification checks failed; see the private report')


if __name__ == '__main__':
    try: main()
    except (deploy.DeploymentError, OSError, ValueError, KeyError) as error:
        print('Verification stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
