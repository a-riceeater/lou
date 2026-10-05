#!/usr/bin/env bash
# Interactive Ubuntu installer. Application builds happen before service downtime.
set +x
set -Eeuo pipefail
umask 077

APP=/opt/lou
DATA=/var/lib/lou
CONFIG=/etc/lou
UNIT=/etc/systemd/system/lou.service
OPERATION=initialization
STAGE=
TEMP=
PREVIOUS=
WAS_ACTIVE=false
SERVICE_STOPPED=false
DEPLOYED=false
UNIT_TEMP=
COLOR='' RESET=''
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then COLOR=$'\033[32m'; RESET=$'\033[0m'; fi

info() { printf '      %s\n' "$*"; }
success() { printf '%s✓ %s%s\n' "$COLOR" "$*" "$RESET"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
error() { printf 'Error: %s\n' "$*" >&2; }
die() { error "$*"; return 1; }
run_step() { OPERATION=$2; printf '\n[%s/8] %s...\n' "$1" "$2"; }

is_yes() { case $1 in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac; }
confirm() {
    local answer
    while true; do
        read -r -p "$1 [y/N]: " answer || return 1
        is_yes "$answer" && return 0
        case $answer in ''|[nN]|[nN][oO]) return 1 ;; *) warn 'Enter yes or no.' ;; esac
    done
}
prompt() {
    local answer
    read -r -p "$2 [$3]: " answer || die 'Input ended; rerun from an interactive terminal.'
    printf -v "$1" '%s' "${answer:-$3}"
}
prompt_secret() {
    local answer
    read -r -s -p "$2: " answer || die 'Secret input ended.'
    printf '\n'
    [[ -n $answer ]] || die 'A nonempty secret is required.'
    printf -v "$1" '%s' "$answer"
}

cleanup() {
    # Only fixed files inside our root-owned mktemp directory are removed.
    if [[ -n $TEMP && $TEMP == /etc/lou/.setup.* && -d $TEMP && ! -L $TEMP ]]; then
        unlink "$TEMP/env" 2>/dev/null || true
        unlink "$TEMP/mcp" 2>/dev/null || true
        unlink "$TEMP/nodesource" 2>/dev/null || true
        rmdir -- "$TEMP" 2>/dev/null || true
    fi
    if [[ -n $UNIT_TEMP && $UNIT_TEMP == /etc/systemd/system/lou.setup.*.service && ! -L $UNIT_TEMP ]]; then
        unlink "$UNIT_TEMP" 2>/dev/null || true
    fi
}
failure() {
    local status=$1
    trap - ERR INT TERM
    error "Setup stopped during: $OPERATION (exit $status)."
    warn 'Data in /var/lib/lou has been preserved. No secret values were logged.'
    if [[ $DEPLOYED == false && -n $PREVIOUS && ! -e $APP && ! -L $APP && -d $PREVIOUS ]]; then
        if mv -T -- "$PREVIOUS" "$APP"; then PREVIOUS=''; else warn 'Could not restore the previous application path.'; fi
    fi
    if [[ $SERVICE_STOPPED == true && $DEPLOYED == false && $WAS_ACTIVE == true && -d $STAGE ]]; then
        systemctl start lou || warn 'Could not restart the previous service.'
    fi
    [[ -z $STAGE || ! -d $STAGE ]] || warn "Candidate build retained at $STAGE; review before manually removing it."
    [[ -z $PREVIOUS ]] || warn "Previous application retained at $PREVIOUS. Database migrations are not rolled back."
    [[ -z $TEMP ]] || warn 'Protected backups use /etc/lou/*.backup.* and /etc/systemd/system/lou.service.backup.*.'
    warn 'Check: sudo systemctl status lou; sudo journalctl -u lou -n 40'
    warn 'Resolve the reported issue, then rerun sudo ./deploy/setup.sh from your checkout.'
    exit "$status"
}

