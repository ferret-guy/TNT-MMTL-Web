# Model export scope

Status: implemented locally in the expandable **Export Model** section.

The exporter operates only on a successful, current solve. It disables stale
or inapplicable formats and preserves the solver's conductor order by joining
each result name back to its generated conductor binding.

## Supported outputs

### Touchstone 1.0 `.s2p`

Available for a single signal conductor.

- `# Hz S RI R 50`
- port 1 is the input/near end; port 2 is the output/far end
- historical two-port ordering: `S11 S21 S12 S22`
- log-spaced frequencies from the loss-sweep settings
- selected skin effect, roughness, and dielectric loss are included
- reference-plane loss is included by default for guided microstrip and
  stripline, using copper conductivity and the selected plane foil thickness

The network is calculated from the exact scalar uniform-line equations:

```text
gamma = sqrt((R + jwL)(G + jwC))
Zc    = sqrt((R + jwL)/(G + jwC))
```

### Touchstone 1.0 `.s4p`

Available only for a solved, symmetric two-signal differential pair. Pairs
with materially asymmetric B, L, or Rdc matrices are blocked rather than
silently dropping mode conversion.

- `# Hz S RI R 50`
- full 4-by-4 matrix in Touchstone row-major order
- IEEE/IBIS `13-24` mapping:
  - port 1 = IN+
  - port 2 = OUT+
  - port 3 = IN-
  - port 4 = OUT-
- differential input pair is `(1,3)`; output pair is `(2,4)`
- even and odd uniform-line networks are transformed back to four
  single-ended 50-ohm ports
- the shared reference-plane resistance matrix is projected separately into
  even and odd modes, so odd-mode return-current cancellation is preserved

Touchstone 1.0 RI output is intentionally the default for broad compatibility
and avoids undefined phase or negative-infinity dB tokens for exact zeros.

### Touchstone 1.0 mixed-mode SDD `.s2p`

Offered beside `.s4p` for the same validated symmetric differential pair.

- filename suffix: `-sdd.s2p`
- `# Hz S RI R 100`
- logical port 1 is the differential near pair `(1,3)`
- logical port 2 is the differential far pair `(2,4)`
- historical two-port ordering: `SDD11 SDD21 SDD12 SDD22`
- the values match the SDD block obtained from the full `.s4p`
- common-mode and mode-conversion terms are intentionally omitted

The 100-ohm reference is the natural differential reference created by two
50-ohm single-ended ports. The file is not mislabeled as a 50-ohm differential
network.

Reference: [IBIS Touchstone specification](https://ibis.org/touchstone_ver2.0/touchstone_ver2_0.pdf).

### HSPICE W-element `.wlc`

Available for every valid signal count. This is the classic external
`RLGCfile=` positional format:

```text
N
L0 lower triangle
C0 lower triangle
R0 lower triangle
G0 lower triangle
Rs lower triangle
Gd lower triangle
```

Rules:

- all values are SI numbers without engineering suffixes
- `L0` is the solved L matrix
- `C0` is the solved electrostatic-induction B matrix
- signal `R0` is derived from conductor area and conductivity
- `G0` is zero
- signal `Rs` is the analytical smooth-conductor skin coefficient derived from
  conductivity and perimeter
- when enabled, the full shared reference-plane `R0` and `Rs` matrices are
  added using their DC and high-frequency smooth asymptotes
- `Gd = 2*pi*C0*tan(delta)` using the design-frequency effective loss tangent
- line length remains on the W-element instance, not in the `.wlc` data

The classic one-coefficient `Rs*sqrt(f)` form cannot preserve the
frequency-dependent Hammerstad or Huray multiplier. The file states that
limitation; use Touchstone when the selected broadband roughness correction
must be retained.

### Generic SPICE `.SUBCKT` ladder

Written as a `.cir` file. Guided single-ended and differential flows retain
their conventional pins; arbitrary stackups use one named near/far port pair
per solved signal conductor.

- uses only `R`, `L`, `C`, `K`, `.SUBCKT`, and `.ENDS`
- user-selectable 1–200 symmetric T sections
- one-line pins: `IN OUT REF`
- pair pins: `IN_P IN_N OUT_P OUT_N REF`
- coupled-pair capacitances are converted correctly from the solved Maxwell B
  matrix into line-to-reference and line-to-line capacitors
- pair inductive coupling uses `K = M/sqrt(L11*L22)`
- selected conductor roughness and dielectric loss are frozen at the design
  frequency
- guided single-ended ladders fold reference-plane loss into their series
  resistance
- guided differential ladders fit reference-plane loss to the odd mode at the
  design frequency; the basic topology cannot reproduce the full shared-return
  resistance matrix

Freezing R and G is explicit because a basic-element ladder cannot reproduce
`R ~ sqrt(f)`, a frequency-dependent roughness multiplier, and `G ~ f` across
an unlimited band.

## Shared numerical limits

- B and L are quasi-static MMTL field-solver outputs.
- Skin effect, roughness, and dielectric loss are analytic post-processing.
- Guided microstrip and stripline reference-plane loss is analytic
  post-processing based on finite foil thickness and a return-current overlap
  matrix. It is default-on and can be disabled.
- Reference-plane loss remains unavailable for coplanar and free-form
  geometries because their return-current split or plane material metadata is
  not sufficiently defined.
- Touchstone and the ladder use the selected physical line length.
- The W-element file contains per-unit-length coefficients; its instance owns
  line length.
- Current free-form mixed-dielectric loss uses an effective/configured loss
  tangent rather than a dielectric-participation matrix.

## Validation

Automated tests cover:

- matched lossless two-port magnitude and phase;
- Touchstone headers, frequency ordering, token counts, reciprocity, 2-port
  and 4-port ordering, and asymmetric-pair rejection;
- W-element filename, positional matrix sequence, R0, Rs, and Gd values;
- single-ended and differential `.SUBCKT` pins and primitive coupling.
