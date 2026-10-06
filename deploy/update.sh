#!/usr/bin/env bash
# Lou updater for installer-managed Ubuntu servers. Builds the configured branch
# beside the running installation, swaps it in only after a successful build,
# verifies health and restores the previous application code on failure.
# Persistent data (/var/lib/lou) and configuration (/etc/lou) are never modified.
set +x
set -Eeuo pipefail
umask 077

UPDATER_SCRIPT=$(readlink -f -- "${BASH_SOURCE[0]}")
DEPLOY_DIR=$(dirname -- "$UPDATER_SCRIPT")
# Reuse the installer's constants, messages, prompts, path checks and build sandbox.
# shellcheck source=deploy/setup.sh
source "$DEPLOY_DIR/setup.sh"

# Fixed locations (tests source this file and point them at a temporary tree;
# no option or environment variable can change them).
OPT=/opt
SYSTEMD_DIR=/etc/systemd/system
ADMIN_UID=0
MIRROR=$UPDATE_STATE/source.git
BACKUPS=$UPDATE_STATE/backups
UPDATE_LOCK=$UPDATE_STATE/lock
FAILED_FILE=$UPDATE_STATE/failed-revision
DB=$DATA/lou.db
HEALTH_URL=http://127.0.0.1:8787/health
CANDIDATE_REF=refs/lou-update/candidate
JOURNAL=apps/server/dist/drizzle/meta/_journal.json
KEEP_RELEASES=2
KEEP_BACKUPS=3
HEALTH_SECONDS=90
STABLE_SECONDS=10
GIT_SECONDS=900

# Exit codes, for monitoring (`systemctl status lou-update`, journal alerts).
EXIT_UNCHANGED=1    # failed before activation; installed Lou unchanged
EXIT_ROLLED_BACK=2  # new release failed; previous application code restored
EXIT_ATTENTION=3    # recovery failed or was withheld; administrator needed
EXIT_DECISION=4     # unattended update declined; needs an administrator decision
EXIT_AVAILABLE=10   # --check: an update is available
EXIT_USAGE=64
EXIT_BUSY=75        # another update or setup is running (not a failure)

MODE=update
ASSUME_YES=false
PHASE=init
WORK=
STAGE=
PREVIOUS=
BACKUP_NAME=
BUILD_LOG=
REMOTE=
BRANCH=
CURRENT=
CURRENT_STATE=unknown
CANDIDATE=
RELATION=unknown
COMMITS=0
NEW_MIGRATIONS=0
WAS_ACTIVE=false
ACTIVATED_AT=
INTERRUPTED=false

# Reads a database snapshot as lou and streams it to the root-owned backup
# writer. Bytes 18-19 mark a self-contained rollback-journal file (no -wal).
BACKUP_JS='const lib = require("module").createRequire(process.cwd() + "/apps/server/package.json");
const Database = lib("better-sqlite3");
const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 10000");
const image = db.serialize();
db.close();
image[18] = 1;
image[19] = 1;
process.stdout.write(image);'
# Prints the newest migration timestamp recorded by drizzle, if any.
MIGRATION_JS='const lib = require("module").createRequire(process.cwd() + "/apps/server/package.json");
const Database = lib("better-sqlite3");
const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 10000");
const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", "__drizzle_migrations");
const row = table ? db.prepare("SELECT MAX(CAST(created_at AS INTEGER)) AS latest FROM __drizzle_migrations").get() : undefined;
db.close();
process.stdout.write(row && row.latest !== null ? String(row.latest) : "");'

update_help() {
    printf '%s\n' 'Lou Updater' \
        'Usage: sudo /opt/lou/deploy/update.sh [--check | --yes | --version | --help]' \
        '' \
        '  (no option)  Show the available update and ask before installing it.' \
        '  --check      Report whether an update is available; changes nothing (exit 10 if available).' \
        '  --yes        Update without prompting (used by lou-update.service). Declines updates' \
        '               that need a decision: local modifications, rewritten history, unit changes.' \
        '  --version    Print the installed Lou revision.' \
        '' \
        'Source: /etc/lou/update.conf. Data in /var/lib/lou and config in /etc/lou are never changed.' \
        'Automatic updates: sudo systemctl enable --now lou-update.timer' \
        'Logs: journalctl -u lou-update'
}

