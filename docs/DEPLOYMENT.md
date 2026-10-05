# Deployment (Ubuntu + systemd)

The server is a single Node.js process with an embedded SQLite database. Clients connect outbound over HTTPS/WSS, so desktops never expose ports. TLS is terminated by a reverse proxy or tunnel in front of the server.

## Interactive setup (recommended)

On an Ubuntu 22.04, 24.04 or 26.04 systemd host, clone Lou and run:

```bash
git clone https://github.com/a-riceeater/lou.git
cd lou
sudo ./deploy/setup.sh
```

Python 3 must already be available for the preflight checks (on a minimal image: `sudo apt-get update && sudo apt-get install python3`). The installer prompts for the public HTTPS origin, proxy trust, name/timezone, encryption key and model provider. OpenAI API keys and optional Google/Instagram credentials are read without echo. For Codex it checks a system-wide executable and authentication **as `lou`**, and offers device authentication without changing the account's `nologin` shell. It can import an MCP JSON file and securely prompt for referenced environment secrets, or install a disabled example for later editing.

`./deploy/setup.sh --help` describes the options. `--dry-run` performs read-only host/path checks and prints the plan; it does not simulate package installation or a successful build. Setup is interactive; there is no unattended mode.

The installer changes:

- Required apt packages (`ca-certificates`, `curl`, `git`, `build-essential`, `python3`); NodeSource Node 24 if `/usr/bin/node` is below 22.12 or absent. An existing compatible system Node is retained; npm 10+ is required.
- The `lou` system account, with home `/var/lib/lou` and shell `/usr/sbin/nologin`.
- Root-owned application code in `/opt/lou`, built with `npm ci` and `npm run build -w @lou/server`. Builds run as `lou` in a separate candidate directory before service downtime. Only tracked checkout files are copied (including local edits to tracked files); `.git`, dependencies, build outputs, local env files and data are excluded. An installed snapshot keeps a file manifest so setup can also be rerun from `/opt/lou`.
- `/var/lib/lou` (`lou:lou`, `0700`), containing SQLite, learned skills, and Codex state; `/etc/lou/lou.env` (`root:lou`, `0640`); optionally protected MCP files.
- The repository's hardened `/etc/systemd/system/lou.service`, enabled and restarted after installation.

It does **not** install/configure an HTTPS proxy, tunnel, DNS, firewall, or public listener. Lou stays on `127.0.0.1:8787`. Configure HTTPS as described below, forwarding WebSocket upgrades on `/ws`. A failed external health check is a warning if the local service/database are healthy; it is not proof that DNS/TLS is configured.

### Reruns, failures and backups

Rerun the same command from your updated checkout. Existing config can be kept, recreated with a protected backup, or left untouched by aborting. Recreation retains the master key, but optional settings must be entered again. If a database exists without a config, supply its original key. Unknown env-file syntax, incompatible accounts, unexpected system-path symlinks/ownership, or existing systemd drop-ins require administrator review rather than guessing.

The installer never wipes `/var/lib/lou` or recursively changes its contents. It replaces config through an atomic rename and retains config/unit backups with random `.backup.*` suffixes. The previous application is retained as `/opt/lou.previous.*`; failed builds are retained as `/opt/.lou-build.*`. Review and remove obsolete application/candidate directories manually after confirming the new installation works. These directories can consume significant disk space.

Before upgrading, back up **both** `/var/lib/lou` and `/etc/lou/lou.env`, with any MCP credentials. Keep the master key in secure backup storage: losing it makes encrypted data unreadable. Startup applies database migrations, so restoring old application code alone is not a database rollback. If setup fails after activation, use `sudo systemctl status lou` and `sudo journalctl -u lou -n 40`; restore reviewed backups as needed before rerunning. Setup does not attempt to reverse migrations or apt changes. Before activation, a stopped previous service is restarted where possible. Ctrl+C removes only invocation-created temporary configuration files; it preserves data, config backups and candidate builds.

Service management: `sudo systemctl status lou`, `sudo systemctl restart lou`, `sudo systemctl stop lou`. Logs: `sudo journalctl -u lou -f`. Pair using the command in section 7 below.

### Installer checks (no root required)

```bash
bash -n deploy/setup.sh
python3 -B -m unittest discover -s deploy -p 'test_setup.py'
shellcheck deploy/setup.sh # if installed
```

The tests exercise parsing, quoting, path/link rejection, snapshot reruns, MCP validation, cancellation and simulated health failure. They do not install packages or start systemd on the developer's machine; an actual Ubuntu deployment still needs operational verification.

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

For installer-managed snapshots, rerun `sudo ./deploy/setup.sh` from an updated checkout; `/opt/lou` has no `.git` directory. For a manual git installation:

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
