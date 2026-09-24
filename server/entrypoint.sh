#!/bin/sh
# The server runs as the unprivileged user `app`, and the container starts as root only for
# this: a disk that Fly or Render mounts over /data arrives owned by root, hiding the directory
# the image made for that user, and the server could not write a byte to it. So the download
# directory is handed to `app` first. A directory that is already its own is left alone, so a
# full disk is not walked through again on every start.
set -e

if [ "$(id -u)" = 0 ]; then
  if [ -n "$DOWNLOAD_DIR" ]; then
    mkdir -p "$DOWNLOAD_DIR"
    [ "$(stat -c %U "$DOWNLOAD_DIR")" = app ] || chown -R app:app "$DOWNLOAD_DIR"
  fi
  export HOME=/home/app
  exec setpriv --reuid=app --regid=app --clear-groups "$@"
fi

# Started as some other user already (docker run --user, a Kubernetes securityContext):
# nothing to hand over, and no right to.
exec "$@"
