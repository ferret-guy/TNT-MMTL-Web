#!/usr/bin/env python3
"""Load a Web-MMTL S2P with scikit-rf and compare it to ngspice."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

import numpy as np
import skrf as rf


SUBCIRCUIT_PATTERN = re.compile(
    r"^\.SUBCKT\s+(\S+)\s+IN\s+OUT\s+REF\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--touchstone", required=True, type=Path)
    parser.add_argument("--subcircuit", required=True, type=Path)
    parser.add_argument("--frequency-hz", required=True, type=float)
    parser.add_argument("--absolute-tolerance", required=True, type=float)
    return parser.parse_args()


def ngspice_executable() -> str:
    requested = os.environ.get("NGSPICE", "ngspice")
    executable = shutil.which(requested)
    if executable is None and Path(requested).is_file():
        executable = str(Path(requested).resolve())
    if executable is None:
        raise RuntimeError(
            "ngspice was not found; install it or set NGSPICE to its executable"
        )
    return executable


def ngspice_command(executable: str, deck: Path) -> list[str]:
    if os.name == "nt" and Path(executable).suffix.lower() in {".bat", ".cmd"}:
        command_processor = os.environ.get("COMSPEC", "cmd.exe")
        return [command_processor, "/d", "/c", executable, "-b", str(deck)]
    return [executable, "-b", str(deck)]


def run_direction(
    *,
    directory: Path,
    subcircuit_text: str,
    subcircuit_name: str,
    frequency_hz: float,
    direction: str,
) -> tuple[complex, complex]:
    if direction == "forward":
        drive_node, terminated_node = "P1", "P2"
    elif direction == "reverse":
        drive_node, terminated_node = "P2", "P1"
    else:
        raise ValueError(f"unknown drive direction {direction}")

    data_name = f"{direction}.dat"
    deck = directory / f"{direction}.cir"
    deck.write_text(
        "\n".join(
            [
                f"* Web-MMTL {direction} two-port interoperability bench",
                subcircuit_text.rstrip(),
                "VSTIM SRC 0 AC 2",
                f"RGEN SRC {drive_node} 50",
                f"RTERM {terminated_node} 0 50",
                f"XUUT P1 P2 0 {subcircuit_name}",
                # Two points avoid simulator-specific rejection of equal AC
                # endpoints. Only the exact design-frequency first row is used.
                f".ac lin 2 {frequency_hz:.17g} {2 * frequency_hz:.17g}",
                ".control",
                "set wr_vecnames",
                "set wr_singlescale",
                "set numdgt=15",
                "run",
                f"wrdata {data_name} vr(p1) vi(p1) vr(p2) vi(p2)",
                "quit",
                ".endc",
                ".end",
                "",
            ]
        ),
        encoding="utf-8",
    )

    executable = ngspice_executable()
    completed = subprocess.run(
        ngspice_command(executable, deck),
        cwd=directory,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    data_path = directory / data_name
    if completed.returncode != 0 or not data_path.is_file():
        raise RuntimeError(
            f"ngspice {direction} run failed with exit code "
            f"{completed.returncode}\nstdout:\n{completed.stdout}\n"
            f"stderr:\n{completed.stderr}"
        )

    rows = np.atleast_2d(np.loadtxt(data_path, skiprows=1))
    if rows.shape[1] != 5 or rows.shape[0] < 1:
        raise AssertionError(
            f"unexpected ngspice wrdata shape {rows.shape} in {data_path}"
        )
    frequency, p1_real, p1_imag, p2_real, p2_imag = rows[0]
    if not np.isclose(frequency, frequency_hz, rtol=0, atol=1e-6):
        raise AssertionError(
            f"ngspice returned {frequency} Hz instead of {frequency_hz} Hz"
        )
    return complex(p1_real, p1_imag), complex(p2_real, p2_imag)


def complex_pairs(matrix: np.ndarray) -> list[list[list[float]]]:
    return [
        [[float(value.real), float(value.imag)] for value in row]
        for row in matrix
    ]


def main() -> None:
    args = arguments()
    network = rf.Network(str(args.touchstone))
    if network.nports != 2 or network.s.shape != (1, 2, 2):
        raise AssertionError(
            f"scikit-rf loaded shape {network.s.shape}, expected one 2-port point"
        )
    if not np.allclose(network.f, [args.frequency_hz], rtol=0, atol=1e-6):
        raise AssertionError(
            f"scikit-rf loaded frequencies {network.f}, expected {args.frequency_hz}"
        )
    if not np.allclose(network.z0, 50, rtol=0, atol=1e-12):
        raise AssertionError(
            f"scikit-rf loaded reference impedances {network.z0}, expected 50 ohms"
        )
    if not np.all(np.isfinite(network.s)):
        raise AssertionError("scikit-rf loaded non-finite S-parameters")

    subcircuit_text = args.subcircuit.read_text(encoding="utf-8")
    match = SUBCIRCUIT_PATTERN.search(subcircuit_text)
    if match is None:
        raise AssertionError("exported ladder has no .SUBCKT <name> IN OUT REF line")
    subcircuit_name = match.group(1)
    directory = args.subcircuit.parent

    forward_p1, forward_p2 = run_direction(
        directory=directory,
        subcircuit_text=subcircuit_text,
        subcircuit_name=subcircuit_name,
        frequency_hz=args.frequency_hz,
        direction="forward",
    )
    reverse_p1, reverse_p2 = run_direction(
        directory=directory,
        subcircuit_text=subcircuit_text,
        subcircuit_name=subcircuit_name,
        frequency_hz=args.frequency_hz,
        direction="reverse",
    )

    # A 2 V Thevenin source behind 50 ohms launches a 1 V incident wave.
    # The matched opposite port has no incident wave, so these voltages are
    # directly the conventional 50-ohm scattering parameters.
    ngspice_s = np.array(
        [
            [forward_p1 - 1, reverse_p1],
            [forward_p2, reverse_p2 - 1],
        ],
        dtype=complex,
    )
    touchstone_s = network.s[0]
    complex_error = np.abs(ngspice_s - touchstone_s)
    maximum_error = float(np.max(complex_error))
    if maximum_error > args.absolute_tolerance:
        raise AssertionError(
            "ngspice and scikit-rf disagree\n"
            f"Touchstone S={touchstone_s}\n"
            f"ngspice S={ngspice_s}\n"
            f"absolute complex errors={complex_error}\n"
            f"limit={args.absolute_tolerance}"
        )

    print(
        json.dumps(
            {
                "frequency_hz": args.frequency_hz,
                "points": int(network.s.shape[0]),
                "ports": int(network.nports),
                "max_complex_error": maximum_error,
                "touchstone_s": complex_pairs(touchstone_s),
                "ngspice_s": complex_pairs(ngspice_s),
                "scikit_rf_version": rf.__version__,
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"interop error: {error}", file=sys.stderr)
        raise