update_step() { OPERATION=$2; printf '\n[%s/6] %s...\n' "$1" "$2"; }
support() { python3 -I -B "$SUPPORT" "$@"; }
sanitize() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
valid_commit() { [[ $1 =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; }
short() { if valid_commit "${1:-}"; then printf '%s' "${1:0:7}"; else printf 'unknown'; fi; }
release_tag() { if valid_commit "${1:-}"; then printf '%s' "${1:0:12}"; else printf 'unknown'; fi; }
utc_stamp() { date -u +%Y%m%dT%H%M%SZ; }

# Git runs as root only against the updater's own bare mirror: clean
# environment, no hooks, HTTPS only, fsck on received objects, bounded time.
git_mirror() {
    timeout --kill-after=30 "$GIT_SECONDS" env -i PATH=/usr/bin:/bin HOME="$UPDATE_STATE" LC_ALL=C \
        GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false SSH_ASKPASS=/bin/false \
        git -c core.hooksPath=/dev/null -c core.fsmonitor=false \
            -c protocol.allow=never -c protocol.https.allow=always -c http.sslVerify=true \
            -c transfer.fsckObjects=true -c submodule.recurse=false \
            -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
            --git-dir="$MIRROR" "$@"
}

# Runs Node as lou in a transient sandbox that can reach only the data directory.
lou_node() {
    local app=$1 script=$2
    shift 2
    systemd-run --quiet --wait --pipe --collect --service-type=exec \
        -p User=lou -p Group=lou -p WorkingDirectory="$app" \
        -p Environment=PATH=/usr/bin:/bin -p Environment=HOME="$DATA" \
        -p NoNewPrivileges=yes -p PrivateTmp=yes -p PrivateDevices=yes -p PrivateNetwork=yes \
        -p ProtectSystem=strict -p ProtectHome=yes -p ReadWritePaths="$DATA" \
        -p InaccessiblePaths=-"$CONFIG" -p InaccessiblePaths=-"$UPDATE_STATE" \
        -p InaccessiblePaths=-/media -p InaccessiblePaths=-/mnt -p InaccessiblePaths=-/srv \
        -p RuntimeMaxSec=600 -- /usr/bin/node -e "$script" "$@"
}

print_version() {
    local info
    info=$(python3 -I -B "$DEPLOY_DIR/setup-support.py" release-read "$APP" 2>/dev/null || printf unknown)
    case $info in
        *' dirty') printf 'Lou revision %s (with local modifications)\n' "$(short "${info% *}")" ;;
        *' clean') printf 'Lou revision %s\n' "$(short "${info% *}")" ;;
        *) printf 'Lou revision unknown (installed before update tracking)\n' ;;
    esac
}

prepare_state() {
    check_path "$UPDATE_STATE"
    [[ -d $UPDATE_STATE ]] || install -d -o root -g root -m 0700 "$UPDATE_STATE"
    [[ $(stat -c '%u:%a' "$UPDATE_STATE") == "$ADMIN_UID:700" ]] || die "$UPDATE_STATE must be root-owned with mode 0700."
}

acquire_locks() {
    # Manual runs, the timer and setup share these locks; flock, not PID files.
    check_file "$UPDATE_LOCK"
    exec 8>>"$UPDATE_LOCK"
    if ! flock -n 8; then
        printf 'Another Lou update is already running; nothing to do.\n'
        exit "$EXIT_BUSY"
    fi
    if [[ -e $SETUP_LOCK ]]; then
        check_file "$SETUP_LOCK"
        exec 7<"$SETUP_LOCK"
        if ! flock -n 7; then
            printf 'Lou setup is running; update skipped.\n'
            exit "$EXIT_BUSY"
        fi
    fi
}

