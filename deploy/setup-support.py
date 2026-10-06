#!/usr/bin/env python3
"""Installer primitives; never execute environment-file contents."""
import base64
import hashlib
import json
import ipaddress
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import urlsplit

# Fixed deployment layout. Unit tests substitute a temporary root and owner;
# deliberately, no argument or environment variable can redirect these paths.
ROOT = Path('/')
OWNER = 0
STAGE_NAME = r'\.lou-build\.[A-Za-z0-9]{8}'
RELEASE_NAME = r'[0-9]{8}T[0-9]{6}Z-(?:[0-9a-f]{12}|unknown)'
BACKUP_NAME = r'lou-pre-update-[0-9]{8}T[0-9]{6}Z-(?:[0-9a-f]{12}|unknown)-[0-9a-f]{12}\.db'
COMMIT = r'[0-9a-f]{40}(?:[0-9a-f]{24})?'
RELEASE_FILE = '.lou-release.json'
JOURNAL = 'apps/server/dist/drizzle/meta/_journal.json'


def layout():
    return {'opt': ROOT / 'opt', 'app': ROOT / 'opt/lou', 'releases': ROOT / 'opt/lou-releases',
            'backups': ROOT / 'var/lib/lou-updater/backups'}


def trusted_path(value):
    path = Path(value)
    if not path.is_absolute() or str(path) != value or '..' in path.parts or value == '/':
        raise ValueError('expected a canonical absolute path')
    for part in [*reversed(path.parents), path]:
        if part.is_symlink():
            raise ValueError('unexpected symlink; administrator intervention required')
        if part.exists():
            mode = part.stat()
            if mode.st_uid != OWNER or mode.st_mode & 0o022:
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


def set_env(path, key, value):
    """Replaces (or with value None removes) one variable, keeping every other line as is."""
    if not re.fullmatch(r'[A-Z_][A-Z0-9_]*', key):
        raise ValueError('invalid environment variable name')
    path = Path(path)
    read_env(path)
    lines = [line for line in path.read_text().splitlines() if line.strip().partition('=')[0].strip() != key]
    if value is not None:
        lines.append(key + '=' + quote(value))
    path.write_text('\n'.join(lines) + '\n')
    read_env(path)


SPOTIFY_CALLBACK = '/oauth/spotify/callback'
SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token'


def spotify_redirect(env_path):
    """The exact redirect URI Lou will send; it must be registered in the Spotify dashboard."""
    env = read_env(env_path)
    if env.get('SPOTIFY_REDIRECT_URI'):
        return env['SPOTIFY_REDIRECT_URI']
    return public_url(env.get('LOU_PUBLIC_URL', '')) + SPOTIFY_CALLBACK


def spotify_credential(value):
    if not re.fullmatch(r'[A-Za-z0-9]{16,64}', value):
        raise ValueError('Spotify client IDs and secrets are 16-64 letters and digits')
    return value


def spotify_verify(client_id, client_secret, opener=urllib.request.urlopen):
    """True if Spotify accepts the app credentials, False if it rejects them; None if unreachable."""
    spotify_credential(client_id)
    spotify_credential(client_secret)
    token = base64.b64encode(f'{client_id}:{client_secret}'.encode()).decode()
    request = urllib.request.Request(SPOTIFY_TOKEN_URL, method='POST',
                                     data=urllib.parse.urlencode({'grant_type': 'client_credentials'}).encode(),
                                     headers={'Authorization': 'Basic ' + token,
                                              'Content-Type': 'application/x-www-form-urlencoded'})
    try:
        with opener(request, timeout=15) as response:
            return bool(json.load(response).get('access_token'))
    except urllib.error.HTTPError as err:
        return False if err.code in (400, 401) else None
    except (urllib.error.URLError, OSError, ValueError):
        return None


def excluded(parts):
    """Local, generated and secret files never enter an application snapshot."""
    names = {'.git', 'node_modules', 'dist', 'data', 'coverage', 'bin', 'obj', '.codex'}
    return any(x in names or x.startswith('.env') or re.search(r'\.db(?:-|$)', x) for x in parts)


def copy_source(source, destination):
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
        if excluded(p.parts):
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


