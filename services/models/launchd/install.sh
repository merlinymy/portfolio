#!/bin/sh
# Installs the model server as a launchd agent: macOS starts it when you log in and starts it again
# whenever it stops. Run it on the Mac that serves the site, after `uv sync` and one run of
# speak.py (which downloads the models, since the agent starts offline).
#
#   sh services/models/launchd/install.sh            # install, or reinstall after changes
#   sh services/models/launchd/install.sh --remove   # stop it and remove it
#
# Log: ~/Library/Logs/merlinyang-models.log
set -eu

label=com.merlinyang.models
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
dest="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

launchctl bootout "$domain/$label" 2>/dev/null || true
if [ "${1:-}" = "--remove" ]; then
  rm -f "$dest"
  echo "removed $label"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s#@REPO@#$repo#g" -e "s#@HOME@#$HOME#g" "$here/$label.plist" > "$dest"
launchctl bootstrap "$domain" "$dest"
echo "installed $label: it answers on http://127.0.0.1:8790/health once the models load (about 5 s)"
