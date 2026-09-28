"""Player feeds -> one bio row per player.

The scorecards only ever carry a short name and a team, so everything else a
profile shows — full name, date of birth (hence age), nationality, height and
weight — comes from the player feed, joined on the player id. The feed's own
career stat blocks are ignored here: every displayed number is recomputed from
the parsed match facts, so the model and the profile cannot disagree.

    python pipeline/kabaddi/build_bio.py
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
from datetime import datetime, timezone

import pandas as pd

HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = os.path.join(HERE, "data", "kabaddi", "raw")
DATA = os.path.join(HERE, "data", "kabaddi")


def _dob(s):
    """"Mar 29 1992" -> ISO date; tolerant of blanks and odd spacing."""
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%b %d %Y", "%B %d %Y", "%d %b %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def _height_cm(s):
    """"6 ft " or "6 ft 1 in" -> centimetres; None when unparseable."""
    s = (s or "").lower()
    ft = re.search(r"(\d+)\s*ft", s)
    inch = re.search(r"(\d+)\s*in", s)
    if not ft:
        return None
    return round((int(ft.group(1)) * 12 + (int(inch.group(1)) if inch else 0)) * 2.54)


def _weight_kg(s):
    m = re.search(r"(\d+)", s or "")
    return int(m.group(1)) if m else None


def build(raw, out, asof=None):
    asof = pd.Timestamp(asof or datetime.now(timezone.utc).date())
    rows = []
    for f in glob.glob(os.path.join(raw, "players", "*.json")):
        try:
            bio = json.load(open(f, encoding="utf-8")).get("bio", {})
        except Exception:
            continue
        pid = bio.get("player_id")
        if not pid:
            continue
        dob = _dob(bio.get("date_of_birth"))
        age = (round((asof - pd.Timestamp(dob)).days / 365.25, 1) if dob else None)
        rows.append({
            "player_id": str(pid),
            "full_name": bio.get("full_name") or bio.get("player_short_name"),
            "dob": dob, "age": age,
            "nationality": (bio.get("nationality") or "").strip() or None,
            "height_cm": _height_cm(bio.get("height")),
            "weight_kg": _weight_kg(bio.get("weight")),
            "jersey": bio.get("jersey_no"),
            "position_name": (bio.get("position_name") or "").strip() or None,
        })
    if not rows:
        raise SystemExit("no player feeds — run pull_feeds first")
    df = pd.DataFrame(rows).drop_duplicates("player_id")
    os.makedirs(out, exist_ok=True)
    df.to_parquet(os.path.join(out, "bio.parquet"))
    cov = lambda c: f"{df[c].notna().mean():.0%}"
    print(f"{len(df)} players  |  dob {cov('dob')}  nationality {cov('nationality')}  "
          f"height {cov('height_cm')}")
    print("nationalities:", df["nationality"].value_counts().head(6).to_dict())
    return df


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=RAW)
    ap.add_argument("--out", default=DATA)
    ap.add_argument("--asof", default=None, help="age reference date (YYYY-MM-DD)")
    args = ap.parse_args()
    build(args.raw, args.out, args.asof)


if __name__ == "__main__":
    main()
