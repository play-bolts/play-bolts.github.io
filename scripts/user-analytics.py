#!/usr/bin/env python3
"""Count browser visitors in a UTC time window, including local-only play.

Use --source multiplayer for the separate authenticated WebSocket metric.

Local reads use SQLite mode=ro. --aws runs this same read-only query over SSM,
using aws-command.py's existing credential chain, and returns aggregates only.
"""
import argparse
import base64
from contextlib import closing
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import sys
import time
from uuid import UUID
import zlib


class AnalyticsError(RuntimeError):
    pass


def positive_hours(value):
    try:
        hours = Decimal(value)
    except InvalidOperation as error:
        raise argparse.ArgumentTypeError('hours must be a positive number') from error
    if not hours.is_finite() or hours <= 0 or hours > Decimal('100000000'):
        raise argparse.ArgumentTypeError('hours must be positive and at most 100000000')
    milliseconds = hours * 3_600_000
    if milliseconds < 1 or milliseconds != milliseconds.to_integral_value():
        raise argparse.ArgumentTypeError('hours must describe a whole number of milliseconds')
    return hours


def as_of_ms(value):
    try:
        instant = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if instant.tzinfo is None or instant.utcoffset() is None:
            raise ValueError('timezone missing')
        return int(instant.timestamp() * 1000)
    except (ValueError, OverflowError) as error:
        raise argparse.ArgumentTypeError('as-of must be an ISO 8601 timestamp with a timezone') from error


def identity_uuid(value):
    try:
        return str(UUID(value))
    except ValueError as error:
        raise argparse.ArgumentTypeError('excluded identity IDs must be UUIDs') from error


def exclusions_from_file(path):
    try:
        values = json.loads(Path(path).read_text())
        if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
            raise ValueError('expected UUID list')
        return [identity_uuid(value) for value in values]
    except (OSError, ValueError, argparse.ArgumentTypeError) as error:
        raise AnalyticsError('Exclusion file must be a readable JSON array of UUIDs for the selected source.') from error


def utc_string(milliseconds):
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def read_aggregate(database, query, parameters, source):
    """Execute one aggregate query without opening or creating a writable database."""
    try:
        path = Path(database).expanduser().resolve(strict=True)
    except OSError as error:
        raise AnalyticsError('Database must be an existing readable SQLite file.') from error
    if not path.is_file():
        raise AnalyticsError('Database must be an existing readable SQLite file.')
    try:
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=30)) as connection:
            connection.execute('PRAGMA query_only=ON')
            connection.execute('BEGIN')
            return connection.execute(query, parameters).fetchone()
    except sqlite3.Error as error:
        if source == 'visitors' and 'no such table' in str(error):
            raise AnalyticsError('Visitor analytics tables are unavailable. Deploy the visitor-tracking backend migration '
                                 'or use --source multiplayer for the existing connection metric; historical visits cannot be recovered.') from error
        raise AnalyticsError('Read-only query failed; check database access and the schema for --source ' + source + '.') from error