read_update_config() {
    local conf
    [[ -e $UPDATE_CONF ]] || die "No update source configured ($UPDATE_CONF). Rerun the installer from a Lou checkout to configure it."
    check_file "$UPDATE_CONF"
    conf=$(support update-config "$UPDATE_CONF") || die "Invalid $UPDATE_CONF: expected LOU_UPDATE_REMOTE (HTTPS URL) and LOU_UPDATE_BRANCH."
    REMOTE=${conf%%$'\n'*}
    BRANCH=${conf#*$'\n'}
}

read_current() {
    local info
    info=$(support release-read "$APP")
    CURRENT='' CURRENT_STATE=unknown
    if [[ $info != unknown ]]; then
        CURRENT=${info% *}
        CURRENT_STATE=${info#* }
        valid_commit "$CURRENT" || die 'Unexpected installed revision information.'
    fi
}

fetch_candidate() {
    if [[ ! -e $MIRROR && ! -L $MIRROR ]]; then
        git_mirror init --quiet --bare --template=
    fi
    [[ -d $MIRROR && ! -L $MIRROR ]] || die "Unexpected update mirror at $MIRROR."
    check_path "$MIRROR"
    # Fetch by URL into a private ref: no remote config, tags or submodules.
    if ! git_mirror fetch --quiet --no-tags --no-write-fetch-head --no-recurse-submodules \
            "$REMOTE" "+refs/heads/$BRANCH:$CANDIDATE_REF"; then
        error "Could not fetch $BRANCH from $REMOTE; update status could not be determined."
        printf 'Lou was not changed.\n' >&2
        exit "$EXIT_UNCHANGED"
    fi
    CANDIDATE=$(git_mirror rev-parse --verify --quiet "$CANDIDATE_REF^{commit}")
    valid_commit "$CANDIDATE" || die 'Fetched revision has an unexpected format.'
}

# The trust anchor is the configured HTTPS remote and branch; unattended runs
# accept fast-forwards only. Lou does not sign commits or tags yet: signature
# verification (git verify-commit with a pinned keyring) would belong here.
classify() {
    RELATION=unknown
    COMMITS=0
    if [[ -n $CURRENT && $CURRENT == "$CANDIDATE" ]]; then
        RELATION=current
    elif [[ -n $CURRENT ]] && git_mirror cat-file -e "$CURRENT^{commit}" 2>/dev/null; then
        if git_mirror merge-base --is-ancestor "$CURRENT" "$CANDIDATE"; then
            RELATION=behind
            COMMITS=$(git_mirror rev-list --count "$CURRENT..$CANDIDATE")
        elif git_mirror merge-base --is-ancestor "$CANDIDATE" "$CURRENT"; then
            RELATION=ahead
        else
            RELATION=diverged
        fi
    fi
}

previous_failure() {
    local failed=''
    [[ -f $FAILED_FILE && ! -L $FAILED_FILE ]] || return 1
    read -r failed < "$FAILED_FILE" || true
    valid_commit "$failed" && [[ $failed == "$CANDIDATE" ]]
}

# Reasons an unattended run must leave the decision to an administrator.
decision_reasons() {
    REASONS=()
    case $CURRENT_STATE in
        dirty) REASONS+=('The installed code was built from a checkout with local modifications; updating replaces them.') ;;
        unknown) REASONS+=('The installed revision is unknown (installed before update tracking).') ;;
    esac
    case $RELATION in
        diverged) REASONS+=("The installed revision is not an ancestor of $BRANCH (rewritten history or another branch).") ;;
        unknown) [[ $CURRENT_STATE == unknown ]] || REASONS+=("The installed revision $(short "$CURRENT") is not part of $BRANCH at $REMOTE.") ;;
    esac
    if previous_failure; then
        REASONS+=("Revision $(short "$CANDIDATE") failed verification before and was rolled back.")
    fi
    if [[ $WAS_ACTIVE == false ]]; then
        REASONS+=('Lou is not running; the update would start it to verify health.')
    fi
}

