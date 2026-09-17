"""Work out which competition a match file belongs to.

Per-competition zips are keyed by their filename, so a full rebuild never needs
this. The daily window does: recently_added mixes every competition together and
nothing in the archive tells you which zip a given match would have come from.

Two rules, because the archive has two kinds of cricket in it.

Internationals resolve from team_type and match_type alone. Their event name is
the tournament or the tour — "The Ashes", "Women's Asia Cup", "India tour of
Australia" — which is hundreds of distinct values that map to nothing useful.

Club competitions resolve from the event name, via the exact competition name
and then an alias file, because the name in the file follows the sponsor. The
same T20 Blast appears as NatWest, Vitality, and Vitality Blast Men.

Anything that resolves to nothing is returned as unresolved rather than guessed.
A match assigned to the wrong competition would be adjusted by the wrong
coefficient and quietly distort every player in it.
"""
from __future__ import annotations

import csv
import os

# Cricsheet's match_type for an international, to our competition key. ODM and
# MDM are its "other one-day" and "other multi-day" buckets; both carry club
# cricket too, which is why team_type is checked first.
INTERNATIONAL = {
    "Test": "tests", "MDM": "mdms",
    "ODI": "odis", "ODM": "odms",
    "T20": "t20s", "IT20": "it20s",
}

ALIASES = os.path.join("config", "cricket", "event_aliases.csv")


class Resolver:
    def __init__(self, cfg: dict, alias_path: str = ALIASES):
        self.by_key = {c["key"]: c for c in cfg["competitions"]}
        # An exact competition name resolves without needing an alias line.
        self.by_name = {self._norm(c["name"]): c["key"] for c in cfg["competitions"]}
        self.aliases = {}
        if os.path.exists(alias_path):
            with open(alias_path) as fh:
                for row in csv.DictReader(r for r in fh if not r.startswith("#")):
                    if row.get("event") and row.get("competition"):
                        self.aliases[self._norm(row["event"])] = row["competition"].strip()
        self.unresolved = {}

    @staticmethod
    def _norm(s: str) -> str:
        return " ".join((s or "").lower().replace("'", "").replace("-", " ").split())

    def resolve(self, info: dict):
        """Return the competition dict, or None if it cannot be identified."""
        if info.get("team_type") == "international":
            key = INTERNATIONAL.get(info.get("match_type"))
            comp = self.by_key.get(key)
            if comp is None:
                self._miss(f"international/{info.get('match_type')}")
            return comp

        event = ((info.get("event") or {}).get("name")) or ""
        n = self._norm(event)
        key = self.aliases.get(n) or self.by_name.get(n)
        if key is None:
            self._miss(event or "(no event name)")
            return None
        comp = self.by_key.get(key)
        if comp is None:
            # The alias file points at a competition that is not configured.
            self._miss(f"{event} -> {key} (not in competitions.yml)")
        return comp

    def _miss(self, label: str):
        self.unresolved[label] = self.unresolved.get(label, 0) + 1

    def report(self):
        """What could not be routed, worst first, for the run summary."""
        return sorted(self.unresolved.items(), key=lambda kv: -kv[1])
