"""Turn the master data into everything the dashboard reads.

Five steps, in order:

  1. aggregate    one career profile per player, rates from summed totals
  2. adjust       league strength, fitted from players who changed league
  3. percentile   rank each player against their position, after adjustment
  4. compare      standardise, compress with PCA, measure distance
  5. validate     split-half test, to show whether any of it means anything

Nothing here invents a metric. Everything is arithmetic on columns that exist
in the master file, and every derived quantity is named after what it measures.

    python pipeline/build_scores.py
    python pipeline/build_scores.py --min-minutes 900 --report
"""

import argparse
import json
import os
import re
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timezone

import numpy as np
import pandas as pd
from scipy import sparse
from scipy.sparse.linalg import lsqr
from sklearn.decomposition import PCA

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(HERE, "data", "master_players.csv")
TEAMS = os.path.join(HERE, "data", "team_seasons.csv")
OUT = os.path.join(HERE, "site", "data")

MIN_MINUTES = 1800
UNDERSTAT_URL = "https://understat.com/player/{id}"

# Counting stats summed across seasons, then divided by total minutes. Summing
# totals rather than averaging per-90s weights each season by how much the
# player actually played: a 3,000-minute season should not count the same as a
# 200-minute one.
TOTALS = ["minutes", "games", "goals", "assists", "xG", "npxG", "xA", "npg",
          "shots", "key_passes", "xGChain", "xGBuildup", "yellow_cards", "red_cards"]

# Metrics compared across players. Rates are per 90 minutes; ratios are not.
# Only the rates are league-adjusted - a ratio like xG per shot describes shot
# selection, which does not inflate in a weaker league the way volume does.
RATE_METRICS = ["npxG_90", "xA_90", "shots_90", "key_passes_90",
                "xGChain_90", "xGBuildup_90", "goals_90", "assists_90",
                "final_third_90"]
RATIO_METRICS = ["npxG_per_shot", "xA_per_key_pass", "finishing_90",
                 "involvement_share", "buildup_share"]
SIMILARITY_METRICS = RATE_METRICS + RATIO_METRICS

# The eight axes on the radar. Chosen to span the four things this data can
# actually see: shot volume, shot quality, creation, and involvement in
# possession.
RADAR_METRICS = ["npxG_90", "shots_90", "npxG_per_shot", "xA_90",
                 "key_passes_90", "xA_per_key_pass", "xGChain_90", "xGBuildup_90"]

# Goalkeepers get no similarity ranking - tested, and it performs at chance -
# but they are not blank. Build-up involvement is real and fully populated for
# them, so it is shown as percentiles with an explicit warning about what it
# measures.
GK_METRICS = ["xGBuildup_90", "xGChain_90", "key_passes_90", "xA_90"]
GK_CAVEAT = ("These measure how much of a team's build-up runs through its "
             "goalkeeper, which reflects the side's style and possession as "
             "much as the keeper. Three of the five most involved keepers here "
             "play for Bayern.")

# Grouped for the comparison view: a flat list of twelve rows reads as a data
# dump, three named blocks read as a scouting report.
METRIC_GROUPS = [
    {"name": "Shooting", "metrics": ["npxG_90", "shots_90", "npxG_per_shot",
                                     "goals_90", "finishing_90"]},
    {"name": "Creating", "metrics": ["xA_90", "key_passes_90",
                                     "xA_per_key_pass", "assists_90"]},
    {"name": "Involvement", "metrics": ["xGChain_90", "xGBuildup_90", "final_third_90"]},
]

# What the side was like, never what the player was like. PPDA is one number
# for eleven people, so these are carried as context and shown as such: they
# never enter the similarity model.
TEAM_CONTEXT = ["ppda", "npxGA_per_match", "deep_allowed_per_match", "rank_by_pts"]

TEAM_LABELS = {
    "ppda": "Opposition passes per defensive action",
    "npxGA_per_match": "Non-penalty xG conceded per match",
    "deep_allowed_per_match": "Deep entries allowed per match",
    "rank_by_pts": "League finish",
}

METRIC_LABELS = {
    "npxG_90": "Non-penalty xG", "xA_90": "Expected assists",
    "shots_90": "Shots", "key_passes_90": "Key passes",
    "xGChain_90": "Possession involvement", "xGBuildup_90": "Build-up involvement",
    "goals_90": "Goals", "assists_90": "Assists",
    "final_third_90": "Final-third involvement",
    "npxG_per_shot": "Shot quality", "xA_per_key_pass": "Chance quality created",
    "finishing_90": "Finishing above expected",
    "involvement_share": "Share of team threat",
    "buildup_share": "Share of team build-up",
}

