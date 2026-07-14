# TNT-MMTL Web

Browser-based PCB transmission-line solver for single-ended and differential
microstrip, stripline, coplanar, and free-form cross-sections. The 2-D
quasi-static field solve runs locally, and configurations can be shared by URL.

## Run

```sh
npm ci
npm run dev
```

## Check and build

```sh
npm test
npm run build
```

Serve `dist/` with any static host, or run `npm run preview`.

## Solver and license

The solver is [MMTL/TNT](https://mmtl.sourceforge.net/) from the Mayo Special
Purpose Processor Development Group, compiled to WebAssembly. This project is
GPL-2.0-or-later; see `vendor/mmtl/COPYING`. Vendored solver changes are
summarized in `PATCHES.md`.