def verify_copy(source, destination, manifest):
    """Installer counterpart of verify_export: the unprivileged build left the
    copied sources (including the deploy scripts root runs later) intact."""
    _, target = deployment_path(destination, ('stage',))
    with os.fdopen(open_input(manifest)) as reader:
        names = json.load(reader)
    with os.fdopen(open_input(str(target / '.lou-install-files.json'))) as reader:
        if json.load(reader) != names:
            raise ValueError('candidate file manifest changed during the build')
    for name in names:
        p = Path(name)
        if p.is_absolute() or '..' in p.parts or str(p) != name:
            raise ValueError('invalid source manifest path')
        with os.fdopen(open_input(str(Path(source) / p)), 'rb') as original, \
                os.fdopen(open_input(str(target / p)), 'rb') as copy:
            executable = [bool(os.fstat(f.fileno()).st_mode & 0o111) for f in (original, copy)]
            if (executable[0] != executable[1]
                    or hashlib.sha256(original.read()).digest() != hashlib.sha256(copy.read()).digest()):
                raise ValueError('candidate source changed during the build')


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
    if path.parent != layout()['opt'] or not path.name.startswith('.lou-build.') or path.is_symlink():
        raise ValueError('unexpected candidate path')
    uid = pwd.getpwnam(owner).pw_uid
    gid = pwd.getpwnam(owner).pw_gid
    # Hard links are allowed only when every name of the file is inside the
    # candidate (esbuild's install script links its native binary into place);
    # a link from outside would let the chown/chmod below reach that file.
    names = {}
    for _, dirs, files, fd in os.fwalk(path, follow_symlinks=False):
        for name in dirs + files:
            mode = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISREG(mode.st_mode) and mode.st_nlink > 1:
                key = (mode.st_dev, mode.st_ino)
                names[key] = names.get(key, 0) + 1
    # Use descriptors and O_NOFOLLOW: a build-created link can never redirect a
    # privileged chmod/chown to an unrelated file, even during a concurrent swap.
    for directory, dirs, files, fd in os.fwalk(path, follow_symlinks=False):
        os.fchown(fd, uid, gid)
        os.fchmod(fd, 0o755)
        for name in dirs + files:
            relative = (Path(directory) / name).relative_to(path)
            mode = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(mode.st_mode):
                resolved = (Path(directory) / name).resolve()
                if not resolved.is_relative_to(path):
                    raise ValueError(f'candidate symlink escapes application directory: {relative}')
                os.chown(name, uid, gid, dir_fd=fd, follow_symlinks=False)
            elif stat.S_ISREG(mode.st_mode):
                file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    current = os.fstat(file_fd)
                    if not stat.S_ISREG(current.st_mode):
                        raise ValueError(f'candidate file changed type: {relative}')
                    if current.st_nlink != 1 and names.get((current.st_dev, current.st_ino)) != current.st_nlink:
                        raise ValueError(f'candidate file is hard-linked outside the candidate: {relative}')
                    os.fchown(file_fd, uid, gid)
                    os.fchmod(file_fd, 0o755 if current.st_mode & 0o111 else 0o644)
                finally:
                    os.close(file_fd)
            elif not stat.S_ISDIR(mode.st_mode):
                raise ValueError(f'candidate contains a special file: {relative}')


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
    clean.update({k: v for k, v in env.items() if k.startswith(('LOU_', 'OPENAI_', 'GOOGLE_', 'INSTAGRAM_', 'SPOTIFY_'))
                  or k in ('AI_PROVIDER', 'CODEX_HOME', 'CODEX_PATH')})
    check = subprocess.run(['/usr/bin/node', '--import', 'tsx', '--input-type=module',
                            '-e', code], cwd=app, env=clean, capture_output=True,
                           user='lou', group='lou', extra_groups=['lou'])
    if check.returncode:
        raise ValueError('Lou rejected the configuration; check types, timezone and master-key format')


# ---- Updater primitives -----------------------------------------------------
# Every mutation below accepts only exact, pattern-checked deployment locations
# and never follows symlinks; callers cannot name arbitrary paths.

