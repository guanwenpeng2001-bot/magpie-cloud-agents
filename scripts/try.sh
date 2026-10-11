#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$root/.sandbox"
sandbox=$(mktemp -d "$root/.sandbox/plugin.XXXXXX")
magpie=${MAGPIE:-magpie}
run() {
  env -i PATH="$PATH" HOME="$sandbox" USERPROFILE="$sandbox" \
    XDG_CONFIG_HOME="$sandbox/.config" XDG_CACHE_HOME="$sandbox/.cache" \
    CODEX_HOME="$sandbox/.codex" APPDATA="$sandbox/AppData/Roaming" \
    LOCALAPPDATA="$sandbox/AppData/Local" "$magpie" "$@"
}
printf 'Sandbox: %s\n' "$sandbox"
run plugin add "$root" </dev/null
case "${1:-}" in
  ""|--metadata-only) run plugin --json </dev/null ;;
  *) run "$@" ;;
esac