# Short forms for chips and tight columns, where the full label will not fit.
METRIC_SHORT = {
    "npxG_90": "npxG", "xA_90": "xA", "shots_90": "shots",
    "key_passes_90": "key passes", "xGChain_90": "possession",
    "xGBuildup_90": "build-up", "goals_90": "goals", "assists_90": "assists",
    "final_third_90": "final third", "npxG_per_shot": "shot quality",
    "xA_per_key_pass": "chance quality", "finishing_90": "finishing",
    "involvement_share": "team share", "buildup_share": "build-up share",
}

METRIC_NOTES = {
    "involvement_share": "Of all the threat this player's team generated while "
                         "he was on the pitch, the share he was involved in. "
                         "Separates a side's main outlet from one contributor "
                         "among many.",
    "buildup_share": "The same, counting only involvement before the shot or "
                     "the pass that created it.",
    "xGChain_90": "Total xG of every possession this player was involved in, "
                  "per 90 minutes.",
    "xGBuildup_90": "The same, excluding their own shots and key passes - "
                    "involvement in building the move rather than finishing it.",
    "final_third_90": "Possession involvement minus build-up involvement: how "
                      "much of their contribution comes at the sharp end.",
    "npxG_per_shot": "Average quality of the chances they get on the ball.",
    "xA_per_key_pass": "Average quality of the chances they create for others.",
    "finishing_90": "Non-penalty goals minus non-penalty xG, per 90. Positive "
                    "means finishing above the quality of chances taken.",
}

# Exact sub-position is the default comparison pool. Right and Left Midfield
# hold 24 and 14 players, too few to rank against, so they fold into the
# nearest role. Everything else stands on its own.
POSITION_MERGE = {
    "Right Midfield": "Right Winger",
    "Left Midfield": "Left Winger",
    "Second Striker": "Attacking Midfield",
}

# Broader groups, offered as a way to widen the search rather than as the default.
POSITION_GROUP = {
    "Goalkeeper": "Goalkeeper",
    "Centre-Back": "Centre-Back",
    "Right-Back": "Full-Back", "Left-Back": "Full-Back",
    "Defensive Midfield": "Midfield", "Central Midfield": "Midfield",
    "Attacking Midfield": "Attacking Midfield & Wingers",
    "Right Winger": "Attacking Midfield & Wingers",
    "Left Winger": "Attacking Midfield & Wingers",
    "Centre-Forward": "Centre-Forward",
}

# How honestly to frame results for each position, given that this dataset
# contains no defensive or goalkeeping actions whatsoever.
POSITION_FRAMING = {
    "Goalkeeper": {
        "level": "distribution_only",
        "headline": "Build-up involvement only",
        "note": "No saves, claims or sweeping actions exist in this dataset, so "
                "goalkeepers are not ranked against each other. What can be "
                "shown is how involved they are in their team's build-up.",
    },
    "Centre-Back": {
        "level": "attacking_only",
        "headline": "Ranked on attacking contribution only",
        "note": "No tackles, interceptions, duels or clearances exist in this "
                "dataset. These are centre-backs whose progression and chance "
                "creation resemble the searched player's - not whose defending does.",
    },
    "Full-Back": {
        "level": "attacking_only",
        "headline": "Ranked on attacking contribution only",
        "note": "Defensive actions are not in this dataset. These full-backs "
                "match on how they create and join attacks, not on how they defend.",
    },
    "Midfield": {
        "level": "attacking_only",
        "headline": "Ranked on attacking contribution only",
        "note": "Ball-winning and defensive positioning are not measured here. "
                "The comparison covers progression, creation and involvement in "
                "possession.",
    },
    "default": {
        "level": "full",
        "headline": "Ranked across the full available metric set",
        "note": "Shot volume and quality, chance creation, and involvement in "
                "possession - the areas this dataset covers well for attacking players.",
    },
}


def log(msg):
    print(msg, flush=True)


# ── 1. aggregate ─────────────────────────────────────────────────────────────

