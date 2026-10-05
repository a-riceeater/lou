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
COLOR= RESET=
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then COLOR=$'\033[32m'; RESET=$'\033[0m'; fi

info() { printf '      %s\n' "$*"; }
success() { printf '%s✓ %s%s\n' "$COLOR" "$*" "$RESET"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
error() { printf 'Error: %s\n' "$*" >&2; }
die() { error "$*"; return 1; }
run_step() { OPERATION=$2; printf '\n[%s/8] %s...\n' "$1" "$2"; }

is_yes() { [[ ${1,,} == y || ${1,,} == yes ]]; }
confirm() {
    local answer
    while true; do
        read -r -p "$1 [y/N]: " answer || return 1
        case ${answer,,} in y|yes) return 0 ;; ''|n|no) return 1 ;; *) warn 'Enter yes or no.' ;; esac
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
}
failure() {
    local status=$1
    trap - ERR INT TERM
    error "Setup stopped during: $OPERATION (exit $status)."
    warn 'Data in /var/lib/lou has been preserved. No secret values were logged.'
    if [[ $SERVICE_STOPPED == true && $DEPLOYED == false && $WAS_ACTIVE == true ]]; then
        systemctl start lou || warn 'Could not restart the previous service.'
    fi
    [[ -z $STAGE || ! -d $STAGE ]] || warn "Candidate build retained at $STAGE; review before manually removing it."
    [[ -z $PREVIOUS ]] || warn "Previous application retained at $PREVIOUS. Database migrations are not rolled back."
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
as_lou() { runuser -u lou -- env -i HOME=/var/lib/lou PATH=/usr/local/bin:/usr/bin:/bin CODEX_HOME=/var/lib/lou/.codex "$@"; }

preflight() {
    run_step 1 'Checking system'
    [[ -f /etc/os-release ]] || die 'Missing /etc/os-release.'
    # This root-owned OS metadata is not an administrator-supplied env file.
    local ID= VERSION_ID= PRETTY_NAME=
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
    check_file "$CONFIG/lou.env"
    check_file "$CONFIG/mcp.json"
    check_file "$UNIT"
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
    install -d -o root -g root -m 0750 "$CONFIG"
    TEMP=$(mktemp -d /etc/lou/.setup.XXXXXXXX)
    if [[ $NEED_NODE == true ]]; then
        curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
            https://deb.nodesource.com/setup_24.x -o "$TEMP/nodesource"
        bash "$TEMP/nodesource"
        apt-get install -y nodejs
    fi
    /usr/bin/node -e 'let [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)'
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

    run_step 4 'Building a candidate application'
    STAGE=$(mktemp -d /opt/.lou-build.XXXXXXXX)
    python3 "$SUPPORT" copy "$REPO" "$STAGE"
    # -P traversal and chown -h change link ownership, never link destinations.
    find -P "$STAGE" -exec chown -h lou:lou -- {} +
    chmod 0755 "$STAGE"
    (cd -- "$STAGE"; as_lou npm ci; as_lou npm run build -w @lou/server)
    [[ -f $STAGE/apps/server/dist/index.js && -f $STAGE/apps/server/dist/cli.js && -f $STAGE/apps/server/dist/drizzle/meta/_journal.json ]] || die 'Build outputs/migrations are missing.'
    find -P "$STAGE" -exec chown -h root:root -- {} +
    # Strip write access for the build user and ensure readable production code.
    find -P "$STAGE" -type d -exec chmod 0755 -- {} +
    find -P "$STAGE" -type f -exec chmod a+r,go-w,u-s,g-s -- {} +
    success 'Candidate built; existing service has not been stopped.'

    configure
    deploy
    verify
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
