"""Scorecards -> one row per player per match.

Two sources inside each scorecard, used for what each does best:

  squad   already carries clean per-player totals for the match — raids and
          tackles by outcome, the point breakdown, super-10/high-5, cards. These
          are taken as-is; re-deriving them from the event stream would only add
          rounding error.

  events  the raid-by-raid stream, used for the two things the squad totals do
          not expose: do-or-die raids (a flag on the raid) and whether a tackle
          was solo or assisted (the length of the tacklers list on the raid where
          the raider was caught).

A do-or-die raid is the pressure situation kabaddi turns on — a raider who must
score or is out — so its conversion rate is a metric in its own right, not a
footnote. Solo vs assisted separates a defender who makes tackles alone from one
who only ever piles on.

Emits, per season, two parquet files under data/kabaddi/facts/:
  {id}_player_match.parquet   the wide fact table the model aggregates
  {id}_zones.parquet          per-zone points, long, for the corner/cover lean

    python pipeline/kabaddi/parse_matches.py --seasons all
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from datetime import datetime

import pandas as pd

HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = os.path.join(HERE, "data", "kabaddi", "raw")
FACTS = os.path.join(HERE, "data", "kabaddi", "facts")


def _date(s: str) -> str | None:
    """Scorecard dates are MM/DD/YYYY, sometimes with a trailing time."""
    if not s:
        return None
    head = str(s).split(" ")[0]
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(head, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def _g(d: dict, *path, default=0):
    """Nested get with a default — squads are mostly complete but not always."""
    for k in path:
        d = d.get(k) if isinstance(d, dict) else None
        if d is None:
            return default
    return d


def parse_scorecard(sc: dict):
    """Return (fact rows, zone rows) for one match."""
    md = sc.get("match_detail", {})
    season = str(_g(md, "series", "id", default=""))
    match_id = md.get("match_id")
    date = _date(md.get("date"))
    teams = sc.get("teams", {}).get("team", [])
    if len(teams) != 2 or not match_id:
        return [], []
    opp = {str(teams[0].get("id")): str(teams[1].get("id")),
           str(teams[1].get("id")): str(teams[0].get("id"))}

    # Event-derived extras, keyed by player id.
    dod = {}          # raider -> [raids, successful, points]
    tackle = {}       # defender -> [solo, assisted]
    for e in sc.get("events", {}).get("event", []):
        if e.get("do_or_die") and e.get("raider_id"):
            r = dod.setdefault(str(e["raider_id"]), [0, 0, 0])
            r[0] += 1
            pts = e.get("raid_points", 0) or 0
            if pts > 0:
                r[1] += 1
            r[2] += pts
        # A tackle is a raid where the defence scored; the tacklers are `defenders`.
        if (e.get("defending_points", 0) or 0) > 0:
            ds = e.get("defenders") or ([e["defender_id"]] if e.get("defender_id") else [])
            solo = len(ds) == 1
            for d in ds:
                t = tackle.setdefault(str(d), [0, 0])
                t[0 if solo else 1] += 1

    facts, zones = [], []
    for t in teams:
        tid = str(t.get("id"))
        for p in t.get("squad", []):
            pid = str(p.get("id"))
            if not pid or not p.get("played"):
                continue
            dd = dod.get(pid, [0, 0, 0])
            tk = tackle.get(pid, [0, 0])
            facts.append({
                "season_id": season, "match_id": str(match_id), "date": date,
                "player_id": pid, "name": p.get("name"),
                "team_id": tid, "opp_id": opp.get(tid),
                "role_raw": (p.get("role") or "").strip(),
                "skill_raw": (p.get("skill") or "").strip(),
                "started": bool(p.get("starter")), "captain": bool(p.get("captain")),
                # raiding
                "raids": _g(p, "raids", "total"),
                "raids_succ": _g(p, "raids", "successful"),
                "raids_unsucc": _g(p, "raids", "unsuccessful"),
                "raids_empty": _g(p, "raids", "Empty"),
                "super_raids": _g(p, "raids", "super_raids"),
                "raid_pts": _g(p, "points", "raid_points", "total"),
                "raid_touch_pts": _g(p, "points", "raid_points", "touch"),
                "raid_bonus_pts": _g(p, "points", "raid_points", "raid_bonus"),
                "dod_raids": dd[0], "dod_succ": dd[1], "dod_pts": dd[2],
                "super_ten": bool(p.get("super_ten")),
                # defending
                "tackles": _g(p, "tackles", "total"),
                "tackles_succ": _g(p, "tackles", "successful"),
                "tackles_unsucc": _g(p, "tackles", "unsuccessful"),
                "super_tackles": _g(p, "tackles", "super_tackles"),
                "tackle_pts": _g(p, "points", "tackle_points", "total"),
                "tackle_capture_pts": _g(p, "points", "tackle_points", "capture"),
                "tackle_bonus_pts": _g(p, "points", "tackle_points", "capture_bonus"),
                "solo_tackles": tk[0], "assisted_tackles": tk[1],
                "high_five": bool(p.get("high_five")),
                # totals & discipline
                "total_pts": _g(p, "points", "total"),
                "green": p.get("green_card_count", 0) or 0,
                "yellow": p.get("yellow_card_count", 0) or 0,
                "red": p.get("red_card_count", 0) or 0,
            })
            for kind, key in (("strong", "strong_zone"), ("weak", "weak_zone")):
                for z in _g(p, f"{kind}_zones", key, default=[]) or []:
                    zones.append({"season_id": season, "match_id": str(match_id),
                                  "player_id": pid, "zone_id": z.get("zone_id"),
                                  "kind": kind, "points": z.get("points", 0) or 0})
    return facts, zones


def parse_season(sid: str, raw: str, out: str) -> int:
    files = sorted(glob.glob(os.path.join(raw, sid, "scorecards", "*.json")))
    facts, zones = [], []
    for f in files:
        try:
            sc = json.load(open(f, encoding="utf-8"))
        except Exception as e:
            print(f"  ! bad scorecard {os.path.basename(f)}: {e}")
            continue
        fr, zr = parse_scorecard(sc)
        facts += fr
        zones += zr
    if not facts:
        print(f"  season {sid}: no facts")
        return 0
    os.makedirs(out, exist_ok=True)
    pd.DataFrame(facts).to_parquet(os.path.join(out, f"{sid}_player_match.parquet"))
    pd.DataFrame(zones).to_parquet(os.path.join(out, f"{sid}_zones.parquet"))
    print(f"  season {sid:>3}: {len(facts):>5} player-match rows, "
          f"{len(set(r['player_id'] for r in facts)):>3} players, {len(files)} matches")
    return len(facts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="all")
    ap.add_argument("--raw", default=RAW)
    ap.add_argument("--out", default=FACTS)
    args = ap.parse_args()
    import yaml
    cfg = yaml.safe_load(open(os.path.join(HERE, "config", "kabaddi", "seasons.yml")))
    ids = ([str(s["id"]) for s in cfg["seasons"]] if args.seasons == "all"
           else args.seasons.replace(",", " ").split())
    total = 0
    for sid in ids:
        total += parse_season(sid, args.raw, args.out)
    print(f"total: {total} player-match rows -> {args.out}")


if __name__ == "__main__":
    main()