def analyze_visitors(database, hours, end, excluded):
    """Approximate observed visitor activity in (start, end] from minute buckets."""
    start = end - int(hours * 3_600_000)
    omit = 'v.id IN (' + ','.join('?' for _ in excluded) + ')' if excluded else '0'
    query = f"""
        WITH activity AS (
            SELECT a.visitor_id, v.first_seen AS identity_first_seen, {omit} AS excluded
            FROM visitor_activity a JOIN visitors v ON v.id=a.visitor_id
            WHERE a.first_seen<=? AND a.last_seen>? AND a.last_seen>=a.first_seen
        )
        SELECT count(DISTINCT CASE WHEN NOT excluded THEN visitor_id END),
               count(CASE WHEN NOT excluded THEN 1 END),
               count(DISTINCT CASE WHEN NOT excluded AND identity_first_seen>? AND identity_first_seen<=? THEN visitor_id END),
               count(DISTINCT CASE WHEN excluded THEN visitor_id END),
               (SELECT min(first_seen) FROM visitors)
        FROM activity
    """
    counts = read_aggregate(database, query, (*excluded, end, start, start, end), 'visitors')
    first = counts[4]
    return {
        'source': 'visitors',
        'window_start': utc_string(start),
        'window_end': utc_string(end),
        'hours': float(hours),
        'unique_visitors': counts[0],
        'activity_buckets': counts[1],
        'new_identities_in_window': counts[2],
        'excluded_visitor_ids': len(excluded),
        'excluded_active_visitors': counts[3],
        'first_recorded_activity': utc_string(first) if first is not None else None,
        'window_starts_before_first_recorded_activity': start < first if first is not None else None,
        'granularity_seconds': 60,
        'identity': 'separate random browser visitor UUID; not verified distinct people',
        'activity': 'visitor minute buckets overlapping (window_start, window_end]; sub-minute boundaries are approximate',
        'coverage': 'successful telemetry receipts since visitor tracking deployment only; no historical backfill',
        'limitations': [
            'GPC/DNT opt-outs, blocked telemetry and offline visits are not counted',
            'automated browser visits can count unless explicitly excluded',
            'browser resets/devices can create multiple visitor identities for one person',
            'counts do not measure active play, session duration or simultaneous online users',
        ],
    }


def analyze_multiplayer(database, hours, end, excluded):
    """Count overlapping socket intervals in (start, end], in one read snapshot."""
    start = end - int(hours * 3_600_000)
    omit = 'p.id IN (' + ','.join('?' for _ in excluded) + ')' if excluded else '0'
    query = f"""
        WITH activity AS (
            SELECT c.player_id, c.opened_at, c.closed_at, p.created_at, {omit} AS excluded
            FROM connections c JOIN players p ON p.id=c.player_id
            WHERE p.is_bot=0 AND c.opened_at<=?
              AND (c.closed_at IS NULL OR c.closed_at>?)
              AND (c.closed_at IS NULL OR c.closed_at>c.opened_at)
        )
        SELECT count(DISTINCT CASE WHEN NOT excluded THEN player_id END),
               count(CASE WHEN NOT excluded THEN 1 END),
               count(DISTINCT CASE WHEN NOT excluded AND (closed_at IS NULL OR closed_at>?) THEN player_id END),
               count(DISTINCT CASE WHEN NOT excluded AND opened_at<=? THEN player_id END),
               count(DISTINCT CASE WHEN NOT excluded AND created_at>? AND created_at<=? THEN player_id END),
               count(DISTINCT CASE WHEN excluded THEN player_id END)
        FROM activity
    """
    counts = read_aggregate(database, query, (*excluded, end, start, end, start, start, end), 'multiplayer')
    return {
        'window_start': utc_string(start),
        'window_end': utc_string(end),
        'hours': float(hours),
        'source': 'multiplayer',
        'unique_players': counts[0],
        'connections': counts[1],
        'connected_at_end': counts[2],
        'carried_into_window': counts[3],
        'new_identities_in_window': counts[4],
        'excluded_player_ids': len(excluded),
        'excluded_active_players': counts[5],
        'identity': 'server-issued browser UUID; not verified distinct people',
        'activity': 'non-bot authenticated WebSocket interval overlapping (window_start, window_end]',
    }


def analyze(database, hours, end, excluded=(), source='visitors'):
    excluded = tuple(sorted(set(excluded)))
    if source == 'visitors':
        return analyze_visitors(database, hours, end, excluded)
    if source == 'multiplayer':
        return analyze_multiplayer(database, hours, end, excluded)
    raise AnalyticsError('Unknown analytics source; choose visitors or multiplayer.')


def aws(*arguments):
    helper = Path(__file__).resolve().with_name('aws-command.py')
    try:
        result = subprocess.run([sys.executable, str(helper), '--region', 'us-west-2', *arguments,
                                 '--output', 'json'], capture_output=True, text=True, timeout=45)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AnalyticsError('AWS CLI failed or timed out; check the existing AWS credential chain and SSM access.') from error
    if result.returncode:
        # Do not echo CLI stderr or command parameters; return no credentials/rows.
        raise AnalyticsError('AWS CLI failed; check the existing AWS credential chain and SSM access.')
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AnalyticsError('AWS returned an invalid JSON response.') from error


