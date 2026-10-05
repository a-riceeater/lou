"""Non-root installer tests. Run: python3 -B -m unittest discover -s deploy -p 'test_setup.py'."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('setup_support', DEPLOY / 'setup-support.py')
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def env(self, values):
        file = self.root / 'env'
        file.write_text(''.join(f'{k}={support.quote(v)}\n' for k, v in values.items()))
        return file

    def test_env_round_trip_and_shell_escaping(self):
        values = {'SECRET': 'quote\" apostrophe\' $HOME `id` $(id) \\ # = café', 'EMPTY': '', 'SPACE': '  x  '}
        file = self.env(values)
        self.assertEqual(support.read_env(file), values)
        # This known test fixture is sourced only to verify the emitted quoting.
        result = subprocess.check_output(['bash', '-c', 'source "$1"; printf "%s" "$SECRET"', 'test', str(file)])
        self.assertEqual(result.decode(), values['SECRET'])

    def test_env_rejects_bad_keys_duplicates_controls_and_expressions(self):
        for text in ['X=one\nX=two', 'export X=x', 'X=$(touch marker)', 'X="bad\\q"', 'X="line\nvalue"']:
            file = self.root / 'env'
            file.write_text(text)
            with self.subTest(text=text), self.assertRaises(ValueError):
                support.read_env(file)
        for value in ['line\nbreak', '\x00', '\t', '\x7f']:
            with self.assertRaises(ValueError):
                support.quote(value)

    def test_url_validation(self):
        for value in ['https://lou.example.com', 'https://localhost:443/', 'https://[::1]:443']:
            self.assertEqual(support.public_url(value), value.rstrip('/'))
        for value in ['http://localhost', 'https://', 'https://user:secret@host', 'https://a/b',
                      'https://a?x=1', 'https://a#fragment', 'https://a:99999', 'https://a b',
                      'https://a\\b', 'https://-bad.example', 'https://a..b', '//example.com',
                      'https://999.999.999.999', 'https://host:', 'HTTPS://example.com']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                support.public_url(value)

    def test_unsafe_paths_and_symlink_ancestors(self):
        for value in ['', '/', '.', '..', 'relative', '/opt/../etc', '/opt//lou', '/opt/lou/']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                support.trusted_path(value)
        (self.root / 'link').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            support.input_file(str(self.root / 'link/env'))
        with self.assertRaises(ValueError):
            support.trusted_path(str(self.root / 'link'))
        (self.root / 'regular').write_text('ok')
        support.input_file(str(self.root / 'regular'))
        with os.fdopen(support.open_input(str(self.root / 'regular'))) as file:
            self.assertEqual(file.read(), 'ok')
        for value in [str(self.root), str(self.root / 'missing'), str(self.root / '../other')]:
            with self.assertRaises(ValueError):
                support.input_file(value)
        with self.assertRaises(ValueError):
            support.open_input(str(self.root / 'link/regular'))

    @unittest.skipUnless((DEPLOY.parent / 'node_modules/tsx').is_dir() and shutil.which('node'),
                         'npm ci and Node are needed for the real Lou schema check')
    def test_actual_lou_schema_and_validator_environment(self):
        import base64
        values = {'LOU_ENV': 'production', 'LOU_HOST': '127.0.0.1', 'LOU_PORT': '8787',
                  'LOU_PUBLIC_URL': 'https://lou.example.com', 'LOU_DATA_DIR': '/var/lib/lou',
                  'LOU_DB_PATH': '/var/lib/lou/lou.db', 'LOU_SKILLS_DIR': '/opt/lou/skills',
                  'LOU_MASTER_KEY': base64.b64encode(bytes(range(32))).decode(),
                  'AI_PROVIDER': 'openai_api', 'OPENAI_API_KEY': 'test-key',
                  'NODE_OPTIONS': '--require=/unexpected/injection.js'}
        original_run = subprocess.run
        def current_user_run(command, **kwargs):
            self.assertNotIn('NODE_OPTIONS', kwargs['env'])
            self.assertEqual(kwargs.pop('user'), 'lou')
            self.assertEqual(kwargs.pop('group'), 'lou')
            self.assertEqual(kwargs.pop('extra_groups'), ['lou'])
            return original_run([shutil.which('node'), *command[1:]], **kwargs)
        with patch.object(subprocess, 'run', side_effect=current_user_run):
            support.validate_env(self.env(values), str(DEPLOY.parent))
            with self.assertRaises(ValueError):
                support.validate_env(self.env({**values, 'LOU_GMAIL_POLL_SECONDS': '0'}), str(DEPLOY.parent))
            with self.assertRaises(ValueError):
                support.validate_env(self.env({**values, 'LOU_MASTER_KEY': 'invalid'}), str(DEPLOY.parent))

    def test_trusted_paths_require_root_ownership_and_restrictive_mode(self):
        # Simulate an otherwise trusted host without requiring root privileges.
        actual = Path.stat
        def root_stat(path, **kwargs):
            mode = actual(path, **kwargs)
            fields = list(mode)
            fields[4] = 0
            fields[0] &= ~0o022
            return os.stat_result(fields)
        with patch.object(Path, 'stat', root_stat):
            support.trusted_path(str(self.root / 'not-yet-created'))
        with self.assertRaises(ValueError):
            support.trusted_path(str(self.root))

    def test_snapshot_copy_excludes_local_files_and_reruns(self):
        source, candidate, update = [self.root / n for n in ('repo', 'candidate', 'update')]
        source.mkdir()
        subprocess.run(['git', 'init', '-q', str(source)], check=True)
        (source / 'package.json').write_text('{}')
        (source / 'untracked-secret').write_text('never copied')
        (source / '.env').write_text('SECRET=never-copied')
        subprocess.run(['git', '-C', str(source), 'add', 'package.json', '.env'], check=True)
        candidate.mkdir()
        support.copy_source(str(source), str(candidate))
        self.assertFalse((candidate / 'untracked-secret').exists())
        self.assertFalse((candidate / '.env').exists())
        self.assertEqual((candidate / 'package.json').read_text(), '{}')
        (candidate / 'node_modules').mkdir()
        (candidate / 'node_modules/link').symlink_to('/etc')
        update.mkdir()
        support.copy_source(str(candidate), str(update))
        self.assertFalse((update / 'node_modules').exists())
        self.assertTrue((update / 'package.json').is_file())
        with self.assertRaises(ValueError):
            support.copy_source(str(source), str(source / 'nested'))

    def test_snapshot_rejects_links_and_manifest_escape(self):
        source, candidate = self.root / 'source', self.root / 'candidate'
        source.mkdir()
        candidate.mkdir()
        (source / 'link').symlink_to('/etc/passwd')
        manifest = source / '.lou-install-files.json'
        for files in [['link'], ['../escape'], ['/etc/passwd']]:
            manifest.write_text(json.dumps(files))
            with self.subTest(files=files), self.assertRaises(ValueError):
                support.copy_source(str(source), str(candidate))

    def test_mcp_validation_and_secret_substitution(self):
        env = self.env({'TOKEN': 'secret"with\\special'})
        mcp = self.root / 'mcp'
        server = {'id': 'sample', 'name': 'Sample', 'transport': 'http', 'url': 'https://example.com/mcp',
                  'headers': {'Authorization': '${TOKEN}'}}
        mcp.write_text(json.dumps({'servers': [server]}))
        support.validate_mcp(mcp, env)
        for changes in [{'transport': 'other'}, {'maxToolsPerRequest': True}, {'id': 'Bad'},
                        {'keywords': 'oops'}, {'url': ''}, {'headers': {'x': '${MISSING}'}}]:
            mcp.write_text(json.dumps({'servers': [{**server, **changes}]}))
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                support.validate_mcp(mcp, env)

    def test_secret_validation_error_does_not_echo_input(self):
        result = subprocess.run(['python3', '-B', str(DEPLOY / 'setup-support.py'), 'write', 'TOKEN'],
                                input='supersecret\ninvalid', text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('supersecret', result.stdout + result.stderr)

    def shell(self, code, stdin=''):
        return subprocess.run(['bash', '-c', 'source "$1"; ' + code, 'test', str(DEPLOY / 'setup.sh')],
                              input=stdin, text=True, capture_output=True)

    def test_confirmation_parsing_and_prompt(self):
        for value in ['y', 'Y', 'yes', 'YES', 'YeS']:
            self.assertEqual(self.shell('confirm test', value + '\n').returncode, 0)
        for value in ['', 'n', 'N', 'no', 'NO']:
            self.assertNotEqual(self.shell('confirm test', value + '\n').returncode, 0)
        self.assertEqual(self.shell('confirm test', 'invalid\nyes\n').returncode, 0)
        self.assertNotEqual(self.shell('confirm test', '').returncode, 0)
        self.assertEqual(self.shell('prompt result test default; printf "%s" "$result"', '\n').stdout, 'default')

    def test_check_file_detects_existing_install_and_rejects_links(self):
        file = self.root / 'existing.env'
        file.write_text('X=1')
        link = self.root / 'link'
        link.symlink_to(file)
        # Replace only root-ownership checks, keeping file/link detection real.
        prefix = 'check_path() { :; }; '
        for path, expected in [(file, 0), (self.root / 'missing', 0), (link, 1), (self.root, 1)]:
            result = self.shell(prefix + f'check_file "{path}"')
            self.assertEqual(result.returncode, expected)

    def test_failure_and_interrupt_do_not_delete_data_or_show_command(self):
        result = self.shell("OPERATION='testing failure'; trap cleanup EXIT; trap 'failure $?' ERR; false")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('testing failure', result.stderr)
        self.assertIn('preserved', result.stderr)
        result = self.shell('failure 130')
        self.assertEqual(result.returncode, 130)

    def test_service_verification_rejects_degraded_health(self):
        # No system commands: exercise verification using simulated systemd,
        # loopback responses and permissions, with the real health parser.
        mocks = '''
stat() { case "$*" in */lou.env) printf 'root:lou:640' ;; *) printf 'lou:lou:700' ;; esac; }
systemctl() { case "$1" in show) printf loaded ;; *) return 0 ;; esac; }
sleep() { :; }
curl() { printf '{"status":"degraded","db":"error"}'; }
'''
        result = self.shell(mocks + f'SUPPORT="{DEPLOY / "setup-support.py"}"; verify')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Lou installed successfully', result.stdout)

    def test_freeze_rejects_escape_without_touching_symlink_target(self):
        target = self.root / 'target'
        target.write_text('keep me')
        target.chmod(0o600)
        build = self.root / 'build'
        build.mkdir()
        (build / 'escape').symlink_to(target)
        fd = os.open(build, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        import types
        owner = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        with patch.object(support.pwd, 'getpwnam', return_value=owner), \
                patch.object(os, 'fwalk', return_value=[(str(build), [], ['escape'], fd)]):
            with self.assertRaises(ValueError):
                support.freeze_tree('/opt/.lou-build.test', 'root')
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(target.read_text(), 'keep me')


if __name__ == '__main__':
    unittest.main()