show_summary() {
    local subjects
    printf '\nCurrent revision:   %s' "$(short "$CURRENT")"
    [[ $CURRENT_STATE != dirty ]] || printf ' (with local modifications)'
    printf '\nAvailable revision: %s\nBranch:             %s\nSource:             %s\n' \
        "$(short "$CANDIDATE")" "$BRANCH" "$REMOTE"
    if [[ $RELATION == behind ]]; then
        printf '\nChanges:\n  %s commit(s) available\n' "$COMMITS"
        if [[ $MODE == update && $ASSUME_YES == false ]]; then
            # Commit subjects come from the network: strip terminal control bytes.
            subjects=$(git_mirror log --no-decorate --no-show-signature --format='%h %s' -n 15 \
                "$CURRENT..$CANDIDATE" | sanitize) || subjects=''
            [[ -z $subjects ]] || printf '%s\n' "$subjects" | sed 's/^/    /'
            (( COMMITS <= 15 )) || printf '    ...\n'
        fi
    fi
}

preview_migrations() {
    local count
    if count=$(git_mirror show "$CANDIDATE:apps/server/drizzle/meta/_journal.json" 2>/dev/null \
            | support new-migrations "$APP" - 2>/dev/null) && [[ $count =~ ^[0-9]+$ ]]; then
        (( count == 0 )) || printf '\nDatabase: this update adds %s migration(s), applied when Lou starts.\n          A database backup is taken first; automatic rollback is limited (see docs).\n' "$count"
    fi
}

discard_stage() {
    systemctl stop "$BUILD_UNIT.service" >/dev/null 2>&1 || true
    if [[ -n $STAGE && -d $STAGE && ! -L $STAGE ]]; then
        support remove "$STAGE" || warn "Could not remove the candidate $STAGE; review and remove it manually."
    fi
    STAGE=
}

check_builder() {
    getent passwd "$BUILDER" >/dev/null || die "The $BUILDER account is missing; rerun the installer to create it."
    [[ -d $BUILD_CACHE && ! -L $BUILD_CACHE ]] || die "$BUILD_CACHE is missing; rerun the installer."
    [[ -f $UNIT ]] || die 'lou.service is not installed; run the installer first.'
    check_path "$OPT"
    check_path "$APP"
    [[ -d $APP && ! -L $APP ]] || die "$APP is not an installed Lou tree."
    check_path "$RELEASES"
    [[ -d $RELEASES ]] || install -d -o root -g root -m 0755 "$RELEASES"
}