def resolve_instance(value):
    if value is None:
        outputs = Path(__file__).resolve().parents[1] / 'infra/.state/outputs.json'
        try:
            value = json.loads(outputs.read_text())['InstanceId']
        except (OSError, ValueError, KeyError) as error:
            raise AnalyticsError('Supply --instance-id or restore infra/.state/outputs.json from deployment.') from error
    if not isinstance(value, str) or not re.fullmatch(r'i-[0-9a-f]{8}(?:[0-9a-f]{9})?', value):
        raise AnalyticsError('Invalid EC2 instance ID.')
    return value


def remote_command(hours, end, excluded, source='visitors'):
    # Use a source snapshot: no remote install, temporary database copy, service
    # restart, network credentials, names, IP/UA hashes or chat are transferred.
    program = base64.b64encode(zlib.compress(Path(__file__).read_bytes(), 9)).decode('ascii')
    argv = ['user-analytics.py', '--db', '/var/lib/bolts/bolts.sqlite', '--hours', str(hours),
            '--as-of', utc_string(end), '--source', source, '--json']
    flag = '--exclude-visitor-id' if source == 'visitors' else '--exclude-player-id'
    for identity in excluded:
        argv.extend([flag, identity])
    arguments = base64.b64encode(json.dumps(argv).encode()).decode('ascii')
    bootstrap = (f"import base64,json,sys,zlib;sys.argv=json.loads(base64.b64decode('{arguments}'));"
                 f"exec(compile(zlib.decompress(base64.b64decode('{program}')),'<bolts-user-analytics>','exec'),"
                 "{'__name__':'__main__','__file__':'<bolts-user-analytics>'})")
    return 'runuser -u bolts -- python3 -c ' + shlex.quote(bootstrap)