def deployment_path(value, kinds):
    """Returns (kind, Path) if value is exactly one of the allowed deployment locations."""
    places = layout()
    path = Path(value)
    if not value or not path.is_absolute() or str(path) != value or '..' in path.parts:
        raise ValueError('expected a canonical absolute deployment path')
    matches = {
        'app': path == places['app'],
        'stage': path.parent == places['opt'] and re.fullmatch(STAGE_NAME, path.name) is not None,
        'release': path.parent == places['releases'] and re.fullmatch(RELEASE_NAME, path.name) is not None,
    }
    kind = next((k for k in kinds if matches[k]), None)
    if kind is None:
        raise ValueError('path is not an allowed deployment location')
    trusted_path(str(path.parent))
    return kind, path


def real_directory(path):
    """lstat-based: a symlink or mount point is never treated as a deployment tree."""
    mode = os.lstat(path)
    if not stat.S_ISDIR(mode.st_mode):
        raise ValueError('expected a real directory, not a symlink or file')
    if os.lstat(path.parent).st_dev != mode.st_dev:
        raise ValueError('deployment trees must not be mount points')
    return mode


# Activation, rollback and retention are the only allowed renames.
MOVES = {('app', 'release'), ('stage', 'app'), ('app', 'stage'), ('release', 'app')}


def move_tree(source, destination):
    source_kind, source = deployment_path(source, ('app', 'stage', 'release'))
    target_kind, target = deployment_path(destination, ('app', 'stage', 'release'))
    if (source_kind, target_kind) not in MOVES:
        raise ValueError('unsupported deployment move')
    mode = real_directory(source)
    if os.path.lexists(target):
        raise ValueError('move destination already exists')
    if os.lstat(target.parent).st_dev != mode.st_dev:
        raise ValueError('deployment directories must share one filesystem')
    # rename(2) is atomic and never copies; unlike mv it cannot fall back to a
    # partial cross-filesystem copy and delete.
    os.rename(source, target)


def remove_tree(value):
    """Deletes one updater candidate or retained release; never the active app or data."""
    _, path = deployment_path(value, ('stage', 'release'))
    mode = real_directory(path)
    if not shutil.rmtree.avoids_symlink_attacks:
        raise ValueError('this platform cannot remove trees without following symlinks')
    for _, _, _, fd in os.fwalk(path, follow_symlinks=False):
        if os.fstat(fd).st_dev != mode.st_dev:
            raise ValueError('refusing to remove a tree containing another filesystem')
    shutil.rmtree(path)


def prune_releases(keep, protect=''):
    """Keeps the newest `keep` retained releases (plus `protect`); ignores unknown entries."""
    if keep < 1:
        raise ValueError('at least one previous release must be retained')
    directory = layout()['releases']
    trusted_path(str(directory))
    names = sorted(n for n in os.listdir(directory) if re.fullmatch(RELEASE_NAME, n)
                   and stat.S_ISDIR(os.lstat(directory / n).st_mode))
    for name in names[:-keep]:
        if name != protect:
            remove_tree(str(directory / name))
            print(name)


def prune_backups(keep, protect=''):
    """Keeps the newest `keep` updater backups (plus `protect`); other files are never touched."""
    if keep < 1:
        raise ValueError('at least one backup must be retained')
    directory = layout()['backups']
    trusted_path(str(directory))
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        names = []
        for name in os.listdir(fd):
            if not re.fullmatch(BACKUP_NAME, name):
                continue
            mode = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISREG(mode.st_mode) and mode.st_nlink == 1 and mode.st_uid == OWNER:
                names.append(name)
        for name in sorted(names)[:-keep]:
            if name != protect:
                os.unlink(name, dir_fd=fd)
                print(name)
    finally:
        os.close(fd)


def sqlite_header(header):
    if len(header) < 100 or not header.startswith(b'SQLite format 3\x00'):
        raise ValueError('backup is not an SQLite database')
    page = int.from_bytes(header[16:18], 'big')
    page = 65536 if page == 1 else page
    if page < 512 or page & (page - 1):
        raise ValueError('invalid SQLite page size')
    pages = int.from_bytes(header[28:32], 'big')
    # The in-header page count is only authoritative when "version-valid-for" matches.
    valid = header[92:96] == header[24:28]
    return page, pages if valid else 0


def write_backup(name, stream):
    """Streams a serialized database into a new root-only file; removes it if incomplete."""
    if not re.fullmatch(BACKUP_NAME, name):
        raise ValueError('invalid backup name')
    directory = layout()['backups']
    trusted_path(str(directory))
    header = stream.read(100)
    page, pages = sqlite_header(header)
    target = directory / name
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as writer:
            writer.write(header)
            shutil.copyfileobj(stream, writer)
            writer.flush()
            os.fsync(writer.fileno())
            size = writer.tell()
        if size % page or (pages and size != page * pages):
            raise ValueError('backup is truncated')
    except BaseException:
        os.unlink(target)
        raise
    return size


