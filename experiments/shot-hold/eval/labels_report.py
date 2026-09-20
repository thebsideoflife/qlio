#!/usr/bin/env python3
"""Turn labels/labels.jsonl into the numbers that drive the next iteration.

  python -m eval.labels_report

Last judgment per card wins. Prints approve rate per kind / method / policy branch, deny reasons,
and, where the reviewer clicked a correction, the pan and zoom error of the proposal."""

from __future__ import annotations

import collections
import json
import re
import statistics as st
from pathlib import Path

from shothold.geometry import window

LABELS = Path(__file__).resolve().parent.parent / "labels" / "labels.jsonl"


def main() -> None:
    if not LABELS.exists():
        return print("no labels yet:", LABELS)
    last = {}
    for line in LABELS.read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            last[r["card_id"]] = r
    rows = [r for r in last.values() if r["verdict"] != "skip"]
    print(f"{len(last)} cards judged, {len(rows)} excluding skips\n")
    groups = collections.defaultdict(list)
    for r in rows:
        groups[(r["kind"], r["method"], "all")].append(r)
        if r["kind"] == "crop":
            branch = re.sub(r"^\d+ ", "N ", re.split(r"[:·]", r["proposal"].get("reason", ""))[0].strip())
            groups[(r["kind"], r["method"], branch)].append(r)
        if r["kind"] == "cut":
            groups[(r["kind"], r["method"], r["context"].get("category", "?"))].append(r)
    for key in sorted(groups):
        g = groups[key]
        ok = sum(r["verdict"] == "approve" for r in g)
        print(f"{' / '.join(key):75s} {ok:3d}/{len(g):3d} approved ({100 * ok / len(g):.0f}%)")
    if any(r["kind"] == "cut" for r in rows):
        print("\ncut approve rates above are NOT clock accuracy: round-1 cards mixed two wordings and the reviewer\n"
              "answered 'is this a cut?' on all of them. Score clocks with: python -m eval.clock_labels")
    reasons = collections.Counter(x for r in rows if r["verdict"] == "deny" for x in r.get("reasons", []))
    print("\ndeny reasons:", dict(reasons.most_common()))
    fix = [r for r in rows if r["kind"] == "crop" and r.get("correction")]
    if fix:
        dc = [abs(sum(window(r["proposal"]["zoom"], r["proposal"]["focusX"])) / 2 - sum(window(r["correction"]["zoom"], r["correction"]["focusX"])) / 2) for r in fix]
        dz = [r["correction"]["zoom"] - r["proposal"]["zoom"] for r in fix]
        print(f"\n{len(fix)} corrections: median crop-centre error {st.median(dc):.3f} of frame width; "
              f"reviewer went wider on {sum(z < -0.02 for z in dz)}, tighter on {sum(z > 0.02 for z in dz)}")
    notes = [(r["card_id"], r["notes"]) for r in rows if r.get("notes")]
    if notes:
        print("\nnotes:")
        for cid, n in notes:
            print(f"  {cid}: {n}")


if __name__ == "__main__":
    main()