def analyze_aws(instance, hours, end, excluded, source='visitors'):
    parameters = {'commands': [remote_command(hours, end, excluded, source)], 'executionTimeout': ['45']}
    sent = aws('ssm', 'send-command', '--instance-ids', instance, '--document-name', 'AWS-RunShellScript',
               '--comment', 'Bolts read-only aggregate ' + source + ' analytics', '--timeout-seconds', '60',
               '--parameters', json.dumps(parameters))
    command = sent['Command']['CommandId']
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        # list-command-invocations avoids transient InvocationDoesNotExist errors
        # while SSM registers the command. No remote command is retried/resubmitted.
        status = aws('ssm', 'list-command-invocations', '--command-id', command,
                     '--instance-id', instance, '--details')['CommandInvocations']
        if status:
            invocation = status[0]
            if invocation['Status'] == 'Success':
                result = aws('ssm', 'get-command-invocation', '--command-id', command, '--instance-id', instance)
                try:
                    return json.loads(result['StandardOutputContent'])
                except (KeyError, json.JSONDecodeError) as error:
                    raise AnalyticsError(f'SSM returned invalid aggregate JSON; inspect command {command}.') from error
            if invocation['Status'] in {'Cancelled', 'TimedOut', 'Failed', 'Cancelling'}:
                hint = (' Verify the visitor-tracking backend migration, or use --source multiplayer for the existing socket metric.'
                        if source == 'visitors' else '')
                raise AnalyticsError(f"SSM analytics {invocation['Status']}; inspect command {command}." + hint)
        time.sleep(2)
    raise AnalyticsError(f'SSM analytics is still pending; inspect command {command} before retrying.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    location = parser.add_mutually_exclusive_group(required=True)
    location.add_argument('--db', type=Path, help='existing local SQLite database or consistent backup (read-only)')
    location.add_argument('--aws', '--production', action='store_true', help='read production aggregates through SSM in us-west-2')
    parser.add_argument('--source', choices=['visitors', 'multiplayer'], default='visitors',
                        help='visitor activity including local play (default), or authenticated multiplayer sockets')
    parser.add_argument('--instance-id', help='SSM-managed EC2 ID; defaults to infra/.state/outputs.json')
    parser.add_argument('--hours', type=positive_hours, default=Decimal(24), help='lookback hours, default 24; decimals allowed')
    parser.add_argument('--as-of', type=as_of_ms, help='window end, ISO 8601 with timezone; default current UTC')
    parser.add_argument('--exclude-player-id', type=identity_uuid, action='append', default=[],
                        help='exclude a known multiplayer operator/test UUID; requires --source multiplayer')
    parser.add_argument('--exclude-visitor-id', type=identity_uuid, action='append', default=[],
                        help='exclude a known visitor operator/test UUID; requires --source visitors')
    parser.add_argument('--exclude-file', type=Path, action='append', default=[],
                        help='private JSON array of operator/test UUIDs for the selected --source; repeat as needed')
    parser.add_argument('--json', action='store_true', help='emit aggregate JSON only')
    args = parser.parse_args(argv)
    if args.instance_id and not args.aws:
        parser.error('--instance-id requires --aws')
    if args.exclude_player_id and args.source != 'multiplayer':
        parser.error('--exclude-player-id requires --source multiplayer; visitor UUIDs are separate')
    if args.exclude_visitor_id and args.source != 'visitors':
        parser.error('--exclude-visitor-id requires --source visitors; player UUIDs are separate')
    end = args.as_of if args.as_of is not None else time.time_ns() // 1_000_000
    start = end - int(args.hours * 3_600_000)
    if start < 0 or end > time.time_ns() // 1_000_000:
        parser.error('window must start on/after 1970-01-01 and end no later than now')
    try:
        excluded = tuple(sorted(set(args.exclude_player_id + args.exclude_visitor_id + [player for path in args.exclude_file
                                                              for player in exclusions_from_file(path)])))
        if args.aws:
            result = analyze_aws(resolve_instance(args.instance_id), args.hours, end, excluded, args.source)
        else:
            result = analyze(args.db, args.hours, end, excluded, args.source)
    except (AnalyticsError, OverflowError, ValueError) as error:
        print(f'Analytics failed: {error}', file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    elif args.source == 'multiplayer':
        print(f"{result['unique_players']} non-bot browser identities in the past {result['hours']:g} hours")
        print(f"Window: ({result['window_start']}, {result['window_end']}]")
        print(f"{result['connections']} connections; {result['connected_at_end']} connected at window end; "
              f"{result['carried_into_window']} carried into window; {result['new_identities_in_window']} new identities")
        if result['excluded_player_ids']:
            print(f"Excluded {result['excluded_active_players']} active identities using {result['excluded_player_ids']} supplied UUIDs.")
        print('Includes default names and spectators. Browser identities are not verified distinct people.')
    else:
        print(f"{result['unique_visitors']} browser visitor identities in the past {result['hours']:g} hours")
        print(f"Window: ({result['window_start']}, {result['window_end']}]; minute-bucket boundaries are approximate")
        print(f"{result['activity_buckets']} observed visitor-minute buckets; {result['new_identities_in_window']} new identities")
        if result['excluded_visitor_ids']:
            print(f"Excluded {result['excluded_active_visitors']} active visitors using {result['excluded_visitor_ids']} supplied UUIDs.")
        if result['first_recorded_activity'] is None:
            print('No visitor telemetry has been recorded; this is not evidence of no historical visitors.')
        elif result['window_starts_before_first_recorded_activity']:
            print(f"The window starts before the first recorded visit ({result['first_recorded_activity']}); earlier visits are unknown.")
        print('Includes menus and local-only play with telemetry. GPC/DNT opt-outs are not counted; automated visits can count.')
        print('Visitor identities are not verified distinct people. Data starts at tracking deployment; no historical backfill.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
