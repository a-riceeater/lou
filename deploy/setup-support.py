#!/usr/bin/env python3
"""Installer primitives; never execute environment-file contents."""
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
from urllib.parse import urlsplit


def trusted_path(value):
    path = Path(value)
    if not path.is_absolute() or str(path) != value or '..' in path.parts or value == '/':
        raise ValueError('expected a canonical absolute path')
    for part in [*reversed(path.parents), path]:
        if part.is_symlink():
            raise ValueError('unexpected symlink; administrator intervention required')
        if part.exists():
            mode = part.stat()
            if mode.st_uid != 0 or mode.st_mode & 0o022:
                raise ValueError('system path must be root-owned and not group/world writable')
    return path


def public_url(value):
    u = urlsplit(value)
    if (u.scheme != 'https' or not u.hostname or u.username or u.password
            or u.query or u.fragment or u.path not in ('', '/')
            or re.search(r'[\s\\\x00-\x1f\x7f]', value)):
        raise ValueError('enter an HTTPS origin, without credentials, path, query or fragment')
    if u.port is not None and not 1 <= u.port <= 65535:
        raise ValueError('invalid port')
    if not re.fullmatch(r'[A-Za-z0-9.:\[\]-]+', u.netloc):
        raise ValueError('invalid hostname')
    return value.rstrip('/')


def quote(value):
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('control characters are not supported in environment values')
    # POSIX shell and systemd EnvironmentFile double-quote escapes agree here.
    return '"' + re.sub(r'([\\"$`])', r'\\\1', value) + '"'


def read_env(path):
    result = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith(('#', ';')):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) or key in result:
            raise ValueError('invalid or duplicate environment variable')
        value = value.strip()
        if value.startswith("'") and value.endswith("'") and "'" not in value[1:-1]:
            value = value[1:-1]
        elif value.startswith('"') and value.endswith('"'):
            raw = value[1:-1]
            value = ''
            i = 0
            while i < len(raw):
                c = raw[i]
                if c == '\\':
                    i += 1
                    if i == len(raw) or raw[i] not in '\\"$`':
                        raise ValueError('unsupported environment escape')
                    c = raw[i]
                elif c == '"':
                    raise ValueError('unexpected quote')
                value += c
                i += 1
        elif re.search(r'[\s\'"\\$`]', value):
            raise ValueError('quote environment values; shell expressions are not supported')
        quote(value)
        result[key] = value
    return result


def copy_source(source, destination):
    excluded = {'.git', 'node_modules', 'dist', 'data', 'coverage', 'bin', 'obj', '.codex'}
    def ignore(_directory, names):
        return [n for n in names if n in excluded or n.startswith('.env')
                or re.search(r'\.db(?:-|$)', n)]
    # copytree preserves neither ownership nor privileged mode bits; reject links
    # before copying so a checkout cannot smuggle unrelated files into /opt.
    for directory, dirs, files in os.walk(source, followlinks=False):
        skipped = ignore(directory, dirs + files)
        dirs[:] = [d for d in dirs if d not in skipped]
        for name in dirs + [f for f in files if f not in skipped]:
            p = Path(directory, name)
            if p.is_symlink() or not (p.is_dir() or p.is_file()):
                raise ValueError('source contains a symlink or special file')
    shutil.copytree(source, destination, ignore=ignore, dirs_exist_ok=True)


def validate_env(path, app):
    env = read_env(path)
    required = {'LOU_ENV': 'production', 'LOU_HOST': '127.0.0.1', 'LOU_PORT': '8787',
                'LOU_DATA_DIR': '/var/lib/lou', 'LOU_DB_PATH': '/var/lib/lou/lou.db',
                'LOU_SKILLS_DIR': '/opt/lou/skills'}
    if any(env.get(k) != v for k, v in required.items()):
        raise ValueError('configuration must use the documented production paths and loopback port')
    public_url(env.get('LOU_PUBLIC_URL', ''))
    if env.get('AI_PROVIDER', 'openai_api') == 'openai_api' and not env.get('OPENAI_API_KEY'):
        raise ValueError('OpenAI API key is required for the API provider')
    # Use Lou's actual schema and Vault, without opening/migrating the database.
    code = ("import {loadConfig} from './apps/server/src/config.ts';"
            "import {Vault} from './apps/server/src/security/crypto.ts';"
            "const c=loadConfig(); new Vault(c.masterKey);")
    clean = {'PATH': '/usr/bin:/usr/local/bin:/bin', 'HOME': '/var/lib/lou', **env}
    check = subprocess.run(['/usr/bin/node', '--import', 'tsx', '--input-type=module',
                            '-e', code], cwd=app, env=clean, capture_output=True)
    if check.returncode:
        raise ValueError('Lou rejected the configuration; check types, timezone and master-key format')


def main():
    action, *args = sys.argv[1:]
    if action == 'path':
        trusted_path(args[0])
    elif action == 'url':
        print(public_url(args[0]))
    elif action == 'write':
        # Values arrive on stdin, never in process arguments.
        print(args[0] + '=' + quote(sys.stdin.read()))
    elif action == 'copy':
        copy_source(*args)
    elif action == 'validate':
        validate_env(*args)
    elif action == 'get':
        print(read_env(args[0]).get(args[1], ''))
    elif action == 'cli':
        env = {**os.environ, **read_env('/etc/lou/lou.env')}
        os.chdir('/opt/lou')
        os.execve('/usr/bin/node', ['node', '/opt/lou/apps/server/dist/cli.js', *args], env)
    elif action == 'health':
        data = json.load(sys.stdin)
        if data.get('status') != 'ok' or data.get('db') != 'ok':
            raise ValueError('health endpoint reports a degraded database')
    else:
        raise ValueError('unknown installer operation')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Inputs may contain credentials; do not print exception values.
        print('Validation failed for ' + (sys.argv[1] if len(sys.argv) > 1 else 'operation')
              + '; no input values were logged.', file=sys.stderr)
        sys.exit(1)
