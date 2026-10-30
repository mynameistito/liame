#!/bin/sh
# Prints the code-signing identity for `bun run dist`.
# A stable identity keeps the app's Keychain access ("Always Allow") across rebuilds;
# ad-hoc signatures change with every build, so macOS asks again each time.
if [ -n "$LIAME_SIGN_IDENTITY" ]; then
  echo "$LIAME_SIGN_IDENTITY"
  exit 0
fi
identity=$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' 'NF > 1 { print $2; exit }')
echo "${identity:--}"
