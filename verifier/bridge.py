"""Eyecite subprocess bridge for the G2 Verifier (CLAUDE.md §3, ADR-001).

Protocol: one JSON object on stdin ->
    {"texts": ["draft text 1", ...]}
one JSON object on stdout ->
    {"results": [[citation, ...], ...]}   # parallel to texts

Each citation:
    {"text": raw matched string,
     "corrected": normalized citation string,
     "volume": "410", "reporter": "U.S.", "page": "113",
     "type": "full" | "short" | "supra" | "id" | "unknown",
     "pin_cite": "118" | null,
     "start": int, "end": int}          # char offsets into the input text

Errors are reported per-text inside results as [{"error": "..."}] so one
bad draft cannot fail a whole batch. Exit code is nonzero only when the
bridge itself is unusable (bad protocol, missing stdin).

Run: .venv/bin/python verifier/bridge.py < input.json > output.json
"""

import json
import sys

from eyecite import get_citations
from eyecite.models import (  # noqa: F401  (imported for isinstance checks)
    FullCaseCitation,
    IdCitation,
    ShortCaseCitation,
    SupraCitation,
    UnknownCitation,
)

TYPE_MAP = [
    (FullCaseCitation, "full"),
    (ShortCaseCitation, "short"),
    (SupraCitation, "supra"),
    (IdCitation, "id"),
]


def classify(c):
    for cls, name in TYPE_MAP:
        if isinstance(c, cls):
            return name
    return "unknown"


def serialize(c, text):
    groups = getattr(c, "groups", None) or {}
    md = getattr(c, "metadata", None)
    pin = getattr(md, "pin_cite", None)
    correct_reporter = getattr(c, "corrected_reporter", None)
    start, end = c.span()
    return {
        "text": text[start:end],
        "corrected": c.corrected_citation(),
        "volume": groups.get("volume"),
        "reporter": (correct_reporter() if correct_reporter else None)
        or groups.get("reporter"),
        "page": groups.get("page"),
        "type": classify(c),
        "pin_cite": pin,
        # Supra/name antecedent: eyecite's best guess at the party name a
        # supra reference points at ("Roe" in "Roe, supra, at 164"). The
        # verifier matches it against the draft's own resolved chain.
        "name": getattr(md, "antecedent_guess", None),
        "start": max(0, start),
        "end": max(0, min(end, len(text))),
    }


def extract_one(text):
    if not isinstance(text, str):
        raise ValueError("text entry must be a string")
    out = []
    for c in get_citations(text):
        try:
            out.append(serialize(c, text))
        except Exception as exc:  # noqa: BLE001 - isolate bad citations
            out.append({"error": f"serialize failed: {exc}"})
    return out


def main():
    try:
        payload = json.load(sys.stdin)
        texts = payload["texts"]
        if not isinstance(texts, list):
            raise ValueError('"texts" must be a list')
    except Exception as exc:  # noqa: BLE001 - protocol errors are fatal
        print(json.dumps({"error": f"protocol: {exc}"}))
        sys.exit(2)

    results = []
    for text in texts:
        try:
            results.append(extract_one(text))
        except Exception as exc:  # noqa: BLE001 - keep batch alive
            results.append([{"error": f"extract failed: {exc}"}])

    json.dump({"results": results}, sys.stdout)


if __name__ == "__main__":
    main()
