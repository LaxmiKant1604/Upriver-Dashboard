#!/usr/bin/env bash
# Roll the worker back.
#   sudo bash rollback.sh release   # flip /opt/publication-recovery/app back to the previous release + restart
#   sudo bash rollback.sh disable   # stop + disable the worker entirely (GitHub reconcilers/scheduler are unaffected)
# The DB-side kill switch (no restart needed) is: update public.publication_recovery_control set enabled=false ...
set -euo pipefail
BASE=/opt/publication-recovery
STATE_DIR=/var/lib/publication-recovery
case "${1:-}" in
  release)
    PREV="$(cat "$STATE_DIR/previous-release" 2>/dev/null || true)"
    [[ -n "$PREV" && -d "$PREV" ]] || { echo "STOP: no previous release recorded"; exit 2; }
    [[ -f "$PREV/.complete" ]] || { echo "STOP: $PREV is not a complete release"; exit 2; }
    CUR="$(readlink -f "$BASE/app")"
    ln -sfn "$PREV" "$BASE/app.new" && mv -Tf "$BASE/app.new" "$BASE/app"
    echo "$CUR" > "$STATE_DIR/previous-release"
    basename "$PREV" > "$STATE_DIR/active-release"
    # The heartbeat/health/--check-config report the RUNNING release (each release carries its own node_modules).
    printf 'PRW_VERSION=%s\n' "$(basename "$PREV")" > /etc/publication-recovery/version.env
    chown root:prw /etc/publication-recovery/version.env; chmod 0640 /etc/publication-recovery/version.env
    install -o root -g root -m 0644 "$PREV/sales-dashboard-live/deploy/publication-recovery/publication-recovery.service" /etc/systemd/system/publication-recovery.service
    systemctl daemon-reload
    systemctl restart publication-recovery
    echo "rolled back to $(basename "$PREV")"
    ;;
  disable)
    systemctl disable --now publication-recovery
    echo "worker stopped + disabled"
    ;;
  *) echo "usage: rollback.sh release|disable"; exit 2 ;;
esac