check_runtime() {
    local wanted npm_version node_version
    node_version=$(/usr/bin/node --version)
    if ! wanted=$(support node-engine "$STAGE" "$node_version"); then
        die "Lou $(short "$CANDIDATE") requires Node ${wanted:-in an unsupported version range}; installed: $node_version. Upgrade Node deliberately (rerun the installer); Lou was not changed."
    fi
    NPM=$(PATH=/usr/bin:/bin command -v npm) || die 'npm is missing.'
    [[ $NPM == /* ]] || die 'npm must be an absolute system path.'
    npm_version=$(PATH=/usr/bin:/bin "$NPM" --version)
    [[ ${npm_version%%.*} =~ ^[0-9]+$ && ${npm_version%%.*} -ge 10 ]] || die 'npm 10+ is required.'
}

build_failed() {
    error "Candidate $1 failed."
    if [[ -s $BUILD_LOG ]]; then
        printf '\nLast build output:\n' >&2
        tail -n 60 -- "$BUILD_LOG" | sanitize >&2
    fi
    return 1
}

check_units() {
    local unit changed=()
    for unit in lou.service lou-update.service lou-update.timer; do
        if [[ -e $SYSTEMD_DIR/$unit ]] && ! cmp -s -- "$STAGE/deploy/$unit" "$SYSTEMD_DIR/$unit"; then
            changed+=("$unit")
        fi
    done
    (( ${#changed[@]} == 0 )) && return 0
    warn "The new version changes systemd units (${changed[*]}). The updater never installs units; setup does, after review."
    if [[ $ASSUME_YES == true ]]; then
        error 'Automatic update declined: it needs an administrator. Lou was not changed.'
        info 'Run: sudo /opt/lou/deploy/update.sh, then sudo /opt/lou/deploy/setup.sh to apply the unit changes.'
        exit "$EXIT_DECISION"
    fi
    confirm 'Update application code now and rerun setup afterwards for the unit changes?' || { info 'Update cancelled; Lou was not changed.'; exit 0; }
}

prepare_candidate() {
    update_step 1 'Preparing release'
    PHASE=prepare
    check_builder
    STAGE=$(mktemp -d "$OPT/.lou-build.XXXXXXXX")
    git_mirror archive --format=tar "$CANDIDATE" | support export "$STAGE"
    [[ -f $STAGE/package-lock.json && -f $STAGE/apps/server/package.json && -f $STAGE/deploy/update.sh ]] \
        || die 'The candidate is not a Lou source tree.'
    check_runtime
    support freeze "$STAGE" "$BUILDER"
    info "Revision $(short "$CANDIDATE") prepared in $STAGE"

    update_step 2 'Installing dependencies'
    build_in_sandbox "$STAGE" "$NPM" ci >>"$BUILD_LOG" 2>&1 || build_failed 'dependency installation (npm ci)'
    info 'Dependencies installed'

    update_step 3 'Building Lou'
    build_in_sandbox "$STAGE" "$NPM" run build -w @lou/server >>"$BUILD_LOG" 2>&1 || build_failed 'build'
    support freeze "$STAGE" root
    # The unprivileged build must not have altered sources root runs later.
    git_mirror archive --format=tar "$CANDIDATE" | support verify-export "$STAGE" \
        || die 'Candidate source files changed during the build; refusing to install it.'
    [[ -f $STAGE/apps/server/dist/index.js && -f $STAGE/apps/server/dist/cli.js && -f $STAGE/$JOURNAL ]] \
        || die 'Build outputs or migrations are missing.'
    support release-write "$STAGE" "$CANDIDATE" clean
    NEW_MIGRATIONS=$(support new-migrations "$APP" "$STAGE")
    support validate "$CONFIG/lou.env" "$STAGE" \
        || die 'The new version rejects the current /etc/lou/lou.env; Lou was not changed.'
    check_units
    success 'Build successful'
}

backup_database() {
    update_step 4 'Creating pre-update database backup'
    if [[ ! -e $DB && ! -L $DB ]]; then
        info 'No database yet; nothing to back up.'
        return
    fi
    [[ -f $DB && ! -L $DB ]] || die "Unexpected database path $DB."
    check_path "$BACKUPS"
    [[ -d $BACKUPS ]] || install -d -o root -g root -m 0700 "$BACKUPS"
    local name size
    name="lou-pre-update-$(utc_stamp)-$(release_tag "$CURRENT")-${CANDIDATE:0:12}.db"
    # A consistent online snapshot, read by lou while the current Lou runs.
    size=$(lou_node "$APP" "$BACKUP_JS" "$DB" | support backup-write "$name") \
        || die 'Database backup failed; Lou was not changed.'
    BACKUP_NAME=$name
    info "Backup: $BACKUPS/$name ($size bytes)"
}

health_ok() {
    curl -q --fail --silent --noproxy '*' --max-time 3 "$HEALTH_URL" 2>/dev/null | support health 2>/dev/null
}

lou_property() { systemctl show lou -p "$1" --value 2>/dev/null || true; }

# Distinguishes "started", "answers /health" and "stays up" before success.
verify_service() {
    local attempt state pid restarts deadline=$((SECONDS + HEALTH_SECONDS))
    for ((attempt = 0; attempt < HEALTH_SECONDS && SECONDS < deadline; attempt++)); do
        state=$(lou_property ActiveState)
        if [[ $state == failed ]]; then
            warn 'lou.service failed to start.'
            return 1
        fi
        if [[ $state == active ]] && health_ok; then
            pid=$(lou_property MainPID)
            restarts=$(lou_property NRestarts)
            info "Lou started and its health endpoint responds; checking it stays up for ${STABLE_SECONDS}s"
            sleep "$STABLE_SECONDS"
            if [[ $(lou_property ActiveState) == active && $(lou_property MainPID) == "$pid" \
                    && $(lou_property NRestarts) == "$restarts" ]] && health_ok; then
                return 0
            fi
            warn 'Lou restarted or stopped responding shortly after startup.'
            return 1
        fi
        sleep 1
    done
    warn "Lou did not become healthy within ${HEALTH_SECONDS}s."
    return 1
}

activate() {
    update_step 5 'Activating release'
    PREVIOUS=$RELEASES/$(utc_stamp)-$(release_tag "$CURRENT")
    [[ ! -e $PREVIOUS && ! -L $PREVIOUS ]] || die 'A retained release with this name exists; retry in a moment.'
    PHASE=activate
    ACTIVATED_AT=$(date +%s)
    # Brief downtime starts here: graceful SIGTERM via systemd, then two renames.
    # Also stops a crash-looping service from restarting during the swap.
    systemctl stop lou
    support move "$APP" "$PREVIOUS"
    support move "$STAGE" "$APP"
    systemctl reset-failed lou >/dev/null 2>&1 || true
    systemctl start lou

    update_step 6 'Verifying Lou'
    PHASE=verify
    verify_service || rollback 'failed its health check'
}

diagnostics() {
    printf '\nDiagnostics (lou.service):\n' >&2
    systemctl status lou --no-pager --lines=0 2>&1 | head -n 8 | sanitize >&2 || true
    journalctl -u lou --no-pager -o cat -n 25 --since "@${ACTIVATED_AT:-0}" 2>&1 | sanitize >&2 || true
}

record_failure() {
    if ! { check_file "$FAILED_FILE" && printf '%s\n' "$CANDIDATE" > "$FAILED_FILE"; }; then
        warn 'Could not record the failed revision.'
    fi
}

attention() {
    printf '\n✗ %s\n\n' "$1" >&2
    printf 'Nothing was deleted. Investigate with:\n' >&2
    printf '  sudo systemctl status lou\n  sudo journalctl -u lou -n 100\n  sudo journalctl -u lou-update\n' >&2
    [[ ! -d $APP ]] || printf '  Active path:        %s\n' "$APP" >&2
    [[ -z $PREVIOUS || ! -d $PREVIOUS ]] || printf '  Previous release:   %s\n' "$PREVIOUS" >&2
    [[ -z $STAGE || ! -d $STAGE ]] || printf '  Failed candidate:   %s\n' "$STAGE" >&2
    [[ -z $BACKUP_NAME ]] || printf '  Database backup:    %s\n' "$BACKUPS/$BACKUP_NAME" >&2
    printf 'Recovery steps: /opt/lou/docs/DEPLOYMENT.md, "Recovering from a failed update".\n' >&2
    exit "$EXIT_ATTENTION"
}

# Reads the deployment state from the filesystem itself, so recovery is
# correct even if an interruption landed between two steps of activation.
rollback() {
    local reason=$1 state app=false stage=false previous=false
    PHASE=rollback
    trap '' INT TERM HUP
    trap - ERR
    set +e
    printf '\n✗ Lou %s %s.\n' "$(short "$CANDIDATE")" "$reason" >&2
    [[ -z $ACTIVATED_AT ]] || diagnostics
    # A failed candidate is not retried unattended; an interrupted run says
    # nothing about the candidate.
    [[ $INTERRUPTED == true ]] || record_failure
    [[ -d $APP && ! -L $APP ]] && app=true
    [[ -n $STAGE && -d $STAGE && ! -L $STAGE ]] && stage=true
    [[ -n $PREVIOUS && -d $PREVIOUS && ! -L $PREVIOUS ]] && previous=true
    printf '\nRestoring the previous release %s...\n' "$(short "$CURRENT")"
    systemctl stop lou || attention 'Could not stop the failed Lou service.'
    if [[ $app == true && $stage == false && $previous == true ]]; then
        if (( NEW_MIGRATIONS > 0 )); then
            state=$(database_state)
            if [[ $state != safe ]]; then
                attention "Automatic rollback withheld: the database may already use $NEW_MIGRATIONS new migration(s) that $(short "$CURRENT") does not know. Lou is stopped on the new release; restoring the backup discards changes made since it."
            fi
            info 'The database was not migrated; restoring code is safe.'
        fi
        support move "$APP" "$STAGE" || attention 'Could not move the failed release aside.'
        if ! support move "$PREVIOUS" "$APP"; then
            support move "$STAGE" "$APP" || true
            attention 'Could not restore the previous release.'
        fi
    elif [[ $app == false && $stage == true && $previous == true ]]; then
        support move "$PREVIOUS" "$APP" || attention 'Could not restore the previous release.'
    elif [[ $app == true && $stage == true && $previous == false ]]; then
        info 'Activation had not replaced the application yet.'
    else
        attention 'Unexpected deployment state; refusing to guess which release to run.'
    fi
    if [[ $WAS_ACTIVE == true ]]; then
        systemctl reset-failed lou >/dev/null 2>&1
        systemctl start lou || attention 'The previous release did not start.'
        verify_service || attention "The previous release $(short "$CURRENT") is not healthy either."
    fi
    [[ $stage == true || -d $STAGE ]] && discard_stage
    printf '\n✗ Lou %s %s.\n\n' "$(short "$CANDIDATE")" "$reason"
    printf 'The previous release %s was restored successfully.\n' "$(short "$CURRENT")"
    if [[ $WAS_ACTIVE == true ]]; then
        printf 'Lou is running normally on the previous version.\n'
    else
        printf 'Lou was not running before the update and remains stopped.\n'
    fi
    printf '\nUpdate logs:\n  journalctl -u lou-update\n'
    exit "$EXIT_ROLLED_BACK"
}

# Prints safe, migrated or unknown for the previous release and current DB.
database_state() {
    local latest
    if [[ ! -e $DB ]]; then printf 'safe'; return; fi
    if latest=$(lou_node "$PREVIOUS" "$MIGRATION_JS" "$DB") \
            && support migration-state "$PREVIOUS" <<< "$latest"; then
        return
    fi
    printf 'unknown'
}

finish() {
    local removed
    PHASE=complete
    if [[ -f $FAILED_FILE && ! -L $FAILED_FILE ]]; then unlink "$FAILED_FILE" || true; fi
    if removed=$(support prune-releases "$KEEP_RELEASES" "${PREVIOUS##*/}"); then
        [[ -z $removed ]] || info "Removed old releases: ${removed//$'\n'/ }"
    else
        warn 'Could not prune old releases; review /opt/lou-releases.'
    fi
    if [[ -n $BACKUP_NAME ]]; then
        if removed=$(support prune-backups "$KEEP_BACKUPS" "$BACKUP_NAME"); then
            [[ -z $removed ]] || info "Removed old backups: ${removed//$'\n'/ }"
        else
            warn "Could not prune old backups; review $BACKUPS."
        fi
    fi
    printf '\n'
    success 'Lou updated successfully'
    printf '  %s → %s\n\nService: active\nHealth:  healthy\n' "$(short "$CURRENT")" "$(short "$CANDIDATE")"
    printf 'Previous release: %s\n' "$PREVIOUS"
    [[ -z $BACKUP_NAME ]] || printf 'Database backup:  %s\n' "$BACKUPS/$BACKUP_NAME"
}

on_exit() {
    # Only this invocation's candidate and work files; never active code or data.
    if [[ $PHASE == prepare && -n $STAGE ]]; then discard_stage; fi
    if [[ -n $WORK && $WORK == /tmp/lou-update.* && -d $WORK && ! -L $WORK ]]; then
        unlink "$WORK/setup-support.py" 2>/dev/null || true
        unlink "$WORK/build.log" 2>/dev/null || true
        rmdir -- "$WORK" 2>/dev/null || true
    fi
}

on_failure() {
    local status=$1
    # A failing command substitution or pipeline element reports to its parent.
    (( BASH_SUBSHELL == 0 )) || exit "$status"
    trap - ERR
    case $PHASE in
        activate|verify)
            if [[ $INTERRUPTED == true ]]; then rollback 'update was interrupted'; fi
            rollback 'could not be activated' ;;
    esac
    trap - INT TERM HUP
    error "Update stopped during: ${OPERATION:-startup} (exit $status)."
    if [[ $PHASE == prepare ]]; then
        printf '\n✗ The candidate was not installed.\n\nThe currently installed Lou version was not changed%s.\n' \
            "$( [[ $WAS_ACTIVE == true ]] && printf ' and is still running' )" >&2
        printf 'See the output above for details.\n' >&2
    else
        printf 'Lou was not changed.\n' >&2
    fi
    exit "$EXIT_UNCHANGED"
}

