"""Facts + player feeds -> one role row per player.

The model fits a separate space per role cell, so every player needs exactly one
cell. Four exist:

    raider · defender-corner · defender-cover · all-rounder

Primary role (raider / defender / all-rounder) comes from the player feed's
`position_name`, which is always present, and falls back to the majority of the
per-match role labels when a player has no feed.

The corner/cover split for defenders is not always in the feed, and the per-match
skill label is often blank, so it is decided by majority vote of every non-blank
"...left corner" / "...right cover" label a defender carries across all seasons —
left and right collapsed, because the cell is about the job, not the side. The
handful never labelled anywhere fall to a seed file, then to a flagged default,
the same escalation the cricket bowler classifier uses.

    python pipeline/kabaddi/build_master.py --seasons all
"""
from __future__ import annotations

import argparse
import glob
import json
import os

import pandas as pd
import yaml

HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = os.path.join(HERE, "data", "kabaddi", "raw")
FACTS = os.path.join(HERE, "data", "kabaddi", "facts")
DATA = os.path.join(HERE, "data", "kabaddi")
CFG = os.path.join(HERE, "config", "kabaddi")


def _base_role(s: str) -> str | None:
    """Normalise a raw role/position/skill label to a base role."""
    s = (s or "").lower()
    if "all" in s and "round" in s:
        return "all-rounder"
    if "raid" in s:
        return "raider"
    if "defend" in s or "corner" in s or "cover" in s:
        return "defender"
    return None


def _subrole(text: str) -> str | None:
    t = (text or "").lower()
    if "corner" in t:
        return "corner"
    if "cover" in t:
        return "cover"
    return None


def player_positions(raw: str) -> dict:
    """player_id -> (full_name, base role) from the player feeds."""
    out = {}
    for f in glob.glob(os.path.join(raw, "players", "*.json")):
        try:
            bio = json.load(open(f, encoding="utf-8")).get("bio", {})
        except Exception:
            continue
        pid = str(bio.get("player_id") or os.path.splitext(os.path.basename(f))[0])
        out[pid] = (bio.get("full_name") or bio.get("player_short_name"),
                    _base_role(bio.get("position_name")))
    return out


def _seed(path: str) -> dict:
    """Optional player_id -> corner/cover overrides for the never-labelled few."""
    if not os.path.exists(path):
        return {}
    df = pd.read_csv(path, dtype=str)
    return {r.player_id.strip(): r.subrole.strip().lower()
            for r in df.itertuples() if str(r.subrole).strip()}


def build(seasons, raw, facts_dir, out):
    fs = [os.path.join(facts_dir, f"{s}_player_match.parquet") for s in seasons]
    fs = [f for f in fs if os.path.exists(f)]
    if not fs:
        raise SystemExit("no fact files — run parse_matches first")
    df = pd.concat((pd.read_parquet(f) for f in fs), ignore_index=True)

    feed = player_positions(raw)
    seeds = _seed(os.path.join(CFG, "defender_seeds.csv"))
    year = {str(s["id"]): s["year"] for s in
            yaml.safe_load(open(os.path.join(CFG, "seasons.yml")))["seasons"]}
    df["year"] = df["season_id"].map(year)

    rows = []
    for pid, g in df.groupby("player_id"):
        # Name: the player feed's full name is best; fall back to the scorecard.
        feed_name, feed_role = feed.get(pid, (None, None))
        name = feed_name or g["name"].dropna().iloc[0] if len(g["name"].dropna()) else feed_name

        # Base role: feed first, else the majority of per-match labels.
        match_roles = pd.Series([_base_role(r) or _base_role(s)
                                 for r, s in zip(g["role_raw"], g["skill_raw"])]).dropna()
        role = feed_role or (match_roles.mode().iloc[0] if len(match_roles) else None)
        raids, tackles = int(g["raids"].sum()), int(g["tackles"].sum())
        if role is None:
            role = "raider" if raids >= tackles else "defender"

        # Sanity override. The feed's position is sometimes at odds with what the
        # player actually does — an "all-rounder" who only ever tackles, a
        # "raider" who never raids. When the sample is big enough to trust
        # (act >= MIN_ACT) and the split is lopsided, the behaviour wins. A
        # genuinely balanced player keeps all-rounder.
        MIN_ACT, LO, HI = 20, 0.15, 0.85
        act = raids + tackles
        share = raids / act if act else 0.5
        overridden = False
        if act >= MIN_ACT:
            new = ("raider" if share > HI else "defender" if share < LO else role)
            if role == "all-rounder" and new != role:
                role, overridden = new, True          # lopsided all-rounder
            elif role == "raider" and share < LO:
                role, overridden = "defender", True    # never actually raids
            elif role == "defender" and share > HI:
                role, overridden = "raider", True      # never actually tackles

        subrole, inferred = None, False
        if role == "defender":
            labels = pd.Series([_subrole(r) or _subrole(s)
                                for r, s in zip(g["role_raw"], g["skill_raw"])]).dropna()
            if len(labels):
                subrole = labels.mode().iloc[0]
            elif pid in seeds:
                subrole = seeds[pid]
            else:
                # Never labelled anywhere. Default to cover (the more common job)
                # and flag it, so it can be seeded later without guesswork.
                subrole, inferred = "cover", True

        cell = {"raider": "raider", "all-rounder": "all-rounder"}.get(role)
        if role == "defender":
            cell = f"defender-{subrole}"

        rows.append({
            "player_id": pid, "name": name, "position": role, "subrole": subrole,
            "cell": cell, "subrole_inferred": inferred, "role_overridden": overridden,
            "matches": int(g["match_id"].nunique()),
            "raids": raids, "tackles": tackles,
            "last_team": g.sort_values("date")["team_id"].dropna().iloc[-1]
                         if g["team_id"].notna().any() else None,
            "first_year": int(g["year"].min()) if g["year"].notna().any() else None,
            "last_year": int(g["year"].max()) if g["year"].notna().any() else None,
            "seasons": int(g["season_id"].nunique()),
        })

    roles = pd.DataFrame(rows)
    os.makedirs(out, exist_ok=True)
    roles.to_parquet(os.path.join(out, "roles.parquet"))
    roles[["player_id", "name", "position", "subrole", "cell", "last_team",
           "first_year", "last_year", "matches"]].to_parquet(
        os.path.join(out, "players.parquet"))

    print(f"{len(roles)} players")
    print(roles["cell"].value_counts().to_string())
    ov = int(roles["role_overridden"].sum())
    if ov:
        print(f"  ({ov} player(s) reassigned from their feed position by "
              f"raid/tackle balance)")
    inf = int(roles["subrole_inferred"].sum())
    if inf:
        print(f"  ({inf} defender(s) with an inferred corner/cover; add to "
              f"config/kabaddi/defender_seeds.csv to pin)")
    return roles


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="all")
    ap.add_argument("--raw", default=RAW)
    ap.add_argument("--facts", default=FACTS)
    ap.add_argument("--out", default=DATA)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(os.path.join(CFG, "seasons.yml")))
    ids = ([str(s["id"]) for s in cfg["seasons"]] if args.seasons == "all"
           else args.seasons.replace(",", " ").split())
    build(ids, args.raw, args.facts, args.out)


if __name__ == "__main__":
    main()
