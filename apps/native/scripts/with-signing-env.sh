#!/bin/sh
# Never trace this script: the signing password must stay out of logs.
set +x
set -eu

if [ "$#" -eq 0 ]; then
  printf '%s\n' 'Usage: with-signing-env.sh command [args...]' >&2
  exit 2
fi

TAURI_SIGNING_PRIVATE_KEY="$HOME/.private-base-release/updater.key"
if [ ! -r "$TAURI_SIGNING_PRIVATE_KEY" ]; then
  printf '%s\n' 'Updater signing key file is missing or unreadable.' >&2
  exit 1
fi

if ! TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(/usr/bin/security find-generic-password \
  -s private-base-updater-key -w 2>/dev/null); then
  printf '%s\n' 'Updater signing password is unavailable from macOS Keychain.' >&2
  exit 1
fi

export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
exec "$@"