def aggregate(master, min_minutes):
    """One career row per player, plus the per-season detail for trend charts."""
    master = master.copy()
    master["season_sort"] = master["season"].str[:4].astype(int)

    totals = master.groupby("player_uid")[TOTALS].sum()
    latest = (master.sort_values("season_sort")
              .groupby("player_uid").tail(1).set_index("player_uid"))
    leagues = master.groupby("player_uid")["league"].nunique()
    seasons = master.groupby("player_uid")["season"].nunique()

    frame = totals.join(latest[[
        "player", "tm_player", "team", "league", "season", "id", "tm_current_club",
        "tm_sub_position", "tm_date_of_birth", "tm_citizenship", "tm_foot",
        "tm_height_cm", "tm_contract_expires", "tm_market_value_eur",
        "tm_transfermarkt_url",
    ]])
    frame["leagues_played"] = leagues
    frame["seasons_played"] = seasons
    # A player's club in this file is whoever they last played for *inside the
    # big five*, which for someone who has moved on is years out of date: Di
    # Maria's last row here says Juventus, and he left in 2023. Transfermarkt
    # knows where they are now, so both are carried - where they play today, and
    # when they were last observed in this dataset.
    newest = frame["season"].max()
    frame["active"] = frame["season"] == newest
    frame = frame[frame["minutes"] >= min_minutes]
    frame = frame[frame["tm_sub_position"].notna()]

    frame["position"] = frame["tm_sub_position"].replace(POSITION_MERGE)
    frame["position_group"] = frame["position"].map(POSITION_GROUP).fillna("Midfield")
    return frame, master


def team_context(master, players, teams):
    """Minutes-weighted description of the sides a player turned out for, plus
    the two share metrics, which are the only genuinely player-level things the
    team data can produce.

    A share is the player's involvement divided by the threat his team generated
    while he was on the pitch. That normalises for how good the side was: two
    players with identical per-90 figures mean different things if one carried
    the attack and the other was a passenger in a better one.
    """
    rows = master[master["player_uid"].isin(players.index)].merge(
        teams, on=["league", "season", "team"], how="left", suffixes=("", "_team"))
    rows["minutes"] = rows["minutes"].fillna(0)

    # Team threat produced during this player's minutes, not across the season.
    share_of_season = rows["minutes"] / (rows["matches"] * 90).replace(0, np.nan)
    rows["team_threat_on"] = rows["npxG_team"] * share_of_season

    grouped = rows.groupby("player_uid")
    out = pd.DataFrame(index=players.index)
    out["team_threat_on"] = grouped["team_threat_on"].sum()

    weights = rows["minutes"]
    for field in TEAM_CONTEXT:
        if field not in rows.columns:
            continue
        valid = rows[field].notna() & (weights > 0)
        num = (rows[field] * weights).where(valid, 0).groupby(rows["player_uid"]).sum()
        den = weights.where(valid, 0).groupby(rows["player_uid"]).sum()
        out[f"team_{field}"] = (num / den.replace(0, np.nan))

    out["teams_played_for"] = grouped["team"].nunique()
    return out


def derive(frame):
    """Per-90 rates and ratios. Every one is arithmetic on a real column."""
    n90 = frame["minutes"] / 90.0
    out = frame.copy()
    for src, dst in [("npxG", "npxG_90"), ("xA", "xA_90"), ("shots", "shots_90"),
                     ("key_passes", "key_passes_90"), ("xGChain", "xGChain_90"),
                     ("xGBuildup", "xGBuildup_90"), ("goals", "goals_90"),
                     ("assists", "assists_90")]:
        out[dst] = out[src] / n90

    # Involvement at the sharp end: everything xGChain counts, minus the part
    # that is pure build-up.
    out["final_third_90"] = (out["xGChain"] - out["xGBuildup"]) / n90
    out["npxG_per_shot"] = np.where(out["shots"] > 0, out["npxG"] / out["shots"], 0.0)
    out["xA_per_key_pass"] = np.where(out["key_passes"] > 0,
                                      out["xA"] / out["key_passes"], 0.0)
    out["finishing_90"] = (out["npg"] - out["npxG"]) / n90

    if "team_threat_on" in out.columns:
        threat = out["team_threat_on"].replace(0, np.nan)
        out["involvement_share"] = (out["xGChain"] / threat).clip(0, 1.5).fillna(0)
        out["buildup_share"] = (out["xGBuildup"] / threat).clip(0, 1.5).fillna(0)
    else:
        out["involvement_share"] = 0.0
        out["buildup_share"] = 0.0
    return out


# ── 2. league strength ───────────────────────────────────────────────────────

