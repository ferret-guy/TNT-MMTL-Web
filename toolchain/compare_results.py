#!/usr/bin/env python3
"""Section-aware numeric comparison of two MMTL .result files.

The vendored .result_save goldens span two output-format eras (1999 HP-UX vs
2004), with different signal naming (signal1 vs ::Rect4R0), reworded
bookkeeping lines, and occasional differing input metadata (generic's save was
made with a different couplingLength than the shipped .xsctn). We therefore:

- extract per-section value streams (B, L, Rdc, Z0, odd/even, eps_eff,
  velocity, delay, FXT, BXT) anchored on the section headers common to both
  eras, pairing values positionally *within* each section;
- ignore run metadata (timestamp, File/Node, "Number of", per-conductor
  conductivity echoes, coupling length) and derived diagnostics (matrix
  asymmetry percentages, min-frequency note);
- use tolerance relative to each section's max |value|:
      err = |a-b| / max(|b|, 1e-3 * max_abs(section))
  so 1e-15 far-coupling terms in a 1e-10 matrix and catastrophic-cancellation
  crosstalk pairs are judged against the section scale, not themselves.

usage: compare_results.py got.result want.result_save [rtol] [--verbose]
Exit 0 = match.
"""
import re
import sys

NUM = re.compile(r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')

SECTION_HEADERS = [
    ('Mutual and Self Electrostatic Induction', 'B'),
    ('Mutual and Self Inductance', 'L'),
    ('Characteristic Impedance Odd/Even', 'Zoddeven'),
    ('Characteristic Impedance', 'Z0'),
    ('Effective Dielectric Constant', 'eps'),
    ('Propagation Velocity Odd/Even', 'Voddeven'),
    ('Propagation Velocity', 'V'),
    ('Propagation Delay Odd/Even', 'Doddeven'),
    ('Propagation Delay', 'D'),
    ('Rdc', 'Rdc'),
    ('Far-End', 'FXT'),
    ('Near-End', 'BXT'),
]

# value-bearing line patterns within a section
VALUE_LINE = re.compile(
    r'^\s*(?:B\(|L\(|Rdc\(|FXT\(|BXT\(|For Signal Line|odd=|even=)'
)


def sections(path):
    """-> dict section_id -> list of floats (in file order)"""
    out = {sid: [] for _, sid in SECTION_HEADERS}
    out['hdr'] = []   # cseg/dseg/risetime
    cur = None
    with open(path, errors='replace') as fh:
        for line in fh:
            for header, sid in SECTION_HEADERS:
                if line.lstrip().startswith(header):
                    cur = sid
                    break
            else:
                if re.search(r'\[cseg\] = |\[dseg\] = |^Rise Time', line):
                    out['hdr'] += [float(t) for t in NUM.findall(line.split('=', 1)[1])]
                elif cur and VALUE_LINE.search(line):
                    text = line.split('=', 1)[1] if '=' in line else line
                    if cur in ('FXT', 'BXT'):
                        # "FXT( a , b )= raw =  dB dB" -> raw only; the dB is
                        # derived, and old saves print "= infinite dB" for 0.
                        text = text.split('=', 1)[0]
                    else:
                        text = text.replace('=', ' ')
                    out[cur] += [float(t) for t in NUM.findall(text)]
    return out


def main():
    argv = [a for a in sys.argv[1:] if a != '--verbose']
    verbose = '--verbose' in sys.argv
    got_path, want_path = argv[0], argv[1]
    rtol = float(argv[2]) if len(argv) > 2 else 1e-2

    got, want = sections(got_path), sections(want_path)
    nfail = 0
    ncmp = 0
    worst, worst_where = 0.0, ''
    for sid in got:
        g, w = got[sid], want[sid]
        if len(g) != len(w):
            print(f'FAIL {got_path}: section {sid} count {len(g)} != {len(w)}')
            nfail += 1
            continue
        if not g:
            continue
        scale = max(abs(x) for x in w)
        for i, (a, b) in enumerate(zip(g, w)):
            ncmp += 1
            if sid in ('FXT', 'BXT'):
                # crosstalk terms 3+ decades below the section max are
                # cancellation noise (< -150 dB); judge against the scale
                err = abs(a - b) / scale if scale else abs(a - b)
            else:
                err = abs(a - b) / max(abs(b), 1e-3 * scale) if scale else abs(a - b)
            if err > worst:
                worst, worst_where = err, f'{sid}[{i}]'
            if err > rtol:
                nfail += 1
                if verbose:
                    print(f'  {sid}[{i}]: got {a:g} want {b:g} rel {err:.2e}')
    tag = 'OK  ' if nfail == 0 else 'FAIL'
    print(f'{tag} {got_path}: {ncmp} values, worst {worst:.2e} at {worst_where}, '
          f'{nfail} failures (tol {rtol:g})')
    return 0 if nfail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
