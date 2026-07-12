#!/bin/bash
# Shared: extract the bem target's source lists from the vendored Makefile.am.
# bem_SOURCES = cpp_SOURCES + fortran_SOURCES + src/nmmtl_parse_xsctn.cpp
# (never nmmtl_parse_graphic.cpp -- that belongs to the noinst gnmmtl target).
# Parsing the Makefile keeps the list authoritative instead of transcribed.

TNTWEB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BEM_DIR="$TNTWEB_ROOT/vendor/mmtl/bem"
SRC_DIR="$BEM_DIR/src"

_extract_var() {  # _extract_var VARNAME  -> newline-separated values
  awk -v var="$1" '
    $0 ~ "^"var" *=" { collecting=1; sub("^"var" *= *",""); }
    collecting {
      line=$0
      cont = (line ~ /\\[ \t]*$/)
      gsub(/\\[ \t]*$/,"",line)
      gsub(/^[ \t]+|[ \t]+$/,"",line)
      n=split(line, parts, /[ \t]+/)
      for(i=1;i<=n;i++) if(parts[i]!="") print parts[i]
      if(!cont) collecting=0
    }' "$BEM_DIR/Makefile.am"
}

CPP_SOURCES=$(_extract_var cpp_SOURCES | grep -v '^\$' )
FORTRAN_SOURCES=$(_extract_var fortran_SOURCES | grep -v '^\$')
CPP_SOURCES="$CPP_SOURCES
src/nmmtl_parse_xsctn.cpp"

export TNTWEB_ROOT BEM_DIR SRC_DIR CPP_SOURCES FORTRAN_SOURCES
