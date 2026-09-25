#!/bin/bash
set -euo pipefail
# Retire the old unsafe live patch/kill installer. Candidate preparation is explicit.
echo 'ClaudeTW v2 uses reviewed candidate installation; this script does not modify the live app.'
echo 'Build: node scripts/patch-asar.mjs INPUT_ASAR NEW_OUTPUT_ASAR'
echo 'See README.md for the local validation and reversible installation boundary.'
exit 1
