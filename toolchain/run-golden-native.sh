#!/bin/bash
# Golden gate: run a bem binary against every fixture in vendor/mmtl/bem/tests
# and compare .result with .result_save. cseg/dseg are read from each
# .result_save header ("... [cseg] = N") because the saves were generated with
# per-fixture segment counts (10..400), not the .xsctn CSEG/DSEG values.
# usage: run-golden-native.sh <path-to-bem-binary> [rtol]
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/sources.sh"

BIN="${1:?usage: run-golden-native.sh <bem-binary> [rtol]}"
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"   # absolutize before cd
RTOL="${2:-1e-2}"
# Goldens were generated 1999-2002 with pre-release HP-UX binaries; 1e-2
# absorbs cross-era float32 drift. w20t5's 2002 save is known-stale: its own
# header shows the era's parser mis-reading the quoted conductivity, and its
# coarse-mesh (cseg=10) B off-diagonals differ up to 25% from the 2004 source
# we build -- while w10t2.5 (same 5-trapezoid geometry, cseg=400, 2001 save)
# matches to 5e-4. See README.
WAIVED=" w20t5 "
WORK="$TNTWEB_ROOT/build/golden-$(basename "$(dirname "$BIN")")"
TESTS="$BEM_DIR/tests"
mkdir -p "$WORK"

pass=0; fail=0; failed=""
for save in "$TESTS"/*.result_save; do
  name="$(basename "$save" .result_save)"
  [ -f "$TESTS/$name.xsctn" ] || { echo "skip $name (no .xsctn)"; continue; }
  cseg=$(grep -o '\[cseg\] = [0-9]*' "$save" | grep -o '[0-9]*$')
  dseg=$(grep -o '\[dseg\] = [0-9]*' "$save" | grep -o '[0-9]*$')
  cp "$TESTS/$name.xsctn" "$WORK/"
  ( cd "$WORK" && rm -f "$name.result" && "$BIN" "$name" "${cseg:-0}" "${dseg:-0}" > "$name.stdout" 2>&1 )
  if ! grep -q "MMTL is done" "$WORK/$name.stdout"; then
    echo "FAIL $name: solver did not finish (see $WORK/$name.stdout)"
    fail=$((fail+1)); failed="$failed $name"; continue
  fi
  if python3 "$TNTWEB_ROOT/toolchain/compare_results.py" "$WORK/$name.result" "$save" "$RTOL"; then
    pass=$((pass+1))
  elif [[ "$WAIVED" == *" $name "* ]]; then
    echo "WAIVED $name (known-stale golden, see comment above)"
  else
    fail=$((fail+1)); failed="$failed $name"
  fi
done
echo "=================================="
echo "GOLDEN: $pass passed, $fail failed$([ -n "$failed" ] && echo " ($failed)")"
[ $fail -eq 0 ]