def fit_league_effects(master, players, metrics):
    """Estimate how much each league inflates each metric.

    A player's output in a league is modelled as their own ability plus a league
    effect, on a log scale. Fitting player and league effects together means the
    league estimate comes from players observed in more than one of them - the
    same person before and after a move - rather than from comparing different
    populations, which would just measure which league has better players.

    Requires players who moved. With 760 of them across five leagues the graph
    is well connected.
    """
    rows = master[master["player_uid"].isin(players.index)].copy()
    spells = rows.groupby(["player_uid", "league"])[TOTALS].sum().reset_index()
    spells = spells[spells["minutes"] >= 450]
    spells = derive(spells.set_index(["player_uid", "league"])).reset_index()

    uids = sorted(spells["player_uid"].unique())
    lgs = sorted(spells["league"].unique())
    uid_ix = {u: i for i, u in enumerate(uids)}
    lg_ix = {l: i for i, l in enumerate(lgs)}
    movers = spells.groupby("player_uid")["league"].nunique()
    n_movers = int((movers > 1).sum())

    n, p, q = len(spells), len(uids), len(lgs)
    weights = np.sqrt(spells["minutes"].to_numpy() / 900.0)

    effects = {}
    for metric in metrics:
        y = spells[metric].to_numpy(dtype=float)
        keep = y > 0                      # log scale; zeros carry no ratio
        if keep.sum() < 50:
            effects[metric] = {l: 0.0 for l in lgs}
            continue
        idx = np.where(keep)[0]
        rowi = np.repeat(np.arange(len(idx)), 2)
        coli = np.empty(len(idx) * 2, dtype=int)
        coli[0::2] = [uid_ix[spells["player_uid"].iloc[i]] for i in idx]
        coli[1::2] = [p + lg_ix[spells["league"].iloc[i]] for i in idx]
        w = weights[idx]
        data = np.repeat(w, 2)
        A = sparse.csr_matrix((data, (rowi, coli)), shape=(len(idx), p + q))
        b = np.log(y[idx]) * w
        sol = lsqr(A, b, atol=1e-10, btol=1e-10, iter_lim=4000)[0]
        raw = sol[p:]
        # Only differences between leagues are identified, so centre them on a
        # minutes-weighted mean. A coefficient of 1.0 means "average league".
        mass = np.array([spells.loc[spells["league"] == l, "minutes"].sum() for l in lgs])
        centre = np.average(raw, weights=mass)
        effects[metric] = {l: float(np.exp(raw[i] - centre)) for i, l in enumerate(lgs)}
    return effects, n_movers, lgs


def apply_league_adjustment(players, master, effects):
    """Divide each rate by its league's coefficient, weighted by minutes there."""
    rows = master[master["player_uid"].isin(players.index)]
    minutes = rows.pivot_table(index="player_uid", columns="league",
                               values="minutes", aggfunc="sum").fillna(0.0)
    share = minutes.div(minutes.sum(axis=1), axis=0)

    adjusted = players.copy()
    for metric in RATE_METRICS:
        coef = pd.Series(effects.get(metric, {}))
        blended = share.reindex(columns=coef.index).fillna(0.0).mul(coef, axis=1).sum(axis=1)
        blended = blended.reindex(players.index).replace(0, 1.0).fillna(1.0)
        adjusted[metric] = players[metric] / blended
    return adjusted


# ── 3-4. percentiles, PCA, similarity ────────────────────────────────────────

def score_position(group, metrics):
    """Percentiles, PCA coordinates and pairwise distance inside one position."""
    raw = group[metrics].to_numpy(dtype=float)
    mean, std = raw.mean(axis=0), raw.std(axis=0)
    std[std == 0] = 1.0
    z = (raw - mean) / std

    # How many axes to keep was settled by experiment rather than by picking a
    # round share of the variance. Holding back at 80% cost real accuracy: right
    # wingers found themselves at median rank 34 on four axes and 26 on seven.
    # Low variance does not mean noise. Performance plateaus around eight, so
    # that is where this sits.
    n_comp = min(len(metrics), max(2, len(group) - 1), 10)
    pca = PCA(n_components=n_comp, random_state=0).fit(z)
    cumulative = np.cumsum(pca.explained_variance_ratio_)
    keep = int(np.searchsorted(cumulative, 0.95) + 1)
    keep = max(4, min(keep, n_comp))
    coords = pca.transform(z)[:, :keep]

    diff = coords[:, None, :] - coords[None, :, :]
    dist = np.sqrt((diff ** 2).sum(-1))
    offdiag = dist[~np.eye(len(group), dtype=bool)]
    median = float(np.median(offdiag)) if offdiag.size else 1.0

    pct = {}
    for j, metric in enumerate(metrics):
        order = raw[:, j].argsort().argsort()
        pct[metric] = 100.0 * order / max(1, len(group) - 1)

    loadings = [{
        "component": i + 1,
        "variance": round(float(pca.explained_variance_ratio_[i]), 4),
        "drivers": [{"metric": metrics[j], "weight": round(float(pca.components_[i][j]), 3)}
                    for j in np.argsort(-np.abs(pca.components_[i]))[:4]],
    } for i in range(keep)]

    return {"z": z, "coords": coords, "dist": dist, "median": median,
            "percentiles": pct, "components": keep,
            "variance": round(float(cumulative[keep - 1]), 4), "loadings": loadings}


