#!/bin/sh
# Start Manga Library: builds what is missing or out of date, then runs it.
# Everything it does is in start.mjs, which is the same on every system.
exec node "$(dirname "$0")/start.mjs" "$@"