help() {
    printf '%s\n' 'Lou Setup — Ubuntu 22.04 / 24.04 / 26.04 with systemd' \
        'Usage: sudo ./deploy/setup.sh [--help | --dry-run]' \
        'Interactive only. --dry-run checks the host and prints the plan without changes.' \
        'Installs dependencies, builds /opt/lou, configures /etc/lou, enables lou.service.' \
        'Preserves /var/lib/lou. Does not configure TLS, DNS, proxies or firewall rules.'
}

check_path() { python3 "$SUPPORT" path "$1"; }
check_file() {
    [[ ! -L $1 && ( ! -e $1 || -f $1 ) ]] || die "Expected a regular file: $1"
    check_path "$1"
}
backup_file() {
    local backup
    check_file "$1"
    backup=$(mktemp "$1.backup.XXXXXXXX")
    install -o root -g lou -m 0640 -- "$1" "$backup"
    info "Protected backup: $backup"
}
write_value() { printf '%s' "$2" | python3 "$SUPPORT" write "$1" >> "$TEMP/env"; }
as_lou() { runuser -u lou -- env -i HOME=/var/lib/lou PATH=/usr/bin:/usr/local/bin:/bin CODEX_HOME=/var/lib/lou/.codex "$@"; }

configure() {
    run_step 5 'Configuring Lou'
    local choice=2 old_key='' key='' url='' name='' timezone='' provider='' api_key='' codex_path='' model=''
    MCP_DEST=
    : > "$TEMP/env"
    if [[ -f $CONFIG/lou.env ]]; then
        info 'Existing /etc/lou/lou.env found.'
        info '1. Keep it (validated before use)'
        info '2. Recreate it (backup first; optional settings must be reentered)'
        info '3. Abort'
        prompt choice 'Configuration choice' 1
        case $choice in
            1) install -m 0600 "$CONFIG/lou.env" "$TEMP/env" ;;
            2) old_key=$(python3 "$SUPPORT" get "$CONFIG/lou.env" LOU_MASTER_KEY) ;;
            3) die 'Cancelled before changing the existing configuration.' ;;
            *) die 'Invalid configuration choice.' ;;
        esac
    fi
    if [[ $choice == 2 ]]; then
        while true; do
            prompt url 'Public Lou URL (HTTPS origin)' https://lou.example.com
            if url=$(python3 "$SUPPORT" url "$url"); then break; fi
            warn 'Enter a valid HTTPS origin, e.g. https://lou.example.com (no path or credentials).'
        done
        write_value LOU_ENV production
        write_value LOU_HOST 127.0.0.1
        write_value LOU_PORT 8787
        write_value LOU_PUBLIC_URL "$url"
        write_value LOU_DATA_DIR "$DATA"
        write_value LOU_DB_PATH "$DATA/lou.db"
        write_value LOU_SKILLS_DIR "$APP/skills"
        write_value LOU_LOG_LEVEL info
        if confirm 'Is Lou behind a reverse proxy/tunnel (including one you will configure later)?'; then
            write_value LOU_TRUST_PROXY true
        else write_value LOU_TRUST_PROXY false; fi
        prompt name 'Your name' Owner
        while true; do
            prompt timezone 'IANA timezone' UTC
            if python3 - "$timezone" <<'PY'
import sys
from zoneinfo import ZoneInfo
try:
    ZoneInfo(sys.argv[1])
except Exception:
    sys.exit(1)
