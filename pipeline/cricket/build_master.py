"""Fold per-match facts into the master table.

Nothing here reads a match file. The parser already did that, and re-reading
eighteen million deliveries to add a column is the one mistake in this pipeline
that is expensive to undo. Everything below is a group-by.

Four things come out:

  players.parquet   one row per person: names, derived role, bowler type, the
                    teams they turn out for, when they were last seen
  master.parquet    player x competition x season x format x discipline x phase
  matchup.parquet   player x competition x season x format, split by whether the
                    bowler was pace or spin
  meta.json         what the run did, in the style of the football reports

Two things are derived rather than sourced, both for the same reason: no open
source carries them reliably, and both are recoverable from the deliveries.

  bowler type   pace or spin, from where in the innings a bowler operates, what
                they concede and whether anyone is ever stumped off them. Seeded
                with a small label file, because unsupervised clustering mistakes
                part-time medium pacers for spinners.
  role          opener, middle order, finisher, pace, spin, keeper — from median
                batting position, workload and who takes the stumpings. The
                labels attached to cricketers elsewhere are unreliable and
                disagree with each other; what a player actually did does not.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

FACTS = os.path.join("data", "cricket", "facts")
OUT = os.path.join("data", "cricket")
SEEDS = os.path.join("config", "cricket", "bowler_seeds.csv")

TYPE_FEATURES = ["mean_over", "share_1", "share_2", "share_3", "stump_rate",
                 "wide_rate", "nb_rate", "dot_rate", "four_rate", "six_rate",
                 "econ", "six_four"]


def load(kind: str, root: str = None) -> pd.DataFrame:
    files = sorted(glob.glob(os.path.join(root or FACTS, f"*_{kind}.parquet")))
    if not files:
        raise SystemExit(f"no {kind} files in {root or FACTS} — run parse_matches.py first")
    return pd.concat((pd.read_parquet(f) for f in files), ignore_index=True)


# ── bowler type ──────────────────────────────────────────────────────────────

def classify_bowlers(facts: pd.DataFrame, apps: pd.DataFrame, min_balls: int = 300):
    """Pace or spin, for every bowler with enough of a record to judge."""
    bp = facts[facts["kind"] == "bowl_phase"]
    if bp.empty:
        return pd.DataFrame(columns=["bowler_type", "p_spin"])

    # Phase order differs by format, so index them rather than name them.
    order = (bp.groupby(["format", "bucket"])["balls"].sum().reset_index()
               .sort_values(["format", "balls"], ascending=[True, False]))
    idx = {}
    for fmt, grp in bp.groupby("format"):
        names = [b for b in ["powerplay", "new_ball", "middle", "death", "old_ball"]
                 if b in set(grp["bucket"])]
        for i, n in enumerate(names[:3], start=1):
            idx[(fmt, n)] = i
    bp = bp.assign(slot=[idx.get((f, b), 2) for f, b in zip(bp["format"], bp["bucket"])])

    g = bp.groupby("player_id")
    b = pd.DataFrame({
        "balls": g["balls"].sum(), "runs": g["runs"].sum(), "wkts": g["wkts"].sum(),
        "dots": g["dots"].sum(), "fours": g["fours"].sum(), "sixes": g["sixes"].sum(),
        "wides": g["wides"].sum(), "noballs": g["noballs"].sum(),
    })
    for s in (1, 2, 3):
        b[f"share_{s}"] = (bp[bp["slot"] == s].groupby("player_id")["balls"].sum()
                           .reindex(b.index).fillna(0) / b["balls"].clip(lower=1))
    # Mean over is proxied by the phase mix, which travels across formats where a
    # raw over number does not.
    b["mean_over"] = b["share_1"] * 3 + b["share_2"] * 11 + b["share_3"] * 18

    # Stumpings credited to the bowler by the parser. Of the bowlers who have
    # never conceded one, every labelled case in testing was pace.
    st = (bp.groupby("player_id")["stumped"].sum() if "stumped" in bp
          else pd.Series(0.0, index=b.index))
    b["stump_rate"] = st.reindex(b.index).fillna(0) / b["balls"].clip(lower=1)

    b["wide_rate"] = b["wides"] / b["balls"].clip(lower=1)
    b["nb_rate"] = b["noballs"] / b["balls"].clip(lower=1)
    b["dot_rate"] = b["dots"] / b["balls"].clip(lower=1)
    b["four_rate"] = b["fours"] / b["balls"].clip(lower=1)
    b["six_rate"] = b["sixes"] / b["balls"].clip(lower=1)
    b["econ"] = b["runs"] / b["balls"].clip(lower=1) * 6
    b["six_four"] = b["sixes"] / (b["fours"] + b["sixes"]).clip(lower=1)

    pool = b[b["balls"] >= min_balls].copy()
    if len(pool) < 40:
        return pd.DataFrame(index=b.index, data={"bowler_type": None, "p_spin": np.nan})

    names = apps.drop_duplicates("player_id").set_index("player_id")["player_name"]
    seeds = pd.read_csv(SEEDS, comment="#")
    by_name = {n: t for n, t in zip(seeds["name"], seeds["type"])}
    pool["seed"] = [by_name.get(names.get(i)) for i in pool.index]

    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    lab = pool[pool["seed"].notna()]
    X = pool[TYPE_FEATURES].replace([np.inf, -np.inf], np.nan).fillna(0).to_numpy(float)
    if len(lab) >= 20 and lab["seed"].nunique() == 2:
        model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000))
        model.fit(lab[TYPE_FEATURES].fillna(0).to_numpy(float), (lab["seed"] == "S").astype(int))
        p = model.predict_proba(X)[:, 1]
        seeded = True
    else:
        from sklearn.cluster import KMeans
        Z = StandardScaler().fit_transform(X)
        km = KMeans(n_clusters=2, n_init=25, random_state=0).fit(Z)
        spin = pd.Series(km.labels_).groupby(km.labels_).size().index[
            int(np.argmax([pool["stump_rate"].to_numpy()[km.labels_ == c].mean() for c in (0, 1)]))]
        p = (km.labels_ == spin).astype(float)
        seeded = False

    pool["p_spin"] = p
    # Anything the model is not clearly sure about stays blank. A blank type
    # drops that bowler from the pace/spin split and nothing else.
    pool["bowler_type"] = np.where(pool["p_spin"] >= .85, "spin",
                          np.where(pool["p_spin"] <= .15, "pace", None))
    out = pool[["bowler_type", "p_spin"]].reindex(b.index)
    out.attrs["seeded"] = seeded
    out.attrs["labelled"] = int(len(lab))
    out.attrs["unsure"] = int(((pool["p_spin"] > .15) & (pool["p_spin"] < .85)).sum())
    out.attrs["pool"] = int(len(pool))
    return out


# ── roles ────────────────────────────────────────────────────────────────────

def derive_roles(apps: pd.DataFrame, facts: pd.DataFrame, types: pd.DataFrame) -> pd.DataFrame:
    """What a player actually did, per format. Not what anyone labelled them."""
    bat = (facts[facts["kind"] == "bat_phase"].groupby(["player_id", "format"])
           .agg(bat_balls=("balls", "sum"), runs=("runs", "sum"), outs=("outs", "sum")))
    bowl = (facts[facts["kind"] == "bowl_phase"].groupby(["player_id", "format"])
            .agg(bowl_balls=("balls", "sum"), conceded=("runs", "sum"), wkts=("wkts", "sum")))
    played = apps.groupby(["player_id", "format"]).agg(
        matches=("match_id", "nunique"),
        bat_pos=("bat_pos", lambda s: s[s < 99].median()))
    fld = (facts[facts["kind"] == "field"].groupby(["player_id", "format"])
           .agg(catches=("catches", "sum"), stumpings=("stumpings", "sum"),
                run_outs=("run_outs", "sum")))

    r = played.join([bat, bowl, fld], how="left").fillna(0).reset_index()
    r["bat_per_match"] = r["bat_balls"] / r["matches"].clip(lower=1)
    r["bowl_per_match"] = r["bowl_balls"] / r["matches"].clip(lower=1)
    r["keeper"] = r["stumpings"] > 0

    # A workload that means "this player bats" in a T20 is noise in a Test, where
    # a genuine number eleven faces more balls per match than a T20 opener. So
    # the thresholds scale with the format rather than being one number.
    THRESHOLD = {                     # (balls faced, balls bowled) per match
        "T20": (10, 12), "HUNDRED": (9, 10), "ODI": (24, 24), "FIRST_CLASS": (55, 60),
    }

    t = types["bowler_type"].to_dict()

    def label(row):
        bat_min, bowl_min = THRESHOLD.get(row["format"], (10, 12))
        bowls = row["bowl_per_match"] >= bowl_min
        bats = row["bat_per_match"] >= bat_min
        pos = row["bat_pos"]
        kind = t.get(row["player_id"])
        kind = None if (kind is None or pd.isna(kind)) else kind
        named = {"pace": "pace bowler", "spin": "spin bowler"}.get(kind, "bowler")

        # Bowling workload alone must not overrule a top-order position. A
        # player who bats four and sends down five overs is a batter who bowls.
        top_order = 0 < pos <= 6.5
        if bowls and not bats and not top_order:
            return named
        # Position decides what kind of batter someone is, and it overrules
        # volume: a number eleven who faces plenty of balls across a long Test
        # career is still a number eleven, not a finisher.
        if not pos or pos <= 0:
            bat_role = "batter"
        elif pos <= 2.5:
            bat_role = "opener"
        elif pos <= 4.5:
            bat_role = "top middle"
        elif pos <= 6.5:
            bat_role = "middle"
        elif pos <= 8.5:
            bat_role = "finisher"
        else:
            bat_role = "tail"
        if bat_role == "tail":
            return named if bowls else "tail"
        if bowls and (bats or top_order):
            return f"{bat_role} / {kind} all-rounder" if kind else f"{bat_role} all-rounder"
        return bat_role

    r["role"] = r.apply(label, axis=1)
    r["bowler_type"] = r["player_id"].map(t)
    return r


# ── master ───────────────────────────────────────────────────────────────────

KEYS = ["player_id", "competition", "competition_name", "tier", "format",
        "gender", "season"]


def build_master(facts: pd.DataFrame, apps: pd.DataFrame) -> pd.DataFrame:
    played = apps.groupby(KEYS).agg(matches=("match_id", "nunique")).reset_index()
    rows = []
    for kind, disc in (("bat_phase", "batting"), ("bowl_phase", "bowling")):
        sub = facts[facts["kind"] == kind]
        if sub.empty:
            continue
        cols = [c for c in ["balls", "runs", "dots", "fours", "sixes", "outs",
                            "wkts", "wides", "noballs"] if c in sub]
        agg = sub.groupby(KEYS + ["bucket"])[cols].sum().reset_index()
        agg["discipline"] = disc
        agg = agg.rename(columns={"bucket": "phase"})
        rows.append(agg)
    m = pd.concat(rows, ignore_index=True)
    return m.merge(played, on=KEYS, how="left")


def build_matchup(facts: pd.DataFrame, types: pd.DataFrame) -> pd.DataFrame:
    """A batter's record split by whether the bowler was pace or spin.

    This is why the parser keeps batter-against-bowler pairs. Splitting on type
    at parse time would have frozen a classification that is itself derived from
    this data, and would have to be thrown away the first time it improved.
    """
    vb = facts[facts["kind"] == "bat_vs_bowler"].copy()
    if vb.empty:
        return pd.DataFrame()
    vb["bowler_type"] = vb["bucket"].map(types["bowler_type"].to_dict())
    vb = vb[vb["bowler_type"].notna()]
    cols = [c for c in ["balls", "runs", "dots", "fours", "sixes", "outs"] if c in vb]
    return vb.groupby(KEYS + ["bowler_type"])[cols].sum().reset_index()


def build_players(apps: pd.DataFrame, roles: pd.DataFrame, types: pd.DataFrame) -> pd.DataFrame:
    """One row per person.

    There is deliberately no 'current club'. A cricketer does not have one: the
    same player turns out for a franchise, a county and a country in the same
    season. Teams are held per competition instead, which is what the data says
    and what a scout actually needs.
    """
    apps = apps.copy()
    apps["date"] = pd.to_datetime(apps["date"], errors="coerce")
    g = apps.sort_values("date").groupby("player_id")
    p = pd.DataFrame({
        "name": g["player_name"].last(),
        "matches": g["match_id"].nunique(),
        "first_seen": g["date"].min(),
        "last_seen": g["date"].max(),
        "formats": g["format"].apply(lambda s: ",".join(sorted(set(s)))),
        "competitions": g["competition"].apply(lambda s: ",".join(sorted(set(s)))),
    })
    teams = (apps.sort_values("date").groupby(["player_id", "competition"])["team"]
             .last().reset_index()
             .groupby("player_id")
             .apply(lambda d: "; ".join(f"{c}:{t}" for c, t in zip(d["competition"], d["team"])),
                    include_groups=False))
    p["teams"] = teams
    p = p.join(types)
    primary = (roles.sort_values("matches", ascending=False)
               .drop_duplicates("player_id").set_index("player_id")["role"])
    p["role"] = primary
    return p.reset_index()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--facts", default=FACTS)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--min-type-balls", type=int, default=300)
    args = ap.parse_args()

    apps = load("appearances", args.facts)
    facts = load("facts", args.facts)
    print(f"loaded  {len(apps):,} appearance rows, {len(facts):,} fact rows, "
          f"{apps['match_id'].nunique():,} matches")

    types = classify_bowlers(facts, apps, args.min_type_balls)
    known = types["bowler_type"].notna().sum()
    print(f"bowler type: {known:,} classified "
          f"({(types['bowler_type'] == 'pace').sum():,} pace, "
          f"{(types['bowler_type'] == 'spin').sum():,} spin), "
          f"{types.attrs.get('unsure', 0)} left blank as unsure")

    roles = derive_roles(apps, facts, types)
    master = build_master(facts, apps)
    matchup = build_matchup(facts, types)
    players = build_players(apps, roles, types)

    os.makedirs(args.out, exist_ok=True)
    for name, df in (("master", master), ("matchup", matchup),
                     ("players", players), ("roles", roles)):
        df.to_parquet(os.path.join(args.out, f"{name}.parquet"), index=False)
        print(f"  {name:8} {len(df):>9,} rows")

    meta = {
        "built_at": datetime.now(timezone.utc).isoformat(),
        "matches": int(apps["match_id"].nunique()),
        "players": int(apps["player_id"].nunique()),
        "competitions": sorted(apps["competition"].unique().tolist()),
        "formats": sorted(apps["format"].unique().tolist()),
        "tiers": sorted(apps["tier"].unique().tolist()),
        "seasons": [str(apps["season"].min()), str(apps["season"].max())],
        "bowler_types": {"classified": int(known),
                         "unsure": int(types.attrs.get("unsure", 0)),
                         "seeded": bool(types.attrs.get("seeded", False)),
                         "seed_labels_matched": int(types.attrs.get("labelled", 0))},
        "source": "Cricsheet (https://cricsheet.org), Open Data Commons Attribution Licence",
        "withheld": "Matches involving Afghanistan or the APL are withheld by Cricsheet.",
    }
    with open(os.path.join(args.out, "build_meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    print(f"\nwrote {args.out}/build_meta.json")


if __name__ == "__main__":
    main()
