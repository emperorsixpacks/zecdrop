#!/usr/bin/env bash
# Builds the zcash-devtool the operator drives for a payout's shielded deposit address (docs/ADR/0006-shielded-inbox.md):
# upstream zcash-devtool at a pinned commit, plus ZecDrop's own patch (zecdrop.patch, in this directory). The first build
# takes a while; later ones are incremental.
#
#   scripts/zcash-devtool/build.sh        then start the operator with --zcash-devtool target/zcash-devtool/zcash-devtool
#
# The patch adds three things upstream does not have at this commit: `pczt sign` signs Ironwood spends from the wallet's own
# seed, `pczt create` and `pczt create-max` take --ironwood-only, and `pczt extract` takes --tx-out (the raw transaction, so
# the operator checks exactly what it broadcasts).
set -euo pipefail

REV=b532d4cd760d30213c961fe0638ee6b6e1bf8e30
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$ROOT/target/zcash-devtool-src"
OUT="$ROOT/target/zcash-devtool"

if [ ! -d "$SRC/.git" ]; then
  git clone --quiet https://github.com/zcash/zcash-devtool.git "$SRC"
fi
cd "$SRC"
git cat-file -e "$REV^{commit}" 2>/dev/null || git fetch --quiet origin
# The patch is the source of truth: start from the pinned commit every time.
git checkout --quiet --force "$REV"
git reset --quiet --hard "$REV"
git apply --check "$HERE/zecdrop.patch"
git apply "$HERE/zecdrop.patch"

cargo build --release --locked
mkdir -p "$OUT"
cp target/release/zcash-devtool "$OUT/zcash-devtool"
echo "built $OUT/zcash-devtool (upstream $REV with zecdrop.patch)"