def season_benchmarks(master, players):
    """The best single season in each position, to scale the history chart.

    A bar is meaningless without something to measure it against. Every
    player's seasons are drawn on the same axis as the strongest season any
    player in their position managed, so the reader can see at a glance whether
    0.69 is a good year.
    """
    rows = master[master["player_uid"].isin(players.index)].copy()
    rows = rows[rows["minutes"] >= 900]
    rows["pos"] = rows["player_uid"].map(players["position"])
    rows["output"] = rows["npxG_90"].fillna(0) + rows["xA_90"].fillna(0)

    out = {}
    for position, group in rows.dropna(subset=["pos"]).groupby("pos"):
        metric = "xGBuildup_90" if position == "Goalkeeper" else "output"
        values = group[metric].fillna(0)
        best = group.loc[values.idxmax()]
        entry = {
            "metric": "xGBuildup_90" if position == "Goalkeeper" else "npxG_plus_xA_90",
            "best": round(float(values.max()), 3),
            "best_player": best["player"],
            "best_season": best["season"],
            "best_team": best["team"],
            "median": round(float(values.median()), 3),
            "upper_quartile": round(float(values.quantile(0.75)), 3),
            "seasons": int(len(group)),
        }
        # The axis is the sum of two metrics, so the player who tops it is not
        # necessarily top of either part. Name the leader of each separately.
        for part, key in (("npxG_90", "top_npxg"), ("xA_90", "top_xa")):
            if part in group.columns:
                col = group[part].fillna(0)
                row = group.loc[col.idxmax()]
                entry[key] = {"value": round(float(col.max()), 3),
                              "player": row["player"], "season": row["season"],
                              "team": row["team"]}
        out[position] = entry
    return out


def match_score(distance, median):
    return round(float(100.0 * np.exp(-np.log(2) * distance / median)), 1)


# ── 5. validation ────────────────────────────────────────────────────────────

def validate(master, players, metrics, effects, teams=None):
    """Does a player's first-half profile find their own second half?

    Seasons are split into alternating halves, a profile built from each, and
    each player's own second-half profile ranked among all candidates. If the
    model were fitting noise, players would not find themselves.
    """
    m = master[master["player_uid"].isin(players.index)].copy()
    m["season_sort"] = m["season"].str[:4].astype(int)
    order = {s: i for i, s in enumerate(sorted(m["season"].unique()))}
    m["half"] = m["season"].map(order) % 2

    out = []
    for position, members in players.groupby("position"):
        if len(members) < 25:
            continue
        halves = {}
        for h in (0, 1):
            part = m[(m["half"] == h) & (m["player_uid"].isin(members.index))]
            tot = part.groupby("player_uid")[TOTALS].sum()
            tot = tot[tot["minutes"] >= 600]
            # The share metrics need their team denominator rebuilt from the
            # same half, or the test would score them against a whole career.
            if teams is not None:
                tot = tot.join(team_context(part, tot, teams)[["team_threat_on"]])
            halves[h] = derive(tot)
        shared = halves[0].index.intersection(halves[1].index)
        if len(shared) < 20:
            continue
        A = halves[0].loc[shared, metrics].to_numpy(dtype=float)
        B = halves[1].loc[shared, metrics].to_numpy(dtype=float)
        mean, std = A.mean(axis=0), A.std(axis=0)
        std[std == 0] = 1.0
        za, zb = (A - mean) / std, (B - mean) / std
        # Same rule the shipped model uses, so this measures what is deployed.
        n_comp = min(len(metrics), max(2, len(shared) - 1), 10)
        fit = PCA(n_components=n_comp, random_state=0).fit(za)
        keep = int(np.searchsorted(np.cumsum(fit.explained_variance_ratio_), 0.95) + 1)
        keep = max(4, min(keep, n_comp))
        pca = PCA(n_components=keep, random_state=0).fit(za)
        ca, cb = pca.transform(za), pca.transform(zb)
        d = np.sqrt(((ca[:, None, :] - cb[None, :, :]) ** 2).sum(-1))
        ranks = np.array([int(np.where(d[i].argsort() == i)[0][0]) + 1
                          for i in range(len(shared))])
        out.append({
            "position": position, "players": len(shared),
            "ranked_first": round(float((ranks == 1).mean()), 3),
            "top_five": round(float((ranks <= 5).mean()), 3),
            "median_rank": float(np.median(ranks)),
            "chance_median_rank": (len(shared) + 1) / 2,
            "components": keep,
        })
    return out


