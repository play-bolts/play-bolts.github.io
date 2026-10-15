#!/usr/bin/env python3
"""Invoke AWS CLI using the user's existing credential chain, without echoing secrets.
Supports a legacy AWS export file as well as standard shared-credentials format.
"""
import os, re, subprocess, sys
from pathlib import Path

def aws_env():
    env = os.environ.copy()
    credentials = Path.home() / '.aws/credentials'
    if credentials.exists():
        text = credentials.read_text()
        if not re.search(r'^\s*\[', text, re.M):
            for key, value in re.findall(r'^\s*(?:export\s+)?(AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN))\s*=\s*[\"\']?([^\"\'\n]+)', text, re.M):
                env.setdefault(key, value.strip())
            env['AWS_SHARED_CREDENTIALS_FILE'] = '/dev/null'
    env.setdefault('AWS_DEFAULT_REGION', 'us-west-2')
    env['AWS_PAGER'] = ''
    return env

if __name__ == '__main__':
    sys.exit(subprocess.call(['aws', *sys.argv[1:]], env=aws_env()))
