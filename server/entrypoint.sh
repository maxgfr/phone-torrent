#!/bin/sh
# The server runs as the unprivileged user `app`, and the container starts as root only for
# this: a disk that Fly or Render mounts over /data arrives owned by root, hiding the directory
# the image made for that user, and the server could not write a byte to it. So the download
# directory is handed to `app` first — when it is that fresh disk's: root's, and empty. Anything
# else is someone's data, a folder of the host mounted here, and its owner is not rewritten: the
# server then says it cannot write there, and `docker run --user <uid>:<gid>` runs it as that
# folder's owner instead. One that is already `app`'s is left alone as well.
set -e

if [ "$(id -u)" = 0 ]; then
  if [ -n "$DOWNLOAD_DIR" ]; then
    mkdir -p "$DOWNLOAD_DIR"
    if [ "$(stat -c %u "$DOWNLOAD_DIR")" = 0 ] && [ -z "$(ls -A "$DOWNLOAD_DIR")" ]; then
      chown app:app "$DOWNLOAD_DIR"
    fi
  fi
  export HOME=/home/app
  exec setpriv --reuid=app --regid=app --clear-groups "$@"
fi

# Started as some other user already (docker run --user, a Kubernetes securityContext):
# nothing to hand over, and no right to.
exec "$@"