# ── export ───────────────────────────────────────────────────────────────────

CLUB_NOISE = re.compile(
    r"\b(fc|afc|cf|ac|as|sc|ssc|bc|bsc|us|ud|cd|rc|rcd|sd|sv|tsg|vfb|vfl|fsv|"
    r"hotspur|balompie|calcio|club|futbol|football|deportivo|societa|sportiva|"
    r"associazione|olympique|stade|racing|saint|city|united|munchen|muenchen)\b")


def same_club(a, b):
    """Are these two spellings the same club?

    The two sources name clubs differently — Tottenham against Tottenham
    Hotspur, Sassuolo against US Sassuolo — so a plain comparison reports a
    transfer every time a suffix differs. Only a genuine difference should
    surface in the interface.
    """
    def key(v):
        if not isinstance(v, str):
            return ""
        v = unicodedata.normalize("NFKD", v).encode("ascii", "ignore").decode().lower()
        v = re.sub(r"[^a-z0-9 ]", " ", v)
        v = CLUB_NOISE.sub(" ", v)
        return re.sub(r"\s+", " ", v).strip()
    ka, kb = key(a), key(b)
    if not ka or not kb:
        return True
    return ka == kb or ka in kb or kb in ka


def last_runs():
    """When each part of the pipeline last did something.

    Three separate events that people conflate: the season data being collected,
    the clubs being refreshed, and the model being run. Reading them off the run
    reports means the interface reports what happened rather than guessing.
    """
    import glob
    reports = os.path.join(HERE, "data", "reports")
    out = {}
    for pattern, key, stamp_field in (
            ("merge-*.json", "data", "built_at"),
            ("clubs-*.json", "clubs", "refreshed_at")):
        files = sorted(glob.glob(os.path.join(reports, pattern)))
        if not files:
            continue
        try:
            with open(files[-1]) as f:
                report = json.load(f)
        except Exception:
            continue
        entry = {"at": report.get(stamp_field)}
        if key == "data":
            entry["league_seasons"] = report.get("league_seasons", [])
            entry["rows"] = report.get("master_rows")
        else:
            entry["upstream_snapshot"] = report.get("upstream_snapshot")
            entry["club_moves"] = len(report.get("club_moves") or [])
            entry["fields"] = report.get("fields", {})
        out[key] = entry
    return out