on_signal() {
    (( BASH_SUBSHELL == 0 )) || exit "$1"
    INTERRUPTED=true
    warn 'Update interrupted.'
    on_failure "$1"
}

update_main() {
    local arg
    for arg; do
        case $arg in
            --help|-h) update_help; return 0 ;;
            --version) print_version; return 0 ;;
            --check) MODE=check ;;
            --yes|-y) ASSUME_YES=true ;;
            *) update_help >&2; error "Unknown option: $arg"; return "$EXIT_USAGE" ;;
        esac
    done
    [[ $MODE == update || $ASSUME_YES == false ]] || { error '--check and --yes cannot be combined.'; return "$EXIT_USAGE"; }
    [[ $EUID == 0 ]] || { error "Run as root: sudo $APP/deploy/update.sh"; return "$EXIT_USAGE"; }
    [[ $UPDATER_SCRIPT == "$APP/deploy/update.sh" ]] || { error "Run the installed updater: sudo $APP/deploy/update.sh"; return "$EXIT_USAGE"; }
    if [[ $MODE == update && $ASSUME_YES == false && ! -t 0 ]]; then
        error 'Interactive updates need a terminal; use --yes for unattended updates.'
        return "$EXIT_USAGE"
    fi
    # Nothing from the caller's environment or directory influences the update.
    cd /
    export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
    unset -v CDPATH GLOBIGNORE
    SUPPORT=$DEPLOY_DIR/setup-support.py
    check_path "$UPDATER_SCRIPT"
    check_path "$SUPPORT"
    check_path "$DEPLOY_DIR/setup.sh"
    WORK=$(mktemp -d /tmp/lou-update.XXXXXXXX)
    trap on_exit EXIT
    trap 'on_failure $?' ERR
    trap 'on_signal 130' INT
    trap 'on_signal 143' TERM
    trap 'on_signal 129' HUP
    # Activation renames /opt/lou, so keep this invocation's helper stable.
    install -m 0600 -- "$DEPLOY_DIR/setup-support.py" "$WORK/setup-support.py"
    SUPPORT=$WORK/setup-support.py
    BUILD_LOG=$WORK/build.log
    update_flow
}

