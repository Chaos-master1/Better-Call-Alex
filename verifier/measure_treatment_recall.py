"""Measure treatment-scan recall against the Casetext/RegLab Overruling
Dataset (2,394 attorney-annotated sentences), as mirrored by LegalBench.

G2 gate (CLAUDE.md §8): "Treatment-scan recall checked against casehold"
— the canon's name for this benchmark. The regex under test is the single
source of truth used by the authority builder: etl/build_authority.TREATMENT_RE.

Run (after downloading verifier/fixtures/overruling_legalbench.tsv):
    uv run python verifier/measure_treatment_recall.py
"""

import csv
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "etl"))

from build_authority import TREATMENT_RE  # noqa: E402

TSV = Path(__file__).resolve().parent / "fixtures" / "overruling_legalbench.tsv"


def main():
    rows = list(csv.DictReader(TSV.open(), delimiter="\t"))
    pos = [r["text"] for r in rows if r["answer"].lower() == "yes"]
    neg = [r["text"] for r in rows if r["answer"].lower() != "yes"]

    tp = sum(1 for t in pos if TREATMENT_RE.search(t))
    fp = sum(1 for t in neg if TREATMENT_RE.search(t))

    print(f"sentences: {len(rows)} "
          f"({len(pos)} overruling-Yes, {len(neg)} No)")
    print(f"recall           = {tp}/{len(pos)} = {tp/len(pos):.3f}")
    print(f"false-positive   = {fp}/{len(neg)} = {fp/len(neg):.3f}")
    print("note: the scan is an INFERRED signal (§5.5) — it flags citing-"
          "context language, including negations ('we do not read X to have "
          "overruled Y'), which annotators count as overruling-related. "
          "Downstream UI must present flags as inferred, never asserted.")


if __name__ == "__main__":
    main()
