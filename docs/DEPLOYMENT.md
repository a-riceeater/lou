# Deployment (Ubuntu + systemd)

The server is a single Node.js process with an embedded SQLite database. Clients connect outbound over HTTPS/WSS, so desktops never expose ports. TLS is terminated by a reverse proxy or tunnel in front of the server.

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

Required in production: `LOU_MASTER_KEY`, an `https://` `LOU_PUBLIC_URL`, and `OPENAI_API_KEY`. Keep a copy of the master key somewhere safe: without it the encrypted OAuth tokens and device keys can't be read, so you'd have to reconnect accounts and re-pair devices.

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
sudo -u lou bash -c 'set -a; . /etc/lou/lou.env; node /opt/lou/apps/server/dist/cli.js pair'
```

Enter the code and `https://lou.example.com` in the Windows app.

## Upgrading

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
sudo -u lou bash -c 'set -a; . /etc/lou/lou.env; node /opt/lou/apps/server/dist/cli.js controls agentPaused=true writeToolsDisabled=true'
sudo -u lou bash -c 'set -a; . /etc/lou/lou.env; node /opt/lou/apps/server/dist/cli.js revoke <deviceId>'
```
