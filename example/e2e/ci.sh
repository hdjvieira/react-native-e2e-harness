#!/usr/bin/env bash
# The example's specs on the CI emulator: install the app built before, then
# run. The harness's preflight finds the emulator, starts Appium and Metro
# (detached: E2E_WINDOWS=off) and reverses Metro's port.
set -euo pipefail
cd "$(dirname "$0")"
adb install -r ../android/app/build/outputs/apk/debug/app-debug.apk
status=0
npx wdio run wdio.conf.ts || status=$?
cat out/*/summary.md 2>/dev/null || true
exit $status
