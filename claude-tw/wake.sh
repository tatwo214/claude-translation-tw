#!/bin/zsh
set -eu

# The compatibility path is a symlink into the real, relocatable project runtime.
SHARE_DIR="${HOME}/.local/share/claude-tw"
if [[ -d "${SHARE_DIR}" ]]; then
  SHARE_DIR="$(cd -- "${SHARE_DIR}" && pwd -P)"
fi
STATE_PATH="${SHARE_DIR}/state.json"
HELPER_APP="${SHARE_DIR:h}/ClaudeTW.app"
[[ -d "${HELPER_APP}" ]] || HELPER_APP="${HOME}/Applications/ClaudeTW.app"
HELPER_AUTO_LAUNCH="${CLAUDE_TW_AUTO_HELPER:-1}"

claude_running() {
  /usr/bin/pgrep -x "Claude" >/dev/null 2>&1
}

wake_helper() {
  [[ "${HELPER_AUTO_LAUNCH}" == "1" ]] || return 0
  /usr/bin/pgrep -x "ClaudeTW" >/dev/null 2>&1 && return 0
  if [[ ! -d "${HELPER_APP}" ]]; then
    print -u2 -- "ClaudeTW helper not found: ${HELPER_APP}"
    return 1
  fi
  /usr/bin/open -g "${HELPER_APP}"
}

write_enabled_state() {
  local node_bin="${commands[node]:-}"
  if [[ -z "${node_bin}" ]]; then
    local candidate
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
      if [[ -x "${candidate}" ]]; then node_bin="${candidate}"; break; fi
    done
  fi
  if [[ -z "${node_bin}" ]]; then
    print -u2 -- "Node.js not found; state unchanged"
    return 1
  fi
  "${node_bin}" --input-type=module - "${STATE_PATH}" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const file = process.argv[2];
let state = {};
let mode = 0o600;
try {
  state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!state || Array.isArray(state) || typeof state !== 'object') {
    throw new Error('state.json must be an object; left unchanged');
  }
  mode = fs.statSync(file).mode & 0o777;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
state.enabled = true;
state.updatedAt = new Date().toISOString();
fs.mkdirSync(path.dirname(file), { recursive: true });
const temporary = `${file}.${randomUUID()}.tmp`;
try {
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx', mode });
  fs.renameSync(temporary, file);
} finally {
  fs.rmSync(temporary, { force: true });
}
NODE
}

case "${1:-wake}" in
  --if-claude-running)
    # The retained five-second launch agent must never launch Claude itself.
    if claude_running; then wake_helper; fi
    ;;
  --enable)
    write_enabled_state
    wake_helper
    if ! claude_running; then /usr/bin/open /Applications/Claude.app; fi
    ;;
  wake)
    wake_helper
    ;;
  *)
    print -u2 -- "Usage: wake.sh [wake|--if-claude-running|--enable]"
    exit 64
    ;;
esac