def age_on(dob, today):
    if not isinstance(dob, str) or len(dob) < 10:
        return None
    y, mth, d = int(dob[:4]), int(dob[5:7]), int(dob[8:10])
    return today.year - y - ((today.month, today.day) < (mth, d))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-minutes", type=int, default=MIN_MINUTES)
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--master", default=MASTER, help="path to master_players.csv")
    args = ap.parse_args()
    today = date.today()

    master = pd.read_csv(args.master, low_memory=False)
    log(f"master: {len(master):,} rows")

    players, master = aggregate(master, args.min_minutes)

    teams = pd.read_csv(TEAMS) if os.path.exists(TEAMS) else None
    if teams is not None:
        ctx = team_context(master, players, teams)
        players = players.join(ctx)
        log(f"teams:  {len(teams):,} team-seasons joined")
    else:
        log("teams:  no team_seasons.csv found — share metrics will be zero")
    players = derive(players)
    log(f"pool:   {len(players):,} players at {args.min_minutes}+ career minutes")

    log("\nfitting league strength")
    effects, n_movers, lgs = fit_league_effects(master, players, RATE_METRICS)
    log(f"  from {n_movers} players observed in more than one league")
    head = "  " + "league".ljust(16) + "".join(f"{METRIC_LABELS[m][:11]:>13}"
                                               for m in RATE_METRICS[:4])
    log(head)
    for l in lgs:
        log("  " + l.ljust(16) + "".join(f"{effects[m][l]:13.3f}" for m in RATE_METRICS[:4]))

    adjusted = apply_league_adjustment(players, master, effects)

    log("\nscoring by position")
    payload, position_meta, group_meta = {}, {}, {}
    for position, members in adjusted.groupby("position"):
        framing = POSITION_FRAMING.get(
            POSITION_GROUP.get(position, ""), POSITION_FRAMING["default"])
        if framing["level"] != "full" and framing["level"] == "distribution_only":
            # Percentiles only, no ranking.
            sub = members[GK_METRICS].to_numpy(dtype=float)
            for i, uid in enumerate(members.index):
                pct = {}
                for j, metric in enumerate(GK_METRICS):
                    order = sub[:, j].argsort().argsort()
                    pct[metric] = int(round(100.0 * order[i] / max(1, len(members) - 1)))
                payload[uid] = {"coords": [], "pct": pct}
            position_meta[position] = {"players": len(members), "scored": False,
                                       "metrics": GK_METRICS, "caveat": GK_CAVEAT,
                                       **framing}
            log(f"  {position:22} {len(members):4}  percentiles only, not ranked")
            continue
        if len(members) < 12:
            for uid in members.index:
                payload[uid] = {"coords": [], "pct": {}}
            position_meta[position] = {"players": len(members), "scored": False,
                                       **framing}
            log(f"  {position:22} {len(members):4}  not scored ({framing['level']})")
            continue
        art = score_position(members, SIMILARITY_METRICS)
        uids = list(members.index)
        for i, uid in enumerate(uids):
            payload[uid] = {
                "coords": [round(float(v), 4) for v in art["coords"][i]],
                "pct": {k: int(round(art["percentiles"][k][i]))
                        for k in SIMILARITY_METRICS},
            }
        position_meta[position] = {
            "players": len(members), "scored": True,
            "components": art["components"], "variance": art["variance"],
            "loadings": art["loadings"], "median_distance": round(art["median"], 3),
            **framing,
        }
        log(f"  {position:22} {len(members):4}  {art['components']} components, "
            f"{art['variance']:.0%} of variance")

    # A second, wider space so "broaden the search" is a real comparison rather
    # than a merge of coordinates from different PCA fits, which would be
    # meaningless: each position's components describe that position only.
    log("\nscoring by position group")
    for group, members in adjusted.groupby("position_group"):
        framing = POSITION_FRAMING.get(group, POSITION_FRAMING["default"])
        if framing["level"] != "full" and framing["level"] == "distribution_only":
            continue
        if len(members) < 12:
            continue
        art = score_position(members, SIMILARITY_METRICS)
        for i, uid in enumerate(members.index):
            payload[uid]["group_coords"] = [round(float(v), 4) for v in art["coords"][i]]
        group_meta[group] = {
            "players": len(members), "components": art["components"],
            "variance": art["variance"], "median_distance": round(art["median"], 3),
            "positions": sorted(members["position"].unique().tolist()),
            **framing,
        }
        log(f"  {group:30} {len(members):4}  {art['components']} components, "
            f"{art['variance']:.0%} of variance")

    benchmarks = season_benchmarks(master, adjusted)
    for position, b in position_meta.items():
        if position in benchmarks:
            b["benchmark"] = benchmarks[position]

    log("\nvalidating")
    checks = validate(master, adjusted, SIMILARITY_METRICS, effects, teams)
    for c in checks:
        log(f"  {c['position']:22} {c['players']:4}  first {c['ranked_first']:.0%}  "
            f"top five {c['top_five']:.0%}  median rank {c['median_rank']:.0f} "
            f"of {c['players']} (chance {c['chance_median_rank']:.0f})")

    os.makedirs(OUT, exist_ok=True)
    # Season rows travel as plain arrays against a schema in meta.json. Written
    # as objects, repeated key names were more than a third of the payload.
    season_rows = master[master["player_uid"].isin(players.index)]
    seasons_by_player = defaultdict(list)
    for r in season_rows.itertuples(index=False):
        seasons_by_player[r.player_uid].append([
            r.season, r.league, r.team,
            int(r.minutes or 0), int(r.games or 0),
            round(float(r.goals or 0), 1), round(float(r.assists or 0), 1),
            round(float(r.npxG_90 or 0), 3), round(float(r.xA_90 or 0), 3),
            round(float(r.shots_90 or 0), 2), round(float(r.key_passes_90 or 0), 2),
            round(float(r.xGChain_90 or 0), 3), round(float(r.xGBuildup_90 or 0), 3),
            None if pd.isna(r.tm_market_value_eur) else int(r.tm_market_value_eur),
        ])

    index, detail = [], {}
    for uid, row in adjusted.iterrows():
        raw = players.loc[uid]
        detail[uid] = {
            "raw": {m: round(float(players.loc[uid][m]), 4) for m in SIMILARITY_METRICS},
            "team": {f: (None if pd.isna(row.get(f"team_{f}"))
                         else round(float(row[f"team_{f}"]), 2)) for f in TEAM_CONTEXT},
            "adj": {m: round(float(row[m]), 4) for m in SIMILARITY_METRICS},
            "pct": payload[uid]["pct"],
            "history": seasons_by_player.get(uid, []),
        }
        index.append({
            "uid": uid,
            # Transfermarkt spells names properly - diacritics intact, and the
            # name the player is actually known by. Understat has "Mathis
            # Cherki" for Rayan Cherki and "Matthew Cash" for Matty. The other
            # spelling is kept so searching for it still works.
            "name": (row["player"] if pd.isna(row["tm_player"]) else str(row["tm_player"])),
            "alt_name": row["player"],
            "club": row["team"],
            "league": row["league"],
            # Only carried when the club genuinely differs from the one the
            # numbers came from, and true as of the last data refresh.
            "current_club": (None
                             if pd.isna(row["tm_current_club"])
                             or same_club(row["tm_current_club"], row["team"])
                             else str(row["tm_current_club"])),
            "last_season": row["season"],
            "active": bool(row["active"]),
            "position": row["position"],
            "group": row["position_group"],
            "nationality": None if pd.isna(row["tm_citizenship"]) else row["tm_citizenship"],
            "age": age_on(str(row["tm_date_of_birth"])[:10], today),
            "foot": None if pd.isna(row["tm_foot"]) else row["tm_foot"],
            "height": None if pd.isna(row["tm_height_cm"]) else int(row["tm_height_cm"]),
            "contract": None if pd.isna(row["tm_contract_expires"]) else str(row["tm_contract_expires"])[:10],
            "value": None if pd.isna(row["tm_market_value_eur"]) else int(row["tm_market_value_eur"]),
            "minutes": int(row["minutes"]),
            "seasons": int(row["seasons_played"]),
            "us_id": int(row["id"]),
            "transfermarkt": None if pd.isna(row["tm_transfermarkt_url"]) else row["tm_transfermarkt_url"],
            "coords": payload[uid]["coords"],
            "gcoords": payload[uid].get("group_coords", []),
        })

    with open(os.path.join(OUT, "index.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    with open(os.path.join(OUT, "detail.json"), "w") as f:
        json.dump(detail, f, separators=(",", ":"))

    meta = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "last_runs": last_runs(),
        "pool": len(index),
        "active_players": int(sum(1 for p in index if p["active"])),
        "latest_season": max(p["last_season"] for p in index),
        "understat_url": UNDERSTAT_URL,
        "min_minutes": args.min_minutes,
        "seasons": sorted(master["season"].unique().tolist()),
        "leagues": lgs,
        "metric_labels": METRIC_LABELS,
        "team_context": TEAM_CONTEXT,
        "team_labels": TEAM_LABELS,
        "metric_short": METRIC_SHORT,
        "metric_notes": METRIC_NOTES,
        "similarity_metrics": SIMILARITY_METRICS,
        "radar_metrics": RADAR_METRICS,
        "gk_metrics": GK_METRICS,
        "metric_groups": METRIC_GROUPS,
        "history_schema": ["season", "league", "team", "minutes", "games", "goals",
                           "assists", "npxG_90", "xA_90", "shots_90",
                           "key_passes_90", "xGChain_90", "xGBuildup_90", "value"],
        "rate_metrics": RATE_METRICS,
        "league_effects": {m: {l: round(v, 4) for l, v in d.items()}
                           for m, d in effects.items()},
        "league_movers": n_movers,
        "positions": position_meta,
        "groups": group_meta,
        "position_groups": POSITION_GROUP,
        "validation": checks,
    }
    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)

    for name in ("index.json", "detail.json", "meta.json"):
        log(f"  site/data/{name}  {os.path.getsize(os.path.join(OUT, name)) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
