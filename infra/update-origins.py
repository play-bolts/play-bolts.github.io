#!/usr/bin/env python3
"""Change browser origins on the existing service without rebuilding its binary.

Run as root through SSM. Configuration contents, including the identity salt,
remain on the instance and are never included in output.
"""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request


def validate_origins(value):
    origins = value.split(',')
    if not origins or len(set(origins)) != len(origins):
        raise ValueError('Origins must be a nonempty list of unique exact origins')
    for origin in origins:
        url = urllib.parse.urlsplit(origin)
        if (any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in origin)
                or not url.hostname or url.username or url.password or url.path
                or url.query or url.fragment or origin != origin.strip()
                or url.scheme not in {'http', 'https'}):
            raise ValueError('Invalid browser origin')
        if url.scheme == 'http' and url.hostname not in {'127.0.0.1', 'localhost', '::1'}:
            raise ValueError('Remote browser origins require HTTPS')
        _ = url.port
    return origins


def replacement(original, origins):
    validate_origins(origins)
    lines = original.splitlines()
    if sum(line.startswith('BOLTS_ORIGINS=') for line in lines) != 1:
        raise ValueError('Expected exactly one existing BOLTS_ORIGINS entry')
    return '\n'.join('BOLTS_ORIGINS=' + origins if line.startswith('BOLTS_ORIGINS=')
                     else line for line in lines) + '\n'


def atomic_write(path, contents):
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
        raise ValueError('Configuration must be a regular file')
    previous = path.stat()
    descriptor, temporary = tempfile.mkstemp(prefix='.bolts-origins-', dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        if os.geteuid() == 0:
            os.fchown(descriptor, previous.st_uid, previous.st_gid)
        with os.fdopen(descriptor, 'w') as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def local_json(path):
    with urllib.request.urlopen('http://127.0.0.1:8080' + path, timeout=3) as response:
        return json.load(response)


def healthy():
    for _ in range(30):
        try:
            if local_json('/api/health').get('ok') is True:
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('Local service health verification failed')


def restart():
    subprocess.run(['systemctl', 'restart', 'bolts.service'], check=True, timeout=60,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def origins_match(origins):
    for origin in origins.split(','):
        request = urllib.request.Request('http://127.0.0.1:8080/api/lobbies', headers={'Origin': origin})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                if response.headers.get('Access-Control-Allow-Origin') != origin:
                    return False
        except OSError:
            return False
    return True


def apply(origins, path=Path('/etc/bolts.env')):
    validate_origins(origins)
    if any(room.get('players', 0) for room in local_json('/api/lobbies')['lobbies']):
        raise RuntimeError('Origin update requires empty lobbies; no configuration changed')
    original = path.read_text()
    updated = replacement(original, origins)
    if updated == original and origins_match(origins):
        healthy()
        print('Browser origins already configured; service unchanged.')
        return
    atomic_write(path, updated)
    try:
        restart()
        healthy()
        if not origins_match(origins):
            raise RuntimeError('Local browser-origin verification failed')
    except Exception:
        atomic_write(path, original)
        restart()
        healthy()
        raise RuntimeError('Origin update failed; previous configuration restored') from None
    print('Browser origins updated; existing binary healthy. No release rebuild.')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Pass one comma-separated origin allowlist')
        apply(sys.argv[1])
    except Exception as error:
        # Our validation/runtime messages are fixed text; OS/process exceptions
        # are represented by type only so env contents never enter the output.
        detail = str(error) if isinstance(error, (RuntimeError, ValueError)) else type(error).__name__
        print(f'Origin update stopped: {detail}', file=sys.stderr)
        sys.exit(1)
