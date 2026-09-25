#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARE="${CLAUDE_TW_SHARE:-$HOME/.local/share/claude-tw}"
APP="${CLAUDE_APP:-/Applications/Claude.app}"
for file in state.json status.json renderer-report.json patch-heartbeat.json; do
 echo "$file:"; if [[ -f "$SHARE/$file" ]]; then cat "$SHARE/$file"; echo; else echo '尚無'; fi
done
codesign --verify --deep --strict "$APP"
CLAUDE_APP="$APP" node --input-type=module - "$ROOT" <<'NODE'
import {createRequire} from 'node:module';import path from 'node:path';
const require=createRequire(path.join(process.argv[2],'package.json'));
const asar=require('@electron/asar');
const app=process.env.CLAUDE_APP+'/Contents/Resources/app.asar';
const preload=asar.extractFile(app,'.vite/build/mainView.js').toString();
const main=asar.extractFile(app,'.vite/build/index.js').toString();
if(!preload.includes('CLAUDE_TW_PRELOAD_V2 START') || main.includes('CLAUDE_TW_MAIN_INJECT_V1 START'))throw Error('補丁未套用或官方更新已替換補丁');
console.log('offline preload v2: present; legacy delayed injection: absent');
NODE
