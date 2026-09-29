#!/usr/bin/env bash
# Install (or update to) a release of the publication recovery worker on the Ubuntu 24.04 VM.
#
#   sudo bash install.sh /tmp/prw-<sha>.tar.gz <sha>             # first install (not started)
#   sudo bash install.sh /tmp/prw-<sha>.tar.gz <sha> --restart   # update an enabled worker in place
#
# The tarball is `git archive` of the REPOSITORY ROOT (see README), built on a trusted machine and copied over the
# EXISTING restricted SSH -- the VM never holds Git credentials. Releases are immutable, self-contained directories
# under /opt/publication-recovery/releases/<sha> (their own node_modules), so rollback.sh restores code AND deps by
# flipping the /opt/publication-recovery/app symlink. The worker's ONLY npm dependency is `pg` (verified import
# closure); its WHOLE dependency closure is installed at the exact versions pinned in the release's package-lock.json.
# This script NEVER writes secrets and NEVER starts publication: the env file is created empty (observe-only).
set -euo pipefail

TARBALL="${1:?usage: install.sh <tarball> <sha> [--restart]}"
SHA="${2:?usage: install.sh <tarball> <sha> [--restart]}"
[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || { echo "STOP: sha must be hex"; exit 2; }
[[ -f "$TARBALL" ]] || { echo "STOP: tarball not found"; exit 2; }
BASE=/opt/publication-recovery
REL="$BASE/releases/$SHA"
ENV_DIR=/etc/publication-recovery
STATE_DIR=/var/lib/publication-recovery
NODE=/usr/bin/node   # the interpreter the systemd unit runs

# 1) Node 24 at the path the unit uses (the workflows pin Node 24). Refuse to continue otherwise.
if [[ ! -x "$NODE" ]] || [[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" != "24" ]]; then
  echo "STOP: Node 24 is required at $NODE (install it from NodeSource: https://github.com/nodesource/distributions)."; exit 2
fi
command -v npm >/dev/null 2>&1 || { echo "STOP: npm not found (it ships with the NodeSource nodejs package)"; exit 2; }

# 2) Swap guard for the 1 GB Micro (bounded headroom for the one reconciler child; created once).
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "created 2G swapfile"
fi

# 3) Service user + directories.
id prw >/dev/null 2>&1 || useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin prw
install -d -o root -g root -m 0755 "$BASE" "$BASE/releases"
install -d -o prw -g prw -m 0750 "$STATE_DIR"
install -d -o root -g prw -m 0750 "$ENV_DIR"
if [[ ! -f "$ENV_DIR/worker.env" ]]; then
  install -o root -g prw -m 0640 /dev/null "$ENV_DIR/worker.env"
  echo "created EMPTY $ENV_DIR/worker.env (fill it with: sudoedit $ENV_DIR/worker.env -- see worker.env.example)"
fi
chmod 0640 "$ENV_DIR/worker.env"; chown root:prw "$ENV_DIR/worker.env"

# 4) Build the release in a STAGING directory; it becomes $REL only after it is complete and validated. A release dir
#    without the .complete marker is a leftover of an interrupted/invalid install and is rebuilt.
if [[ -d "$REL" && ! -f "$REL/.complete" ]]; then echo "removing incomplete release dir $REL"; rm -rf "$REL"; fi
if [[ ! -d "$REL" ]]; then
  STAGE="$(mktemp -d "$BASE/releases/.staging-$SHA-XXXXXX")"
  NPMTMP="$(mktemp -d)"
  trap 'rm -rf "$STAGE" "$NPMTMP"' EXIT
  tar -xzf "$TARBALL" -C "$STAGE"
  if [[ ! -f "$STAGE/sales-dashboard-live/scripts/worker/publication-recovery-worker.mjs" || ! -f "$STAGE/sales-dashboard-live/package-lock.json" ]]; then
    echo "STOP: the tarball must be 'git archive' of the REPOSITORY ROOT (it must contain sales-dashboard-live/scripts/worker/ and sales-dashboard-live/package-lock.json)"; exit 2
  fi
  # The pg dependency closure at the lockfile's exact versions (optional deps skipped; pg does not need them).
  DEPS="$("$NODE" -e '
    const lock = require(process.argv[1]).packages || {};
    const out = new Map();
    const visit = (from, name) => {
      let key = null;
      for (let dir = from; ; dir = dir.replace(/\/?node_modules\/[^/]+$/, "") || "") {
        const k = (dir ? dir + "/" : "") + "node_modules/" + name;
        if (lock[k]) { key = k; break; }
        if (!dir) break;
      }
      if (!key) throw new Error("lockfile has no entry for " + name);
      const v = lock[key].version;
      if (out.has(name)) { if (out.get(name) !== v) throw new Error("conflicting versions for " + name); return; }
      out.set(name, v);
      for (const d of Object.keys(lock[key].dependencies || {})) visit(key, d);
    };
    visit("", "pg");
    console.log([...out].map(([n, v]) => n + "@" + v).join(" "));
  ' "$STAGE/sales-dashboard-live/package-lock.json")"
  [[ "$DEPS" =~ (^|\ )pg@[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "STOP: could not resolve the pg closure from the lockfile"; exit 2; }
  # shellcheck disable=SC2086
  npm install --prefix "$NPMTMP" --no-save --no-package-lock --ignore-scripts --no-audit --no-fund --omit=optional $DEPS >/dev/null
  mv "$NPMTMP/node_modules" "$STAGE/node_modules"
  # Every installed package must be exactly the pinned version (no floating transitive dependency).
  "$NODE" -e '
    const [root, list] = [process.argv[1], process.argv[2].split(" ")];
    for (const spec of list) {
      const i = spec.lastIndexOf("@"); const name = spec.slice(0, i), want = spec.slice(i + 1);
      const got = require(root + "/node_modules/" + name + "/package.json").version;
      if (got !== want) { console.error("STOP: " + name + " installed " + got + " but the lockfile pins " + want); process.exit(2); }
    }
  ' "$STAGE" "$DEPS"
  chown -R root:root "$STAGE"; chmod -R go-w "$STAGE"; chmod 0755 "$STAGE"
  touch "$STAGE/.complete"
  mv -T "$STAGE" "$REL"
  rm -rf "$NPMTMP"; trap - EXIT
  echo "built release $SHA with: $DEPS"
fi

# 5) Activate: record the previous release for rollback (never the release being (re)installed), flip the symlink
#    atomically, write the version the heartbeat reports, (re)install the unit.
CUR="$(readlink -f "$BASE/app" 2>/dev/null || true)"
if [[ -n "$CUR" && "$CUR" != "$(readlink -f "$REL")" ]]; then echo "$CUR" > "$STATE_DIR/previous-release"; fi
ln -sfn "$REL" "$BASE/app.new" && mv -Tf "$BASE/app.new" "$BASE/app"
echo "$SHA" > "$STATE_DIR/active-release"
printf 'PRW_VERSION=%s\n' "$SHA" > "$ENV_DIR/version.env"; chown root:prw "$ENV_DIR/version.env"; chmod 0640 "$ENV_DIR/version.env"
install -o root -g root -m 0644 "$REL/sales-dashboard-live/deploy/publication-recovery/publication-recovery.service" /etc/systemd/system/publication-recovery.service
systemctl daemon-reload
if [[ "${3:-}" == "--restart" ]] && systemctl is-enabled --quiet publication-recovery 2>/dev/null; then
  systemctl restart publication-recovery
  echo "installed + restarted release $SHA"
else
  echo "installed release $SHA. NOT started. Next (see README): fill the env file, run --check-config, then: systemctl enable --now publication-recovery"
fi
