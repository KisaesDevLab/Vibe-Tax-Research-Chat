#!/bin/sh
# Make the container's own storage usable, then drop privileges.
#
# The API writes deliverables, attachments, the skills workspace, and
# backups. Those paths are routinely mounted from the host (the appliance
# bind-mounts /opt/vibe/data/...) or from named volumes, and a mount always
# arrives with the SOURCE's ownership — usually root. A container running
# as `node` then cannot write to its own data directories:
#
#   EACCES: permission denied, mkdir '/app/storage/deliverables'
#
# Chowning in the Dockerfile only fixes paths that are NOT mounted over, so
# it cannot solve this on its own. Fixing it at runtime, as root, before
# handing off to `node`, is the standard pattern (postgres and redis images
# do the same) and means an operator never has to run chown by hand — an
# image update is the whole fix.
#
# If the container is already running unprivileged (an operator set
# `user:`), there is nothing to fix and nothing to drop: exec straight
# through and let the app surface a clear error if a path is unwritable.
set -e

APP_UID=1000
APP_GID=1000

if [ "$(id -u)" = "0" ]; then
  for dir in /app/storage/deliverables /app/attachments /app/workspaces /app/backups; do
    mkdir -p "$dir" 2>/dev/null || true
    [ -d "$dir" ] || continue
    # Recursive chown is skipped when the directory already belongs to the
    # app user, so a large attachments volume is not re-walked every boot.
    owner="$(stat -c %u "$dir" 2>/dev/null || echo -1)"
    if [ "$owner" != "$APP_UID" ]; then
      echo "entrypoint: taking ownership of $dir (was uid $owner)" >&2
      chown -R "$APP_UID:$APP_GID" "$dir" 2>/dev/null \
        || echo "entrypoint: WARNING could not chown $dir — writes there may fail" >&2
    fi
  done
  exec su-exec "$APP_UID:$APP_GID" "$@"
fi

exec "$@"
