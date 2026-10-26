#!/usr/bin/env python3
"""Spec drift check: requirements in openspec/ must agree with covering tests in code.

Rules
  * A requirement is a heading `### REQ-AREA-NNN — title` followed by `Status: planned|implemented`.
  * A test covers a requirement with a comment containing `covers: REQ-AREA-NNN[, REQ-...]`.
  * ERROR: duplicate requirement id; requirement without a valid Status line;
           `implemented` requirement with no covering marker; marker naming an unknown id.
  * WARN : `planned` requirement that already has covering markers (probably ready to flip).

Run:  python3 -I scripts/spec_drift.py        (stdlib only; exits 1 on any ERROR)
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC_GLOBS = ["openspec/specs/**/spec.md", "openspec/changes/**/spec.md"]
CODE_SUFFIXES = {".rs", ".ts", ".tsx"}
SKIP_DIRS = {"target", "node_modules", "dist", ".git", ".private"}

REQ_HEADING = re.compile(r"^###\s+(REQ-[A-Z]+-\d{3})\s+—\s+.+$")
STATUS_LINE = re.compile(r"^Status:\s*(planned|implemented)\s*$")
MARKER = re.compile(r"covers:\s*((?:REQ-[A-Z]+-\d{3})(?:\s*,\s*REQ-[A-Z]+-\d{3})*)")
REQ_ID = re.compile(r"REQ-[A-Z]+-\d{3}")


def read_requirements(errors: list[str]) -> dict[str, tuple[str, str]]:
    """id -> (status, defined-in path)"""
    reqs: dict[str, tuple[str, str]] = {}
    for pattern in SPEC_GLOBS:
        for path in sorted(ROOT.glob(pattern)):
            rel = str(path.relative_to(ROOT))
            lines = path.read_text(encoding="utf-8").splitlines()
            i = 0
            while i < len(lines):
                m = REQ_HEADING.match(lines[i])
                if not m:
                    i += 1
                    continue
                rid = m.group(1)
                status = None
                for j in range(i + 1, min(i + 4, len(lines))):
                    s = STATUS_LINE.match(lines[j])
                    if s:
                        status = s.group(1)
                        break
                if status is None:
                    errors.append(f"{rel}: {rid} has no 'Status: planned|implemented' line")
                    status = "planned"
                if rid in reqs:
                    errors.append(f"{rel}: duplicate requirement id {rid} (also in {reqs[rid][1]})")
                else:
                    reqs[rid] = (status, rel)
                i += 1
    return reqs


def read_markers() -> dict[str, list[str]]:
    """id -> files containing a covers: marker"""
    found: dict[str, list[str]] = {}
    for path in ROOT.rglob("*"):
        if path.suffix not in CODE_SUFFIXES or not path.is_file():
            continue
        if SKIP_DIRS.intersection(path.relative_to(ROOT).parts):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        rel = str(path.relative_to(ROOT))
        for line in text.splitlines():
            m = MARKER.search(line)
            if m:
                for rid in REQ_ID.findall(m.group(1)):
                    found.setdefault(rid, []).append(rel)
    return found


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []
    reqs = read_requirements(errors)
    markers = read_markers()

    for rid, files in sorted(markers.items()):
        if rid not in reqs:
            errors.append(f"marker names unknown requirement {rid} in {sorted(set(files))[0]}")

    for rid, (status, where) in sorted(reqs.items()):
        covered = rid in markers
        if status == "implemented" and not covered:
            errors.append(f"{rid} is 'implemented' ({where}) but no test has 'covers: {rid}'")
        if status == "planned" and covered:
            warnings.append(f"{rid} is 'planned' but has covering tests; flip to 'implemented'?")

    implemented = sum(1 for s, _ in reqs.values() if s == "implemented")
    print(f"requirements: {len(reqs)}  implemented: {implemented}  planned: {len(reqs) - implemented}  "
          f"covered: {sum(1 for r in reqs if r in markers)}")
    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