def load_journal(reader):
    data = json.load(reader)
    entries = data.get('entries') if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise ValueError('invalid migration journal')
    result = []
    for entry in entries:
        if (not isinstance(entry, dict) or not isinstance(entry.get('tag'), str)
                or not re.fullmatch(r'[0-9]{4}_[A-Za-z0-9_]+', entry['tag'])
                or type(entry.get('when')) is not int or entry['when'] < 0):
            raise ValueError('invalid migration journal entry')
        result.append((entry['tag'], entry['when']))
    return result


def app_journal(app):
    with os.fdopen(open_input(str(Path(app) / JOURNAL))) as reader:
        return load_journal(reader)


def new_migrations(current, candidate):
    """Counts candidate migrations the installed release lacks (all of them if unknown)."""
    entries = load_journal(sys.stdin) if candidate == '-' else app_journal(candidate)
    try:
        known = {tag for tag, _ in app_journal(current)}
    except (OSError, ValueError):
        known = set()
    return sum(1 for tag, _ in entries if tag not in known)


def migration_state(previous, latest_applied):
    """'safe' unless the database records a migration newer than `previous` knows."""
    _, path = deployment_path(previous, ('app', 'release'))
    entries = app_journal(str(path))
    latest_applied = latest_applied.strip()
    if not latest_applied:
        return 'safe'
    if not re.fullmatch(r'[0-9]{1,16}', latest_applied):
        raise ValueError('unexpected migration timestamp')
    known = max((when for _, when in entries), default=0)
    return 'safe' if int(latest_applied) <= known else 'migrated'


def archive_members(archive):
    """Yields (name, member) for regular files in a `git archive` stream, excluding local files."""
    for member in archive:
        name = member.name[:-1] if member.isdir() and member.name.endswith('/') else member.name
        path = PurePosixPath(name)
        if (not name or path.is_absolute() or '..' in path.parts or str(path) != name
                or '\\' in name or re.search(r'[\x00-\x1f\x7f]', name)):
            raise ValueError('invalid archive path')
        if excluded(path.parts) or member.isdir():
            continue
        if not member.isreg():
            # Matches the installer: snapshots contain only directories and regular files.
            raise ValueError('candidate source must contain only regular files')
        yield name, member


def export_archive(destination, stream):
    """Unpacks a candidate revision into a fresh, empty root-owned build directory."""
    _, target = deployment_path(destination, ('stage',))
    real_directory(target)
    if os.listdir(target):
        raise ValueError('candidate directory must be empty')
    installed = []
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for name, member in archive_members(archive):
            file = target / name
            file.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(fd, 'wb') as writer:
                shutil.copyfileobj(archive.extractfile(member), writer)
                os.fchmod(writer.fileno(), 0o755 if member.mode & 0o111 else 0o644)
            installed.append(name)
    if not installed:
        raise ValueError('candidate revision is empty')
    with (target / '.lou-install-files.json').open('x') as manifest:
        json.dump(installed, manifest)


def verify_export(destination, stream):
    """After the unprivileged build: every source file still matches the revision."""
    _, target = deployment_path(destination, ('stage',))
    names = []
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for name, member in archive_members(archive):
            expected = hashlib.sha256(archive.extractfile(member).read()).digest()
            with os.fdopen(open_input(str(target / name)), 'rb') as reader:
                actual = hashlib.sha256(reader.read()).digest()
                executable = bool(os.fstat(reader.fileno()).st_mode & 0o111)
            if actual != expected or executable != bool(member.mode & 0o111):
                raise ValueError('candidate source changed during the build')
            names.append(name)
    with os.fdopen(open_input(str(target / '.lou-install-files.json'))) as reader:
        if json.load(reader) != names:
            raise ValueError('candidate file manifest changed during the build')


def load_release(path):
    with os.fdopen(open_input(str(path))) as reader:
        info = json.load(reader)
    if (not isinstance(info, dict) or not isinstance(info.get('commit'), str)
            or not re.fullmatch(COMMIT, info['commit']) or type(info.get('dirty')) is not bool):
        raise ValueError('invalid release information')
    return info


