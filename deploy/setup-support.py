#!/usr/bin/env python3
"""Installer primitives; never execute environment-file contents."""
import json
import ipaddress
import os
from pathlib import Path
import pwd
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
            if stat.S_ISREG(mode.st_mode) and mode.st_nlink != 1:
                raise ValueError('unexpected hard-linked system file')
    return path


def public_url(value):
    u = urlsplit(value)
    if (not value.startswith('https://') or u.scheme != 'https' or not u.hostname or u.username or u.password
            or u.query or u.fragment or u.path not in ('', '/')
            or re.search(r'[\s\\\x00-\x1f\x7f]', value)):
        raise ValueError('enter an HTTPS origin, without credentials, path, query or fragment')
    if u.port is not None and not 1 <= u.port <= 65535:
        raise ValueError('invalid port')
    if not re.fullmatch(r'[A-Za-z0-9.:\[\]-]+', u.netloc):
        raise ValueError('invalid hostname')
    if u.netloc.endswith(':') or len(u.hostname) > 253:
        raise ValueError('invalid hostname or empty port')
    if ':' in u.hostname or re.fullmatch(r'[0-9.]+', u.hostname):
        ipaddress.ip_address(u.hostname)
    if ':' not in u.hostname:
        labels = u.hostname.split('.')
        if any(not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', x) for x in labels):
            raise ValueError('invalid DNS hostname')
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
    source, destination = Path(source), Path(destination)
    if source == destination or destination.is_relative_to(source):
        raise ValueError('source and candidate must be separate directories')
    if (source / '.git').exists():
        files = subprocess.check_output(['git', '-c', f'safe.directory={source}', '-c',
                                         'core.fsmonitor=false', '-C',
                                         str(source), 'ls-files', '-z']).decode().split('\0')
    else:
        # Installed snapshots can rerun setup from /opt/lou without a .git tree.
        with os.fdopen(open_input(str(source / '.lou-install-files.json'))) as manifest:
            files = json.load(manifest)
    installed = []
    for name in files:
        if not name:
            continue
        p = Path(name)
        if p.is_absolute() or '..' in p.parts or str(p) != name:
            raise ValueError('invalid source manifest path')
        if any(x in excluded or x.startswith('.env') or re.search(r'\.db(?:-|$)', x) for x in p.parts):
            continue
        origin = source / p
        input_file(str(origin))
        target = destination / p
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        # Opening with NOFOLLOW also rejects a last-moment source-file symlink.
        fd = open_input(str(origin))
        with os.fdopen(fd, 'rb') as reader:
            mode = os.fstat(reader.fileno())
            if not stat.S_ISREG(mode.st_mode):
                raise ValueError('source must contain only regular files')
            with target.open('xb') as writer:
                shutil.copyfileobj(reader, writer)
            target.chmod(0o755 if mode.st_mode & 0o111 else 0o644)
        installed.append(name)
    (destination / '.lou-install-files.json').write_text(json.dumps(installed))


def input_file(value):
    path = Path(value)
    if not path.is_absolute() or str(path) != value or '..' in path.parts:
        raise ValueError('input must be a canonical absolute path')
    if any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError('symlink input is not supported')
    if not path.is_file():
        raise ValueError('input must be a regular file')


def open_input(value):
    input_file(value)
    # Open every ancestor without following links; a concurrent rename cannot
    # redirect a privileged read through a newly substituted directory symlink.
    parts = Path(value).parts[1:]
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        result = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        if not stat.S_ISREG(os.fstat(result).st_mode):
            os.close(result)
            raise ValueError('input changed into a special file')
        return result
    finally:
        os.close(fd)


def freeze_tree(value, owner):
    path = Path(value)
    if path.parent != Path('/opt') or not path.name.startswith('.lou-build.') or path.is_symlink():
        raise ValueError('unexpected candidate path')
    uid = pwd.getpwnam(owner).pw_uid
    gid = pwd.getpwnam(owner).pw_gid
    # Use descriptors and O_NOFOLLOW: a build-created link can never redirect a
    # privileged chmod/chown to an unrelated file, even during a concurrent swap.
    for directory, dirs, files, fd in os.fwalk(path, follow_symlinks=False):
        os.fchown(fd, uid, gid)
        os.fchmod(fd, 0o755)
        for name in dirs + files:
            mode = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(mode.st_mode):
                resolved = (Path(directory) / name).resolve()
                if not resolved.is_relative_to(path):
                    raise ValueError('candidate symlink escapes application directory')
                os.chown(name, uid, gid, dir_fd=fd, follow_symlinks=False)
            elif stat.S_ISREG(mode.st_mode):
                file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    current = os.fstat(file_fd)
                    if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
                        raise ValueError('unexpected candidate file or hard link')
                    os.fchown(file_fd, uid, gid)
                    os.fchmod(file_fd, 0o755 if current.st_mode & 0o111 else 0o644)
                finally:
                    os.close(file_fd)
            elif not stat.S_ISDIR(mode.st_mode):
                raise ValueError('candidate contains a special file')


def validate_mcp(path, env_path):
    env = read_env(env_path)
    raw = Path(path).read_text()
    refs = set(re.findall(r'\$\{([A-Z0-9_]+)\}', raw))
    if any(not env.get(key) for key in refs):
        raise ValueError('MCP has unresolved environment references')
    raw = re.sub(r'\$\{([A-Z0-9_]+)\}', lambda m: json.dumps(env[m[1]])[1:-1], raw)
    config = json.loads(raw)
    if not isinstance(config, dict) or not isinstance(config.get('servers', []), list):
        raise ValueError('expected MCP servers array')
    ids = set()
    for server in config.get('servers', []):
        if not isinstance(server, dict) or not isinstance(server.get('id'), str):
            raise ValueError('invalid MCP server')
        if not re.fullmatch('[a-z][a-z0-9_]*', server['id']) or server['id'] in ids:
            raise ValueError('invalid or duplicate MCP id')
        ids.add(server['id'])
        if not isinstance(server.get('name'), str) or server.get('transport') not in ('http', 'sse', 'stdio'):
            raise ValueError('MCP name and supported transport required')
        if server['transport'] == 'stdio':
            if not isinstance(server.get('command'), str) or not server['command']:
                raise ValueError('MCP stdio command required')
        else:
            url = urlsplit(server.get('url', ''))
            if url.scheme not in ('http', 'https') or not url.hostname:
                raise ValueError('MCP HTTP/SSE URL required')
        for field in ('args', 'include', 'exclude', 'readOnlyTools', 'keywords'):
            if field in server and (not isinstance(server[field], list) or any(not isinstance(x, str) for x in server[field])):
                raise ValueError('invalid MCP string array')
        for field in ('headers', 'env'):
            if field in server and (not isinstance(server[field], dict) or any(not isinstance(x, str) for x in server[field].values())):
                raise ValueError('invalid MCP string map')
        if 'description' in server and not isinstance(server['description'], str):
            raise ValueError('invalid MCP description')
        limit = server.get('maxToolsPerRequest', 8)
        if type(limit) is not int or not 1 <= limit <= 30:
            raise ValueError('invalid MCP tool limit')


def validate_env(path, app):
    env = read_env(path)
    required = {'LOU_ENV': 'production', 'LOU_HOST': '127.0.0.1', 'LOU_PORT': '8787',
                'LOU_DATA_DIR': '/var/lib/lou', 'LOU_DB_PATH': '/var/lib/lou/lou.db',
                'LOU_SKILLS_DIR': '/opt/lou/skills'}
    if any(env.get(k) != v for k, v in required.items()):
        raise ValueError('configuration must use the documented production paths and loopback port')
    public_url(env.get('LOU_PUBLIC_URL', ''))
    if env.get('CODEX_HOME', '/var/lib/lou/.codex') != '/var/lib/lou/.codex':
        raise ValueError('Codex credentials must use /var/lib/lou/.codex')
    if env.get('LOU_CODEX_WORKSPACE', '/var/lib/lou/codex-workspace') != '/var/lib/lou/codex-workspace':
        raise ValueError('Codex workspace must use /var/lib/lou/codex-workspace')
    if env.get('LOU_MCP_CONFIG'):
        if env['LOU_MCP_CONFIG'] != '/etc/lou/mcp.json':
            raise ValueError('MCP configuration must use /etc/lou/mcp.json')
    if env.get('AI_PROVIDER', 'openai_api') == 'openai_api' and not env.get('OPENAI_API_KEY'):
        raise ValueError('OpenAI API key is required for the API provider')
    # Use Lou's actual schema and Vault, without opening/migrating the database.
    code = ("import {loadConfig} from './apps/server/src/config.ts';"
            "import {Vault} from './apps/server/src/security/crypto.ts';"
            "const c=loadConfig(); new Vault(c.masterKey);")
    # Unknown variables (e.g. NODE_OPTIONS/LD_PRELOAD) must not inject code into
    # the configuration validator. The service still gets administrator settings.
    clean = {'PATH': '/usr/bin:/usr/local/bin:/bin', 'HOME': '/var/lib/lou'}
    clean.update({k: v for k, v in env.items() if k.startswith(('LOU_', 'OPENAI_', 'GOOGLE_', 'INSTAGRAM_'))
                  or k in ('AI_PROVIDER', 'CODEX_HOME', 'CODEX_PATH')})
    check = subprocess.run(['/usr/bin/node', '--import', 'tsx', '--input-type=module',
                            '-e', code], cwd=app, env=clean, capture_output=True,
                           user='lou', group='lou', extra_groups=['lou'])
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
    elif action == 'freeze':
        freeze_tree(*args)
    elif action == 'input':
        input_file(args[0])
    elif action == 'import':
        with os.fdopen(open_input(args[0]), 'rb') as reader, open(args[1], 'xb') as writer:
            shutil.copyfileobj(reader, writer)
    elif action == 'refs':
        for key in sorted(set(re.findall(r'\$\{([A-Z0-9_]+)\}', Path(args[0]).read_text()))):
            if not re.fullmatch('[A-Z_][A-Z0-9_]*', key):
                raise ValueError('invalid MCP environment reference')
            print(key)
    elif action == 'mcp':
        validate_mcp(*args)
    elif action == 'validate':
        validate_env(*args)
    elif action == 'get':
        print(read_env(args[0]).get(args[1], ''))
    elif action == 'cli':
        if os.getuid() != pwd.getpwnam('lou').pw_uid or os.getuid() == 0:
            raise ValueError('run the administrative launcher as the lou service user')
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
        if len(sys.argv) > 1 and sys.argv[1] == 'validate':
            print('Use the documented production paths, an HTTPS origin, valid Lou settings, '
                  'a 32-byte base64 master key and credentials for the selected provider.', file=sys.stderr)
        elif len(sys.argv) > 1 and sys.argv[1] == 'path':
            print('System paths must be absolute, root-owned, non-writable by other users, '
                  'and free of symlinks/hard-linked files; review with an administrator.', file=sys.stderr)
        sys.exit(1)
