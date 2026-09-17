#!/usr/bin/env bash

set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <release-archive> <release-id>" >&2
  exit 2
fi

archive=$1
release_id=$2

if [[ ! -f "$archive" ]]; then
  echo "Release archive not found: $archive" >&2
  exit 2
fi

if [[ ! "$release_id" =~ ^[0-9a-f]{12}-[1-9][0-9]*$ ]]; then
  echo "Invalid release id: $release_id" >&2
  exit 2
fi

app_root="$HOME/apps/reviewflow"
release_dir="$app_root/releases/$release_id"
current_link="$app_root/current"
next_link="$app_root/.current-$release_id"
service_file="$HOME/.config/systemd/user/reviewflow.service"

if [[ -e "$release_dir" ]]; then
  echo "Release already exists: $release_dir" >&2
  exit 1
fi

if [[ ! -f "$app_root/shared/reviewflow.env" ]]; then
  echo "Missing production environment file: $app_root/shared/reviewflow.env" >&2
  exit 1
fi

mkdir -p "$release_dir" "$app_root/shared/data" "$(dirname "$service_file")"
tar -xzf "$archive" -C "$release_dir"

(
  cd "$release_dir"
  npm ci --omit=dev --ignore-scripts
)

install -m 0644 "$release_dir/deploy/reviewflow.service" "$service_file"
systemctl --user daemon-reload

previous_release=
if [[ -L "$current_link" ]]; then
  previous_release=$(readlink -f "$current_link")
fi

cleanup_next_link() {
  rm -f "$next_link"
}
trap cleanup_next_link EXIT

rollback() {
  echo "Deployment failed; rolling back ReviewFlow" >&2
  systemctl --user status reviewflow --no-pager >&2 || true
  if [[ -n "$previous_release" && -d "$previous_release" ]]; then
    ln -s "$previous_release" "$next_link"
    mv -Tf "$next_link" "$current_link"
    systemctl --user restart reviewflow
  else
    systemctl --user stop reviewflow
  fi
}

ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" "$current_link"
if ! systemctl --user restart reviewflow; then
  rollback
  exit 1
fi

healthy=false
for _ in {1..20}; do
  if curl --fail --silent --show-error \
    http://127.0.0.1:3000/api/health >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done

if [[ "$healthy" != true ]]; then
  rollback
  exit 1
fi

echo "Activated ReviewFlow release $release_id"