def write_release(destination, commit, dirty):
    """Records the source revision of a candidate; written only after the root freeze."""
    _, target = deployment_path(destination, ('stage',))
    if not re.fullmatch(COMMIT, commit) or type(dirty) is not bool:
        raise ValueError('invalid release information')
    fd = os.open(target / RELEASE_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, 'w') as writer:
        json.dump({'commit': commit, 'dirty': dirty}, writer)


def read_release(app):
    """Returns 'commit clean|dirty' for an installed tree, or 'unknown'."""
    _, path = deployment_path(app, ('app', 'stage', 'release'))
    try:
        info = load_release(path / RELEASE_FILE)
    except (OSError, ValueError):
        return 'unknown'
    return info['commit'] + (' dirty' if info['dirty'] else ' clean')


def source_git(repo):
    # Plumbing only, with hooks and fsmonitor disabled: a checkout's own config
    # must not run programs as root, and the index is never rewritten.
    return ['git', '-c', f'safe.directory={repo}', '-c', 'core.fsmonitor=false',
            '-c', 'core.hooksPath=/dev/null', '-C', str(repo)]


def release_from(repo, destination):
    """Installer: records the checkout's HEAD (and local edits) or a snapshot's revision."""
    repo = Path(repo)
    if (repo / '.git').exists():
        git = source_git(repo)
        commit = subprocess.run(git + ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
                                capture_output=True, text=True).stdout.strip()
        if not re.fullmatch(COMMIT, commit):
            return
        # Without an index refresh, timestamp-only changes count as edits: conservative.
        dirty = subprocess.run(git + ['diff-index', '--quiet', 'HEAD', '--'],
                               capture_output=True).returncode != 0
        write_release(destination, commit, dirty)
    elif (repo / RELEASE_FILE).exists():
        info = load_release(repo / RELEASE_FILE)
        write_release(destination, info['commit'], info['dirty'])


def update_url(value):
    u = urlsplit(value)
    if (not value.startswith('https://') or u.scheme != 'https' or not u.hostname
            or u.username is not None or u.password is not None or u.query or u.fragment
            or not re.fullmatch(r'[A-Za-z0-9.-]+(?::[0-9]{1,5})?', u.netloc)
            or not re.fullmatch(r'(?:/[A-Za-z0-9._~-]+)+/?', u.path)
            or any(part in ('.', '..') for part in u.path.split('/'))):
        raise ValueError('update source must be an HTTPS Git URL without credentials')
    return value


def update_branch(value):
    if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,199}', value) or '..' in value or '//' in value
            or '/.' in value or value.endswith(('/', '.', '.lock')) or value == 'HEAD'):
        raise ValueError('invalid update branch')
    return value


def update_config(path):
    """Reads the root-controlled update source; unknown keys are rejected."""
    input_file(path)
    env = read_env(path)
    if set(env) != {'LOU_UPDATE_REMOTE', 'LOU_UPDATE_BRANCH'}:
        raise ValueError('update configuration must set exactly LOU_UPDATE_REMOTE and LOU_UPDATE_BRANCH')
    return update_url(env['LOU_UPDATE_REMOTE']), update_branch(env['LOU_UPDATE_BRANCH'])


def detect_update_source(repo):
    """Suggests the checkout's upstream as the update source (url and branch may be empty)."""
    git = source_git(Path(repo))

    def output(*args):
        return subprocess.run(git + list(args), capture_output=True, text=True).stdout.strip()
    url = branch = ''
    head = output('symbolic-ref', '-q', 'HEAD')
    if head.startswith('refs/heads/'):
        remote, _, ref = output('for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)',
                                head).partition('\0')
        if re.fullmatch(r'[A-Za-z0-9._-]+', remote) and ref.startswith('refs/heads/'):
            try:
                branch = update_branch(ref[len('refs/heads/'):])
                url = update_url(output('config', '--get', f'remote.{remote}.url'))
            except ValueError:
                pass
    return url, branch