# Checks for, prepares, activates and verifies an update. Tests drive this
# directly against a temporary deployment tree with mocked system commands.
update_flow() {
    local reason
    PHASE=check
    OPERATION='checking for updates'
    prepare_state
    acquire_locks
    printf 'Lou Updater\n────────────────────────────────────\n'
    read_update_config
    read_current
    systemctl is-active --quiet lou && WAS_ACTIVE=true
    printf 'Checking for Lou updates (%s, %s)\n' "$BRANCH" "$REMOTE"
    fetch_candidate
    classify
    show_summary
    case $RELATION in
        current)
            printf '\nLou is up to date%s.\n' "$( [[ $CURRENT_STATE != dirty ]] || printf ' (installed with local modifications)' )"
            exit 0 ;;
        ahead)
            printf '\nThe installed revision is newer than %s; nothing to update.\n' "$BRANCH"
            exit 0 ;;
    esac
    decision_reasons
    if [[ $MODE == check ]]; then
        printf '\nUpdate available.\n'
        (( ${#REASONS[@]} == 0 )) || printf 'Note: %s\n' "${REASONS[@]}"
        exit "$EXIT_AVAILABLE"
    fi
    preview_migrations
    if (( ${#REASONS[@]} > 0 )); then
        for reason in "${REASONS[@]}"; do warn "$reason"; done
        if [[ $ASSUME_YES == true ]]; then
            error 'Automatic update declined; run sudo /opt/lou/deploy/update.sh interactively to decide. Lou was not changed.'
            exit "$EXIT_DECISION"
        fi
    fi
    if [[ $ASSUME_YES == false ]]; then
        printf '\n'
        confirm 'Update Lou now?' || { info 'Update cancelled; Lou was not changed.'; exit 0; }
    fi

    prepare_candidate
    backup_database
    activate
    finish
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then update_main "$@"; fi
