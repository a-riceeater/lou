# Deployment (Ubuntu + systemd)

The server is a single Node.js process with an embedded SQLite database. Clients connect outbound over HTTPS/WSS, so desktops never expose ports. TLS is terminated by a reverse proxy or tunnel in front of the server.

## Interactive setup (recommended)

On an Ubuntu 22.04, 24.04 or 26.04 systemd host, clone Lou and run:

```bash
git clone https://github.com/a-riceeater/lou.git
cd lou
sudo ./deploy/setup.sh
```

Python 3 must already be available for the preflight checks (on a minimal image: `sudo apt-get update && sudo apt-get install python3`). The installer prompts for the public HTTPS origin, proxy trust, name/timezone, encryption key and model provider. OpenAI API keys and optional Google/Instagram/Spotify credentials are read without echo. For Codex it checks a system-wide executable and authentication **as `lou`**, and offers device authentication without changing the account's `nologin` shell. It can import an MCP JSON file and securely prompt for referenced environment secrets, or install a disabled example for later editing.

`./deploy/setup.sh --help` describes the options. `--dry-run` performs read-only host/path checks and prints the plan; it does not simulate package installation or a successful build. Setup is interactive; there is no unattended mode.

The installer changes:

- Required apt packages (`ca-certificates`, `curl`, `git`, `build-essential`, `python3`); NodeSource Node 24 if `/usr/bin/node` is below 22.12 or absent. An existing compatible system Node is retained; npm 10+ is required.
- The `lou` system account, with home `/var/lib/lou` and shell `/usr/sbin/nologin`.
- Root-owned application code in `/opt/lou`, built with `npm ci` and `npm run build -w @lou/server`. Builds run in a separate candidate directory before service downtime, as the `lou-build` system account inside a transient sandboxed systemd unit (see [Update trust model](#update-trust-model)). Only tracked checkout files are copied (including local edits to tracked files); `.git`, dependencies, build outputs, local env files and data are excluded. An installed snapshot keeps a file manifest so setup can also be rerun from `/opt/lou`, and `/opt/lou/.lou-release.json` records the checkout's commit (and whether it had local edits) for the updater.
- `/var/lib/lou` (`lou:lou`, `0700`), containing SQLite, learned skills, and Codex state; `/etc/lou/lou.env` (`root:lou`, `0640`); optionally protected MCP files.
- The repository's hardened `/etc/systemd/system/lou.service`, enabled and restarted after installation.
- The updater: the `lou-build` account with its npm cache `/var/cache/lou-build`, the update source `/etc/lou/update.conf`, `/var/lib/lou-updater` (root, `0700`), `/opt/lou-releases`, and the `lou-update.service`/`lou-update.timer` units. The timer is enabled only if you opt in; see [Updates](#updates).

It does **not** install/configure an HTTPS proxy, tunnel, DNS, firewall, or public listener. Lou stays on `127.0.0.1:8787`. Configure HTTPS as described below, forwarding WebSocket upgrades on `/ws`. A failed external health check is a warning if the local service/database are healthy; it is not proof that DNS/TLS is configured.

### Spotify

`sudo ./deploy/setup-spotify.sh` configures Spotify on an installed server without rerunning the full installer. It prints the exact redirect URI to register in the Spotify Developer Dashboard (`${LOU_PUBLIC_URL}/oauth/spotify/callback`) and reads the Client ID and secret, without echoing the secret. It verifies them with Spotify, writes `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` to `/etc/lou/lou.env` after a protected backup, validates the configuration, then restarts Lou and waits until `/health` reports Spotify as configured. `--remove` deletes the credentials. Your HTTPS proxy must forward `/oauth/spotify/callback` to Lou like the other OAuth callbacks. Then connect from the Windows app (Accounts → Spotify). See [INTEGRATIONS.md](INTEGRATIONS.md#spotify-web-api--spotify-connect).

### Reruns, failures and backups

Rerun the same command from your updated checkout. Existing config can be kept, recreated with a protected backup, or left untouched by aborting. Recreation retains the master key, but optional settings must be entered again. If a database exists without a config, supply its original key. Unknown env-file syntax, incompatible accounts, unexpected system-path symlinks/ownership, or existing systemd drop-ins require administrator review rather than guessing.

The installer never wipes `/var/lib/lou` or recursively changes its contents. It replaces config through an atomic rename and retains config/unit backups with random `.backup.*` suffixes. The previous application is retained as `/opt/lou.previous.*`; failed builds are retained as `/opt/.lou-build.*`. Review and remove obsolete application/candidate directories manually after confirming the new installation works. These directories can consume significant disk space.

Before upgrading, back up **both** `/var/lib/lou` and `/etc/lou/lou.env`, with any MCP credentials. Keep the master key in secure backup storage: losing it makes encrypted data unreadable. Startup applies database migrations, so restoring old application code alone is not a database rollback. If setup fails after activation, use `sudo systemctl status lou` and `sudo journalctl -u lou -n 40`; restore reviewed backups as needed before rerunning. Setup does not attempt to reverse migrations or apt changes. Before activation, a stopped previous service is restarted where possible. Ctrl+C removes only invocation-created temporary configuration files; it preserves data, config backups and candidate builds.

Service management: `sudo systemctl status lou`, `sudo systemctl restart lou`, `sudo systemctl stop lou`. Logs: `sudo journalctl -u lou -f`. Pair using the command in section 7 below.

### Installer and updater checks (no root required, Linux)

```bash
bash -n deploy/setup.sh deploy/update.sh
python3 -B -m unittest discover -s deploy -p 'test_*.py'
shellcheck -x deploy/setup.sh deploy/update.sh # if installed
```

The tests exercise parsing, quoting, path/link rejection, snapshot reruns, MCP validation, cancellation and simulated health failure, and for the updater: the path allowlist, symlink handling, release/backup retention, export tampering checks, locking, no-update and update detection, failed builds, failed health checks with rollback, withheld rollback after migrations, and interrupted activation. They run in temporary trees with mocked systemd; they do not install packages or start services. An actual Ubuntu deployment still needs operational verification.

## Updates

Lou installs an updater with the application. It fetches one configured branch, builds the new revision beside the running installation, and replaces the application only after dependencies, build and checks succeed. It never modifies `/var/lib/lou` or `/etc/lou`: the database, learned skills, `lou.env`, master key, OAuth connections, MCP configuration and paired devices are untouched (the database is only read, to back it up).

```bash
sudo /opt/lou/deploy/update.sh            # show the update and ask before installing it
sudo /opt/lou/deploy/update.sh --check    # report only; exit code 10 means an update is available
sudo /opt/lou/deploy/update.sh --yes      # no prompt (what the timer runs)
/opt/lou/deploy/update.sh --version       # installed revision
```

An interactive run shows the current and available revisions, the number of commits and their subjects, and any database migrations, then asks for confirmation:

```text
[1/6] Preparing release...          export the revision into /opt/.lou-build.*
[2/6] Installing dependencies...    npm ci (sandboxed, as lou-build)
[3/6] Building Lou...               build, verify sources, validate lou.env against the new code
[4/6] Creating pre-update database backup...
[5/6] Activating release...         stop Lou, swap directories, start Lou
[6/6] Verifying Lou...              active, /health ok, still up and not restarted after 10 s
```

Lou keeps running through steps 1-4; a network, Git, `npm ci`, build, validation or backup failure removes only that run's candidate and leaves the installed Lou running unchanged. Downtime is the graceful stop, two directory renames and startup.

### Automatic updates

Setup asks once whether to enable automatic updates (default **no**) and keeps your answer on reruns. The timer runs `lou-update.service` daily at 03:00 plus a random delay of up to two hours, and catches up after downtime.

```bash
sudo systemctl enable --now lou-update.timer     # enable
sudo systemctl disable --now lou-update.timer    # disable
systemctl list-timers lou-update.timer           # next run
systemctl status lou-update                      # last result
journalctl -u lou-update                         # update logs
sudo systemctl start lou-update                  # one unattended run now
```

Unattended runs never decide for you. With nothing new they log a short "up to date" and exit without rebuilding or restarting. They decline (exit 4, nothing changed) and wait for an interactive run when the installed code had local modifications or an unknown revision, the branch no longer contains the installed commit (rewritten history or another branch), the candidate already failed verification once, Lou is stopped, or the new version changes a systemd unit. Systemd units are only ever installed by setup: after updating the code interactively, rerun `sudo /opt/lou/deploy/setup.sh` to review and install them.

Exit codes, for monitoring: `0` updated or up to date; `1` failed before activation (Lou unchanged); `2` the new release failed and the previous one was restored; `3` recovery failed or was withheld (administrator needed); `4` declined, needs a decision; `10` `--check` found an update; `75` another update or setup is running (treated as success by the unit).

### Update source

`/etc/lou/update.conf` (root-owned) holds `LOU_UPDATE_REMOTE`, an HTTPS Git URL without credentials, and `LOU_UPDATE_BRANCH`. Setup suggests the upstream of the checkout you install from and asks you to confirm it; on reruns it keeps the existing file. Environment variables never change the source. Only public HTTPS repositories are supported: the updater does not prompt for credentials, and other transports are refused.

### Update trust model

- **Git**: the updater fetches by URL into its own root-owned bare mirror, `/var/lib/lou-updater/source.git`, with a clean environment, hooks disabled, HTTPS only (normal TLS verification), no tags or submodules, `fsck` on received objects and a time limit. The working tree of `/opt/lou` is never used; there is no `git pull`, `reset` or `clean`. The revision is exported with `git archive` and unpacked as regular files only (symlinks, hard links and escaping paths are rejected). Lou does not sign commits or releases, so trust rests on the configured HTTPS remote and branch; unattended updates accept fast-forwards only. Signature verification would slot in where the candidate is classified (`classify` in `deploy/update.sh`).
- **Build**: `npm ci` (lockfile only; never `npm update`) and the build run as `lou-build` in a transient systemd unit that can write only the candidate and its npm cache, cannot see `/etc/lou`, `/var/lib/lou`, `/var/lib/lou-updater`, home directories, `/media`, `/mnt` or `/srv`, and is stopped together with any leftover processes. Dependency lifecycle scripts therefore cannot read Lou's secrets during a build. After the build the tree becomes root-owned and every source file is compared with the revision, so a build cannot alter `deploy/update.sh` or other code that root runs later. The built code still runs as `lou` once activated: updating means trusting the branch and its locked dependencies.
- **Runtime**: `lou` never gains write access to `/opt/lou`. If the new revision needs a newer Node.js than installed, the update stops before activation; upgrade Node deliberately by rerunning setup. The updater never runs `apt`.
- **Updater unit**: root, but sandboxed: no access to home directories, `/media`, `/mnt` or `/srv`; `/var/lib/lou` and `/etc/lou` are read-only; writes are limited to `/opt` and its state directory, with a reduced capability set. Database reads run as `lou` in their own transient unit without network access.
- **Concurrency**: one `flock` lock in `/var/lib/lou-updater` serializes manual runs, the timer and setup.

### Database migrations, backups and rollback

Lou applies pending Drizzle migrations at startup, in a single transaction. Older code does not refuse a newer schema; it ignores migrations it does not know, which can leave it misreading the data. So:

- Before activation the updater takes a consistent online SQLite backup (read as `lou` while Lou runs) into `/var/lib/lou-updater/backups/lou-pre-update-<time>-<old>-<new>.db` (root, `0600`). The update stops if the backup fails. The three newest updater backups are kept; other files there are never touched.
- If the new release fails to start, crashes, restarts, or fails `/health` within 90 seconds, the updater stops it and restores the previous application code. If the update added migrations, it first checks the database: when the new migrations were **not** applied (the transaction rolled back), restoring code is safe and proceeds; when they were, or this cannot be determined, **rollback is withheld**: Lou stays stopped on the new release and the updater prints the paths below (exit 3).
- The database is never restored automatically; that would discard writes made since the backup.
- The previous release and one more are kept in `/opt/lou-releases/` after a successful update; older ones there are removed. A failed candidate is recorded in `/var/lib/lou-updater/failed-revision` and not retried unattended.

### Recovering from a failed update

The updater prints the paths involved. To return to the previous release after a withheld rollback (this discards database changes made since the backup):

```bash
sudo systemctl stop lou
sudo mv -T /opt/lou /opt/lou-releases/failed-$(date +%s)        # keep the failed release for review
sudo mv -T /opt/lou-releases/<previous release> /opt/lou
sudo install -o lou -g lou -m 0600 /var/lib/lou-updater/backups/<backup>.db /var/lib/lou/lou.db
sudo rm -f /var/lib/lou/lou.db-wal /var/lib/lou/lou.db-shm       # stale journal of the replaced database
sudo systemctl start lou
```

Alternatively fix forward: once a corrected revision is on the branch, run `sudo /opt/lou/deploy/update.sh`. Investigate with `sudo journalctl -u lou -n 100` and `journalctl -u lou-update`. If `/opt/lou` is missing after an interruption, the previous release is in `/opt/lou-releases/`; rename the newest entry back to `/opt/lou`.

## Manual installation (advanced fallback)

## 1. Install Node.js and build tools

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git build-essential python3
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

(`build-essential`/`python3` are only needed if a prebuilt `better-sqlite3` binary is unavailable for your platform.)

## 2. Create the service user and directories

```bash
sudo useradd --system --home /var/lib/lou --shell /usr/sbin/nologin lou
sudo mkdir -p /opt/lou /var/lib/lou /etc/lou
sudo chown lou:lou /var/lib/lou
sudo chmod 700 /var/lib/lou
```

## 3. Get and build the code

```bash
sudo git clone https://github.com/<you>/lou.git /opt/lou
cd /opt/lou
sudo npm ci
sudo npm run build -w @lou/server
```

The bundle is `apps/server/dist/` (with migrations in `dist/drizzle/`). Built-in skills are read from `/opt/lou/skills`.

## 4. Configure

```bash
sudo cp deploy/lou.env.example /etc/lou/lou.env
sudo chown root:lou /etc/lou/lou.env && sudo chmod 640 /etc/lou/lou.env
node apps/server/dist/cli.js gen-key        # paste into LOU_MASTER_KEY
sudoedit /etc/lou/lou.env
```

Required in production: `LOU_MASTER_KEY`, an `https://` `LOU_PUBLIC_URL`, and a model provider: `OPENAI_API_KEY`, or `AI_PROVIDER=codex_cli` with Codex signed in as the `lou` user (see [MODEL_PROVIDERS.md](MODEL_PROVIDERS.md#running-under-systemd-ubuntu)). Keep a copy of the master key somewhere safe: without it the encrypted OAuth tokens and device keys can't be read, so you'd have to reconnect accounts and re-pair devices.

Optional: copy `deploy/mcp.example.json` to `/etc/lou/mcp.json` and set `LOU_MCP_CONFIG`.

## 5. HTTPS in front

Any reverse proxy works; the server listens on `127.0.0.1:8787`. Example with Caddy (automatic certificates):

```caddyfile
lou.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

WebSocket upgrades on `/ws` are proxied automatically by Caddy. With nginx, add `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` and a long `proxy_read_timeout`. A tunnel (e.g. Cloudflare Tunnel or Tailscale Funnel) works too. Set `LOU_TRUST_PROXY=true` when behind a proxy.

## 6. Install the systemd service

```bash
sudo cp deploy/lou.service /etc/systemd/system/lou.service
sudo systemctl daemon-reload
sudo systemctl enable --now lou
systemctl status lou
curl -s https://lou.example.com/health
```

Logs: `journalctl -u lou -f`. Restarts happen automatically on failure (`Restart=on-failure`); `systemctl stop lou` sends SIGTERM and the server drains connections and closes the database (15 s grace).

The unit is hardened (`ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, only `/var/lib/lou` writable). It changes nothing else on the machine.

## 7. Pair your first device

```bash
cd /opt/lou
sudo -u lou -H python3 /opt/lou/deploy/setup-support.py cli pair
```

Enter the code and `https://lou.example.com` in the Windows app.
The code is valid for 10 minutes. The Python launcher parses the environment file as data, without sourcing it or exposing secrets in process arguments; it uses the same database and master key as the service. Supported env syntax is one assignment per line with plain, single-quoted or double-quoted values; use `LOU_USER_NAME="Your Name"` for spaces, and avoid shell expressions or multiline values.

## Upgrading

For installer-managed snapshots, use the [updater](#updates) (`sudo /opt/lou/deploy/update.sh`), or rerun `sudo ./deploy/setup.sh` from an updated checkout; `/opt/lou` has no `.git` directory. Installations made before the updater existed get it by rerunning the current setup from an updated checkout once: it keeps `/var/lib/lou` and your configuration, records the installed revision, installs the updater and asks whether to enable automatic updates. For a manual git installation (the updater does not support these):

```bash
cd /opt/lou
sudo git pull
sudo npm ci
sudo npm run build -w @lou/server
sudo systemctl restart lou
```

Migrations apply on startup. Runs that were paused for approval survive restarts; runs that were mid-step are marked failed with a clear message.

## Backups

Back up `/var/lib/lou/` (SQLite database and learned skill exports) and `/etc/lou/lou.env`. For a consistent online copy:

```bash
sudo -u lou sqlite3 /var/lib/lou/lou.db ".backup '/var/lib/lou/backup.db'"
```

## Emergency controls

From any signed-in device (**Settings**), from the tray menu (**Pause assistant**), or on the server:

```bash
sudo -u lou -H python3 /opt/lou/deploy/setup-support.py cli controls agentPaused=true writeToolsDisabled=true
sudo -u lou -H python3 /opt/lou/deploy/setup-support.py cli revoke <deviceId>
```
