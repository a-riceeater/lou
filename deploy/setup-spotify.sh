#!/usr/bin/env bash
# Interactive Spotify setup for an installed Lou server: shows the exact redirect
# URI to register, verifies the app credentials with Spotify, stores them in
# /etc/lou/lou.env (backed up first) and restarts Lou. Secrets never appear in
# process arguments or output.
set +x
set -Eeuo pipefail
umask 077

SCRIPT=$(readlink -f -- "${BASH_SOURCE[0]}")
DEPLOY_DIR=$(dirname -- "$SCRIPT")
# Reuse the installer's prompts, path checks and protected backups.
# shellcheck source=deploy/setup.sh
source "$DEPLOY_DIR/setup.sh"
SUPPORT=$DEPLOY_DIR/setup-support.py
ENV_FILE=$CONFIG/lou.env
DASHBOARD=https://developer.spotify.com/dashboard

spotify_help() {
    printf '%s\n' 'Lou Spotify Setup' \
        'Usage: sudo ./deploy/setup-spotify.sh [--help | --remove]' \
        'Configures SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in /etc/lou/lou.env and restarts Lou.' \
        '--remove deletes them (connected accounts then need setup again).' \
        'Alternative: in the Windows app, Accounts → Spotify → Set up.'
}

spotify_cleanup() {
    if [[ -n $TEMP && $TEMP == /etc/lou/.setup.* && -d $TEMP && ! -L $TEMP ]]; then
        unlink "$TEMP/env" 2>/dev/null || true
        rmdir -- "$TEMP" 2>/dev/null || true
    fi
}

spotify_failure() {
    local status=$1
    trap - ERR INT TERM
    error "Spotify setup stopped during: $OPERATION (exit $status)."
    warn 'No secret values were logged. /etc/lou/lou.env is unchanged unless a backup path was printed above.'
    exit "$status"
}

instructions() {
    local redirect=$1
    printf '\nIn the Spotify Developer Dashboard (%s):\n' "$DASHBOARD"
    info '1. Create app. Name it "Lou"; when asked which APIs you will use, select "Web API".'
    info '2. Add this Redirect URI exactly (Edit settings → Redirect URIs):'
    printf '\n         %s\n\n' "$redirect"
    info '3. Under User Management, add the Spotify account(s) Lou should control.'
    info '   Development Mode apps allow up to 5 users, and the app owner needs Spotify Premium.'
    info '4. Open Basic Information and copy the Client ID and Client secret.'
    printf '\n'
}

read_credentials() {
    local result
    while true; do
        prompt CLIENT_ID 'Spotify Client ID' ''
        if ! printf '%s' "$CLIENT_ID" | python3 "$SUPPORT" spotify-id 2>/dev/null; then
            warn 'That does not look like a Client ID (letters and digits, from Basic Information).'
            continue
        fi
        prompt_secret CLIENT_SECRET 'Spotify Client secret'
        OPERATION='verifying the credentials with Spotify'
        result=0
        printf '%s\n%s' "$CLIENT_ID" "$CLIENT_SECRET" | python3 "$SUPPORT" spotify-verify 2>/dev/null || result=$?
        case $result in
            0) success 'Spotify accepted the app credentials.'; return ;;
            2)
                warn 'Spotify could not be reached to verify the credentials.'
                confirm 'Save them anyway?' && return
                ;;
            *) warn 'Spotify rejected these credentials. Copy both values again from Basic Information.' ;;
        esac
        unset CLIENT_SECRET
    done
}

restart_and_check() {
    local healthy=false
    OPERATION='restarting Lou (see journalctl -u lou)'
    systemctl restart lou
    for ((attempt=0; attempt<30; attempt++)); do
        if curl --fail --silent --noproxy '*' --max-time 2 http://127.0.0.1:8787/health | python3 "$SUPPORT" "$1" 2>/dev/null; then
            healthy=true
            break
        fi
        sleep 1
    done
    [[ $healthy == true ]] || die 'Lou did not come back healthy; inspect sudo journalctl -u lou -n 40.'
}

spotify_main() {
    local mode=configure redirect current
    case ${1:-} in --help|-h) spotify_help; return ;; --remove) mode=remove ;; '') ;; *) spotify_help; die 'Unknown option.' ;; esac
    [[ $# -le 1 ]] || die 'Too many arguments.'
    printf 'Lou Spotify Setup\n────────────────────────────────────\n'
    [[ $EUID == 0 ]] || die 'Run with sudo ./deploy/setup-spotify.sh'
    [[ -t 0 ]] || die 'Run from an interactive terminal.'
    [[ -f $ENV_FILE ]] || die 'Lou is not installed here (no /etc/lou/lou.env). Run sudo ./deploy/setup.sh first.'
    command -v flock >/dev/null || die 'The Ubuntu util-linux package (flock) is required.'
    check_file "$ENV_FILE"
    check_file /run/lou-setup.lock
    exec 9>/run/lou-setup.lock
    flock -n 9 || die 'Another Lou installer is running.'
    trap spotify_cleanup EXIT
    trap 'spotify_failure $?' ERR
    trap 'warn "Setup cancelled."; spotify_failure 130' INT
    trap 'warn "Setup terminated."; spotify_failure 143' TERM

    OPERATION='reading the current configuration'
    TEMP=$(mktemp -d /etc/lou/.setup.XXXXXXXX)
    install -m 0600 "$ENV_FILE" "$TEMP/env"
    redirect=$(python3 "$SUPPORT" spotify-redirect "$TEMP/env")
    current=$(python3 "$SUPPORT" get "$TEMP/env" SPOTIFY_CLIENT_ID)

    if [[ $mode == remove ]]; then
        [[ -n $current ]] || { info 'Spotify credentials are not set in /etc/lou/lou.env; nothing to remove.'; return; }
        confirm 'Remove the Spotify app credentials from /etc/lou/lou.env?' || { info 'Nothing changed.'; return; }
        python3 "$SUPPORT" env-unset "$TEMP/env" SPOTIFY_CLIENT_ID
        python3 "$SUPPORT" env-unset "$TEMP/env" SPOTIFY_CLIENT_SECRET
    else
        instructions "$redirect"
        if [[ -n $current ]]; then
            info "Currently configured Client ID: …${current: -4}"
            confirm 'Replace the existing Spotify credentials?' || { info 'Nothing changed.'; return; }
        fi
        read_credentials
        OPERATION='writing the new configuration'
        printf '%s' "$CLIENT_ID" | python3 "$SUPPORT" env-set "$TEMP/env" SPOTIFY_CLIENT_ID
        printf '%s' "$CLIENT_SECRET" | python3 "$SUPPORT" env-set "$TEMP/env" SPOTIFY_CLIENT_SECRET
        unset CLIENT_SECRET
    fi

    OPERATION='validating the configuration with Lou'
    python3 "$SUPPORT" validate "$TEMP/env" "$APP"
    backup_file "$ENV_FILE"
    chown root:lou "$TEMP/env"
    chmod 0640 "$TEMP/env"
    mv -T -- "$TEMP/env" "$ENV_FILE"

    if [[ $mode == remove ]]; then
        restart_and_check health
        success 'Spotify credentials removed; Lou restarted.'
        return
    fi
    restart_and_check spotify-health
    success 'Spotify is configured and Lou restarted.'
    info 'Next: in the Lou Windows app open Accounts → Spotify → Connect Spotify and sign in.'
    info "If Spotify reports INVALID_CLIENT: Invalid redirect URI, register exactly: $redirect"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then spotify_main "$@"; fi
