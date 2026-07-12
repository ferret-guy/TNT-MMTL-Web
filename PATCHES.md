# Patches to vendored MMTL/TNT source

The solver source under `vendor/mmtl/bem/` is vendored from `mmtl-tnt-master`
(byte-identical to the `tnt-1.2.2` release for everything under `bem/`).
Every deviation from pristine upstream is logged here.

## vendor/mmtl/bem/src/magicad.h

1. **Line ~103**: `#include <iostream.h>` → `#include <iostream>` + `using namespace std;`
   The pre-standard header was removed in GCC 6+/clang/Emscripten. The code uses
   unqualified `ostream` in inline operators, hence the using-directive.
2. **Line ~135**: removed `#include <rw/defs.h>` (Rogue Wave Tools.h++, commercial).
   No compiled translation unit references any Rogue Wave symbol; the only mentions
   are in headers that are never included by the `bem` target
   (`node_database.h`, `DesignData.h`) and a harmless forward declaration in
   `general_prototype.h`.

No other source file is modified. FORTRAN `.F` files are consumed as-is
(translated by `f2c -R` at build time; see `toolchain/`).