PY
            then break; fi
            warn 'Unknown timezone; use e.g. UTC or America/New_York.'
        done
        write_value LOU_USER_NAME "$name"
        write_value LOU_TIMEZONE "$timezone"
        warn 'Back up the master key securely. Losing it makes encrypted OAuth/device data unreadable.'
        if [[ -n $old_key ]]; then
            info 'Retaining the existing master key.'
            key=$old_key
        elif [[ -e $DATA/lou.db ]]; then
            warn 'Database exists: supply its original key. Generating a replacement is unsafe.'
            prompt_secret key 'Existing Lou master key'
        else
            info '1. Generate a new master key (recommended)'
            info '2. Enter an existing master key'
            prompt choice 'Master key choice' 1
            case $choice in
                1) key=$(as_lou /usr/bin/node "$STAGE/apps/server/dist/cli.js" gen-key) ;;
                2) prompt_secret key 'Lou master key' ;;
                *) die 'Invalid master key choice.' ;;
            esac
        fi
        write_value LOU_MASTER_KEY "$key"
        unset key old_key
        info 'Choose a model provider: 1. OpenAI API   2. Codex CLI'
        prompt provider 'Provider choice' 1
        case $provider in
            1)
                write_value AI_PROVIDER openai_api
                prompt_secret api_key 'OpenAI API key'
                write_value OPENAI_API_KEY "$api_key"
                unset api_key
                prompt model 'OpenAI model' gpt-6-luna
                write_value LOU_MODEL "$model"
                write_value LOU_EMBEDDING_MODEL text-embedding-3-small
                write_value LOU_TRANSCRIBE_MODEL gpt-4o-transcribe
                ;;
            2) write_value AI_PROVIDER codex_cli ;;
            *) die 'Invalid provider choice.' ;;
        esac
        write_value LOU_GMAIL_POLL_SECONDS 120
        write_value LOU_IMPROVEMENT_ENABLED true
        if confirm 'Configure Google OAuth credentials for Gmail now?'; then
            prompt name 'Google client ID' ''
            write_value GOOGLE_CLIENT_ID "$name"
            prompt_secret api_key 'Google client secret'
            write_value GOOGLE_CLIENT_SECRET "$api_key"
            unset api_key
            info 'Google Web application redirect URI: your public URL + /oauth/google/callback'
        fi
        if confirm 'Configure Instagram app credentials now?'; then
            prompt name 'Instagram app ID' ''
            write_value INSTAGRAM_APP_ID "$name"
            prompt_secret api_key 'Instagram app secret'
            write_value INSTAGRAM_APP_SECRET "$api_key"
            prompt_secret api_key 'Instagram webhook verify token'
            write_value INSTAGRAM_WEBHOOK_VERIFY_TOKEN "$api_key"
            unset api_key
        fi
        if confirm 'Configure an MCP configuration file now?'; then
            info '1. Install the example for later editing (not enabled)'
            info '2. Import and enable an existing JSON file'
            prompt choice 'MCP choice' 1
            case $choice in
                1)
                    MCP_DEST=$CONFIG/mcp.example.json
                    check_file "$MCP_DEST"
                    install -m 0600 "$REPO/deploy/mcp.example.json" "$TEMP/mcp"
                    info 'Example stays disabled until you edit it and set LOU_MCP_CONFIG.'
                    ;;
                2)
                    local input
                    prompt input 'Absolute path to MCP JSON (no symlinks)' ''
                    # Import only a regular file with no links in its ancestry.
                    python3 "$SUPPORT" input "$input"
                    python3 "$SUPPORT" import "$input" "$TEMP/mcp"
                    local refs ref
                    refs=$(python3 "$SUPPORT" refs "$TEMP/mcp")
                    while IFS= read -r ref; do
                        [[ -n $ref ]] || continue
                        if [[ -z $(python3 "$SUPPORT" get "$TEMP/env" "$ref") ]]; then
                            prompt_secret api_key "MCP environment value for $ref"
                            write_value "$ref" "$api_key"
                            unset api_key
                        fi
                    done <<< "$refs"
                    python3 "$SUPPORT" mcp "$TEMP/mcp" "$TEMP/env"
                    MCP_DEST=$CONFIG/mcp.json
                    write_value LOU_MCP_CONFIG "$MCP_DEST"
                    ;;
                *) die 'Invalid MCP choice.' ;;
            esac
        fi
    fi
    python3 "$SUPPORT" validate "$TEMP/env" "$STAGE"
    if [[ -n $(python3 "$SUPPORT" get "$TEMP/env" LOU_MCP_CONFIG) && -z $MCP_DEST ]]; then
        [[ -f $CONFIG/mcp.json ]] || die 'Configured MCP file is missing.'
        python3 "$SUPPORT" mcp "$CONFIG/mcp.json" "$TEMP/env"
    fi
    if [[ $(python3 "$SUPPORT" get "$TEMP/env" AI_PROVIDER) == codex_cli ]]; then
        OPERATION='checking Codex as the lou user'
        codex_path=$(python3 "$SUPPORT" get "$TEMP/env" CODEX_PATH)
        if [[ -z $codex_path ]]; then
            codex_path=$(PATH=/usr/bin:/usr/local/bin:/bin command -v codex || true)
        fi
        if [[ -z $codex_path ]]; then
            confirm 'Install the documented @openai/codex package system-wide with npm?' || die 'Install Codex system-wide and rerun setup.'
            PATH=/usr/bin:/bin npm install -g @openai/codex
            codex_path=$(PATH=/usr/bin:/usr/local/bin:/bin command -v codex)
        fi
        [[ $codex_path == /* && -x $codex_path ]] || die 'CODEX_PATH must be an executable absolute path.'
        case $codex_path in /home/*|/root/*|/var/lib/lou/*) die 'Codex must be installed system-wide outside home/data directories.' ;; esac
        check_path "$(readlink -f -- "$codex_path")"
        as_lou "$codex_path" --version
        as_lou "$codex_path" app-server --help >/dev/null 2>&1 || die 'Upgrade Codex: app-server support is required.'
        if ! as_lou "$codex_path" login status >/dev/null 2>&1; then
            info 'Codex needs authentication as lou, with CODEX_HOME=/var/lib/lou/.codex.'
            info "Manual command: sudo -u lou -H env CODEX_HOME=/var/lib/lou/.codex $codex_path login --device-auth"
            confirm 'Run device authentication as lou now?' || die 'Complete that login and rerun setup.'
            as_lou "$codex_path" login --device-auth || die 'Codex authentication failed; rerun after signing in as lou.'
            as_lou "$codex_path" login status >/dev/null 2>&1 || die 'Codex is still not signed in as lou.'
        fi
        # Normalize service-visible path/home when recreating; kept configs are
        # checked by the validator and must already use the same credential home.
        if ! grep -q '^CODEX_PATH=' "$TEMP/env"; then write_value CODEX_PATH "$codex_path"; fi
        if ! grep -q '^CODEX_HOME=' "$TEMP/env"; then write_value CODEX_HOME "$DATA/.codex"; fi
        success 'Codex executable and lou-user authentication verified.'
    fi
    python3 "$SUPPORT" validate "$TEMP/env" "$STAGE"
    success 'Configuration validated; secret values are hidden.'
}

deploy() {
    run_step 6 'Installing application, configuration and systemd unit'
    check_path "$APP"
    check_path "$STAGE"
    check_file "$UNIT"
    systemctl is-active --quiet lou && WAS_ACTIVE=true
    if [[ -d $APP || -e $UNIT ]]; then
        info 'Existing code/unit will be refreshed. Previous code and replaced config files will be retained.'
        confirm 'Proceed with installation and service restart?' || die 'Cancelled before service changes.'
    fi
    # Complete backups and unit staging before stopping a working service.
    [[ ! -f $CONFIG/lou.env ]] || backup_file "$CONFIG/lou.env"
    if [[ -n $MCP_DEST ]]; then
        check_file "$MCP_DEST"
        [[ ! -f $MCP_DEST ]] || backup_file "$MCP_DEST"
    fi
    [[ ! -f $UNIT ]] || backup_file "$UNIT"
    UNIT_TEMP=$(mktemp --suffix=.service /etc/systemd/system/lou.setup.XXXXXXXX)
    install -o root -g root -m 0644 "$STAGE/deploy/lou.service" "$UNIT_TEMP"
    systemd-analyze verify "$UNIT_TEMP" 2>/dev/null || die 'systemd rejected the repository unit.'
    if [[ $WAS_ACTIVE == true ]]; then
        OPERATION='stopping the existing Lou service'
        SERVICE_STOPPED=true
        systemctl stop lou
    fi
    if [[ -d $APP ]]; then
        PREVIOUS=$(mktemp -d /opt/lou.previous.XXXXXXXX)
        rmdir -- "$PREVIOUS"
        mv -T -- "$APP" "$PREVIOUS"
    fi
    OPERATION='activating the candidate application'
    mv -T -- "$STAGE" "$APP"
    DEPLOYED=true
    STAGE=
    SUPPORT=$APP/deploy/setup-support.py
    check_file "$CONFIG/lou.env"
    chown root:lou "$TEMP/env"
    chmod 0640 "$TEMP/env"
    mv -T -- "$TEMP/env" "$CONFIG/lou.env"
    if [[ -n $MCP_DEST ]]; then
        check_file "$MCP_DEST"
        chown root:lou "$TEMP/mcp"
        chmod 0640 "$TEMP/mcp"
        mv -T -- "$TEMP/mcp" "$MCP_DEST"
    fi
    mv -T -- "$UNIT_TEMP" "$UNIT"
    UNIT_TEMP=
    systemctl daemon-reload
    systemctl enable lou
    systemctl reset-failed lou
    OPERATION='starting Lou (see journalctl -u lou)'
    systemctl restart lou
}

verify() {
    run_step 7 'Verifying the service'
    local healthy=false url
    [[ $(stat -c '%U:%G:%a' "$CONFIG/lou.env") == root:lou:640 ]]
    [[ $(stat -c '%U:%G:%a' "$DATA") == lou:lou:700 ]]
    systemctl is-enabled --quiet lou
    [[ $(systemctl show lou -p LoadState --value) == loaded ]]
    for ((attempt=0; attempt<30; attempt++)); do
        if systemctl is-active --quiet lou && curl --fail --silent --max-time 2 http://127.0.0.1:8787/health | python3 "$SUPPORT" health 2>/dev/null; then
            healthy=true
            break
        fi
        sleep 1
    done
    [[ $healthy == true ]] || die 'Lou did not become healthy; inspect sudo journalctl -u lou -n 40.'
    # Require a stable service, not just one response before a crash/restart.
    sleep 3
    systemctl is-active --quiet lou || die 'Lou exited after startup.'
    url=$(python3 "$SUPPORT" get "$CONFIG/lou.env" LOU_PUBLIC_URL)
    if curl --fail --silent --max-time 10 --proto '=https' "$url/health" | python3 "$SUPPORT" health 2>/dev/null; then
        success 'External HTTPS health endpoint responded.'
    else
        warn 'Lou is healthy on 127.0.0.1:8787; the external HTTPS endpoint is not ready yet.'
    fi
    systemctl is-active --quiet lou || die 'Lou exited during verification.'
    run_step 8 'Finished'
    success 'Lou installed successfully'
    printf '\nService:  active and enabled\nData:     /var/lib/lou\nConfig:   /etc/lou/lou.env\nLogs:     sudo journalctl -u lou -f\n'
    info 'Configure your HTTPS reverse proxy/tunnel to 127.0.0.1:8787, including /ws upgrades.'
    info 'Pair your first device (code expires after 10 minutes):'
    info 'sudo -u lou -H python3 /opt/lou/deploy/setup-support.py cli pair'
    info 'Back up /var/lib/lou and /etc/lou/lou.env, including the master key.'
    [[ -z $PREVIOUS ]] || info "Previous application: $PREVIOUS (retained; remove only after reviewing)."
}

preflight() {
    run_step 1 'Checking system'
    [[ -f /etc/os-release ]] || die 'Missing /etc/os-release.'
    # This root-owned OS metadata is not an administrator-supplied env file.
    local ID='' VERSION_ID='' PRETTY_NAME=''
    # shellcheck source=/dev/null
    source /etc/os-release
    [[ $ID == ubuntu ]] || die 'Only Ubuntu is supported.'
    case $VERSION_ID in 22.04|24.04|26.04) ;; *) die "Unsupported Ubuntu release: $VERSION_ID" ;; esac
    info "$PRETTY_NAME detected"
    [[ -d /run/systemd/system ]] || die 'A running systemd host is required (not a bare container/chroot).'
    command -v python3 >/dev/null || die 'Install python3 first: sudo apt-get install python3'
    command -v flock >/dev/null || die 'The Ubuntu util-linux package (flock) is required.'
    for path in /opt /var/lib /etc/lou /etc/systemd/system "$APP"; do check_path "$path"; done
    # The data directory is service-owned, but its ancestry must be trusted.
    [[ ! -L $DATA && ( ! -e $DATA || -d $DATA ) ]] || die 'Unexpected /var/lib/lou symlink or file.'
    for path in "$DATA/lou.db" "$DATA/skills" "$DATA/.codex" "$DATA/codex-workspace"; do
        [[ ! -L $path ]] || die "Unexpected symlink in runtime path: $path"
    done
    check_file "$CONFIG/lou.env"
    check_file "$CONFIG/mcp.json"
    check_file "$UNIT"
    [[ -z $(systemctl show lou -p DropInPaths --value 2>/dev/null || true) ]] || die 'Existing lou.service drop-ins need manual administrator review before installation.'
    for path in "$APP" "$CONFIG"; do
        [[ ! -e $path || -d $path ]] || die "Expected a directory: $path"
        [[ ! -e $path ]] || info "Existing installation path: $path"
    done
    [[ -f $REPO/package-lock.json && -f $REPO/apps/server/src/cli.ts && -d $REPO/skills ]] || die 'Source is not a Lou checkout.'
    python3 - "$REPO" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
assert json.loads((p / 'package.json').read_text())['name'] == 'lou'
assert json.loads((p / 'apps/server/package.json').read_text())['name'] == '@lou/server'
PY
    if [[ -x /usr/bin/node ]] && /usr/bin/node -e 'let [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)'; then
        info "Compatible system Node: $(/usr/bin/node --version)"
        PATH=/usr/bin:/bin command -v npm >/dev/null || die 'System Node is installed but npm is missing; install matching npm before rerunning.'
        NEED_NODE=false
    else
        info 'System Node missing or older than 22.12; NodeSource 24 will be installed.'
        NEED_NODE=true
    fi
    info 'Plan: apt dependencies, staged server build, protected config, repository systemd unit.'
    info 'Lou stays on 127.0.0.1:8787. Configure external HTTPS separately.'
}

main() {
    local dry_run=false
    case ${1:-} in --help|-h) help; return ;; --dry-run) dry_run=true ;; '') ;; *) help; die 'Unknown option.' ;; esac
    [[ $# -le 1 ]] || die 'Too many arguments.'
    # Resolve the script, independent of the caller's current working directory.
    local script
    script=$(readlink -f -- "${BASH_SOURCE[0]}")
    REPO=$(cd -- "$(dirname -- "$script")/.." && pwd -P)
    SUPPORT=$REPO/deploy/setup-support.py
    local NEED_NODE
    printf 'Lou Setup\n────────────────────────────────────\n'
    preflight
    [[ $dry_run == false ]] || { info 'Dry run complete; no changes made.'; return; }
    [[ $EUID == 0 ]] || die 'Run with sudo ./deploy/setup.sh'
    [[ -t 0 ]] || die 'Run from an interactive terminal.'
    check_file /run/lou-setup.lock
    exec 9>/run/lou-setup.lock
    flock -n 9 || die 'Another Lou installer is running.'
    confirm 'Install/update Lou using this checkout?' || { info 'Setup cancelled.'; return; }
    trap cleanup EXIT
    trap 'failure $?' ERR
    trap 'warn "Setup cancelled."; failure 130' INT
    trap 'warn "Setup terminated."; failure 143' TERM

    run_step 2 'Installing dependencies and Node'
    apt-get update
    apt-get install -y ca-certificates curl git build-essential python3
    check_path "$CONFIG"
    if [[ ! -d $CONFIG ]]; then install -d -o root -g root -m 0700 "$CONFIG"; fi
    TEMP=$(mktemp -d /etc/lou/.setup.XXXXXXXX)
    if [[ $NEED_NODE == true ]]; then
        curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
            https://deb.nodesource.com/setup_24.x -o "$TEMP/nodesource"
        bash "$TEMP/nodesource"
        apt-get install -y nodejs
    fi
    /usr/bin/node -e 'let [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' || die 'Node installation did not supply Node 22.12+.'
    local npm_version
    npm_version=$(PATH=/usr/bin:/bin npm --version)
    [[ ${npm_version%%.*} -ge 10 ]] || die 'npm 10+ is required; update the system npm installation and rerun.'
    info "Node $(/usr/bin/node --version); npm $(PATH=/usr/bin:/bin npm --version)"

    run_step 3 'Preparing service identity and directories'
    if getent passwd lou >/dev/null; then
        [[ $(getent passwd lou | cut -d: -f6) == "$DATA" ]] || die 'Existing lou user must have home /var/lib/lou.'
        [[ $(getent passwd lou | cut -d: -f7) == /usr/sbin/nologin ]] || die 'Existing lou user must use /usr/sbin/nologin.'
        [[ $(id -u lou) != 0 && $(id -gn lou) == lou ]] || die 'Existing lou user/group is incompatible.'
    else
        getent group lou >/dev/null || groupadd --system lou
        useradd --system --gid lou --home-dir "$DATA" --shell /usr/sbin/nologin lou
    fi
    [[ ! -e $DATA || $(stat -c %u "$DATA") == "$(id -u lou)" || $(stat -c %u "$DATA") == 0 ]] || die 'Unexpected data-directory owner.'
    # Only the directory itself; never recursively alter database/skill contents.
    install -d -o lou -g lou -m 0700 "$DATA"
    install -d -o root -g lou -m 0750 "$CONFIG"
    if [[ -e $DATA/lou.db ]]; then
        [[ -f $DATA/lou.db ]] || die 'Existing database path is not a regular file.'
        as_lou test -r "$DATA/lou.db" && as_lou test -w "$DATA/lou.db" || die 'Existing database must be readable/writable by lou; review its ownership manually.'
    fi
    for path in "$DATA/skills" "$DATA/.codex" "$DATA/codex-workspace"; do
        if [[ -e $path ]]; then
            [[ -d $path ]] || die "Existing runtime path is not a directory: $path"
            as_lou test -r "$path" && as_lou test -w "$path" && as_lou test -x "$path" || die "Runtime directory is not accessible to lou; review manually: $path"
        fi
    done

    run_step 4 'Building a candidate application'
    STAGE=$(mktemp -d /opt/.lou-build.XXXXXXXX)
    python3 "$SUPPORT" copy "$REPO" "$STAGE"
    python3 "$SUPPORT" freeze "$STAGE" lou
    (cd -- "$STAGE"; as_lou npm ci; as_lou npm run build -w @lou/server)
    [[ -f $STAGE/apps/server/dist/index.js && -f $STAGE/apps/server/dist/cli.js && -f $STAGE/apps/server/dist/drizzle/meta/_journal.json ]] || die 'Build outputs/migrations are missing.'
    python3 "$SUPPORT" freeze "$STAGE" root
    success 'Candidate built; existing service has not been stopped.'

    configure
    deploy
    verify
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