def engine_satisfied(app, version):
    """Supports the `>=X[.Y[.Z]]` form Lou uses; anything else needs a manual update."""
    with os.fdopen(open_input(str(Path(app) / 'package.json'))) as reader:
        wanted = json.load(reader).get('engines', {}).get('node', '')
    match = re.fullmatch(r'\s*>=\s*v?([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?\s*', wanted)
    have = re.fullmatch(r'v?([0-9]+)\.([0-9]+)\.([0-9]+)', version.strip())
    if not match or not have:
        raise ValueError('unsupported Node engine requirement')
    need = tuple(int(x or 0) for x in match.groups())
    return tuple(int(x) for x in have.groups()) >= need, wanted.strip()


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
    elif action == 'env-set':
        # The value arrives on stdin, never in process arguments.
        set_env(args[0], args[1], sys.stdin.read())
    elif action == 'env-unset':
        set_env(args[0], args[1], None)
    elif action == 'spotify-redirect':
        print(spotify_redirect(args[0]))
    elif action == 'spotify-id':
        spotify_credential(sys.stdin.read().strip())
    elif action == 'spotify-verify':
        client_id, _, client_secret = sys.stdin.read().partition('\n')
        result = spotify_verify(client_id.strip(), client_secret.strip())
        # 0 accepted, 1 rejected/invalid, 2 Spotify unreachable.
        sys.exit(0 if result else 2 if result is None else 1)
    elif action == 'spotify-health':
        data = json.load(sys.stdin)
        if data.get('status') != 'ok' or not data.get('integrations', {}).get('spotify'):
            raise ValueError('Lou is not reporting Spotify as configured')
    elif action == 'health':
        data = json.load(sys.stdin)
        if data.get('status') != 'ok' or data.get('db') != 'ok':
            raise ValueError('health endpoint reports a degraded database')
    elif action == 'verify-copy':
        verify_copy(*args)
    elif action == 'move':
        move_tree(*args)
    elif action == 'remove':
        remove_tree(*args)
    elif action == 'prune-releases':
        prune_releases(int(args[0]), *args[1:])
    elif action == 'prune-backups':
        prune_backups(int(args[0]), *args[1:])
    elif action == 'backup-write':
        print(write_backup(args[0], sys.stdin.buffer))
    elif action == 'new-migrations':
        print(new_migrations(*args))
    elif action == 'migration-state':
        print(migration_state(args[0], sys.stdin.read()))
    elif action == 'export':
        export_archive(args[0], sys.stdin.buffer)
    elif action == 'verify-export':
        verify_export(args[0], sys.stdin.buffer)
    elif action == 'release-write':
        if args[2] not in ('clean', 'dirty'):
            raise ValueError('invalid release state')
        write_release(args[0], args[1], args[2] == 'dirty')
    elif action == 'release-read':
        print(read_release(args[0]))
    elif action == 'release-from':
        release_from(*args)
    elif action == 'update-config':
        print('\n'.join(update_config(args[0])))
    elif action == 'update-source':
        print('\n'.join(detect_update_source(args[0])))
    elif action == 'update-url':
        print(update_url(args[0]))
    elif action == 'update-branch':
        print(update_branch(args[0]))
    elif action == 'node-engine':
        ok, wanted = engine_satisfied(*args)
        print(wanted)
        sys.exit(0 if ok else 3)
    else:
        raise ValueError('unknown installer operation')


if __name__ == '__main__':
    try:
        main()
    except Exception as err:
        # Inputs may contain credentials; do not print exception values, except
        # for tree operations whose errors name only files in the deployment.
        print('Validation failed for ' + (sys.argv[1] if len(sys.argv) > 1 else 'operation')
              + '; no input values were logged.', file=sys.stderr)
        if len(sys.argv) > 1 and sys.argv[1] in ('freeze', 'copy', 'export', 'verify-export', 'verify-copy',
                                                 'move', 'remove', 'prune-releases', 'prune-backups'):
            print(f'Reason: {err}', file=sys.stderr)
        if len(sys.argv) > 1 and sys.argv[1] == 'validate':
            print('Use the documented production paths, an HTTPS origin, valid Lou settings, '
                  'a 32-byte base64 master key and credentials for the selected provider.', file=sys.stderr)
        elif len(sys.argv) > 1 and sys.argv[1] == 'path':
            print('System paths must be absolute, root-owned, non-writable by other users, '
                  'and free of symlinks/hard-linked files; review with an administrator.', file=sys.stderr)
        sys.exit(1)
