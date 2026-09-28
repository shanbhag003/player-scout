"""The kabaddi model.

Same method as the cricket side, minus the one thing kabaddi does not need:

  No competition levelling. There is one competition — the PKL — so there is no
  cross-competition standard to fit or correct for. That whole stage is gone, and
  with it the mover pool and the per-metric coefficients.

What carries over:

  Role cells are the partition. A raider and a cover defender are different games
  and live in different spaces. Four cells — raider, defender-corner,
  defender-cover, all-rounder — each fitted on its own metric set with its own
  PCA, exactly as batters and bowlers are on the cricket side.

  Small samples are shrunk toward the cell mean, so the top of a similarity list
  is not three good matches.

  Old seasons count for less. A career answers "what was this player"; a signing
  bets forward, and kabaddi form moves season to season, so every count is
  weighted on a half-life measured from the player's own last match. Raw totals
  are shown; the weighted shape is what similarity runs on.

Ships index.json, detail.json, meta.json and per-player match logs, in the same
shape the site already reads for cricket, so kabaddi.js is a thin variant.

    python pipeline/kabaddi/build_kabaddi_scores.py
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import yaml
from sklearn.decomposition import PCA

HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FACTS = os.path.join(HERE, "data", "kabaddi", "facts")
DATA = os.path.join(HERE, "data", "kabaddi")
OUT = os.path.join(HERE, "site", "data", "kabaddi")
CFG = os.path.join(HERE, "config", "kabaddi")

MIN_MATCHES = 5           # enough to place a player in the pool
THIN_MATCHES = 12         # below this a profile is shown but flagged
MIN_CELL = 10             # players needed to fit a cell
MIN_CELL_VALIDATE = 20
MIN_HALF = 4              # matches per half, to be testable
SHRINK_K = 10             # matches at which a profile is half its own, half pool
HALF_LIFE = 3.0          # years after which a match counts half
VARIANCE = 0.95
MIN_COMPONENTS, MAX_COMPONENTS = 3, 8

# Count columns carried on every player-match fact.
COUNTS = ["raids", "raids_succ", "raids_unsucc", "raids_empty", "super_raids",
          "raid_pts", "raid_touch_pts", "raid_bonus_pts", "dod_raids", "dod_succ",
          "dod_pts", "tackles", "tackles_succ", "tackles_unsucc", "super_tackles",
          "tackle_pts", "tackle_capture_pts", "tackle_bonus_pts", "solo_tackles",
          "assisted_tackles", "total_pts"]
FLAGS = ["super_ten", "high_five"]           # per-match booleans -> match counts

RAID_METRICS = ["raid_pts_pm", "raid_succ_pct", "empty_pct", "super_raid_rate",
                "dod_conv", "touch_share", "super_ten_rate", "pts_per_raid"]
DEF_METRICS = ["tackle_pts_pm", "tackle_succ_pct", "super_tackle_rate",
               "assisted_share", "high_five_rate", "capture_share", "tackles_pm"]
ALL_METRICS = ["raid_pts_pm", "tackle_pts_pm", "raid_succ_pct", "tackle_succ_pct",
               "def_off_balance", "super_raid_rate", "super_tackle_rate"]
CELL_METRICS = {"raider": RAID_METRICS, "all-rounder": ALL_METRICS,
                "defender-corner": DEF_METRICS, "defender-cover": DEF_METRICS}
LOWER_IS_BETTER = {"empty_pct"}

LABELS = {
    "raid_pts_pm": "Raid points / match", "raid_succ_pct": "Successful raid %",
    "empty_pct": "Empty raid %", "super_raid_rate": "Super raids / match",
    "dod_conv": "Do-or-die conversion %", "touch_share": "Touch-point share %",
    "super_ten_rate": "Super-10 rate", "pts_per_raid": "Points / successful raid",
    "tackle_pts_pm": "Tackle points / match", "tackle_succ_pct": "Tackle success %",
    "super_tackle_rate": "Super tackles / match", "assisted_share": "Assisted-tackle %",
    "high_five_rate": "High-5 rate", "capture_share": "Capture-point share %",
    "tackles_pm": "Tackles / match", "def_off_balance": "Defence share of points %",
}


def _safe(num, den, scale=1.0):
    den = np.asarray(den, float)
    return np.where(den > 0, np.asarray(num, float) / np.where(den > 0, den, 1) * scale, np.nan)


def load_facts(seasons):
    fs = [os.path.join(FACTS, f"{s}_player_match.parquet") for s in seasons]
    fs = [f for f in fs if os.path.exists(f)]
    if not fs:
        raise SystemExit("no fact files - run parse_matches first")
    df = pd.concat((pd.read_parquet(f) for f in fs), ignore_index=True)
    for c in FLAGS:
        df[c] = df[c].astype(int)
    return df


def weight_by_recency(facts, half_life):
    """Per-match weight on a half-life from each player's own last match."""
    f = facts.copy()
    if not half_life:
        f["w"] = 1.0
        return f
    d = pd.to_datetime(f["date"], errors="coerce")
    last = d.groupby(f["player_id"]).transform("max")
    age = (last - d).dt.days / 365.25
    f["w"] = np.power(0.5, age.fillna(0).clip(lower=0) / half_life)
    return f


def aggregate(facts, weighted):
    """Per-player summed counts and match count (raw, or w-weighted for shape)."""
    f = facts.copy()
    w = f["w"] if weighted else 1.0
    for c in COUNTS + FLAGS:
        f[c] = f[c] * w
    g = f.groupby("player_id")
    agg = g[COUNTS + FLAGS].sum()
    agg["matches"] = (g["w"].sum() if weighted else g["match_id"].nunique())
    agg["matches_raw"] = g["match_id"].nunique()
    return agg


def metrics(agg):
    """Every rate metric, from the summed counts. Rates are per match or %."""
    m = agg
    out = pd.DataFrame(index=m.index)
    mt = m["matches"].clip(lower=1e-9)
    out["raid_pts_pm"] = m["raid_pts"] / mt
    out["raid_succ_pct"] = _safe(m["raids_succ"], m["raids"], 100)
    out["empty_pct"] = _safe(m["raids_empty"], m["raids"], 100)
    out["super_raid_rate"] = m["super_raids"] / mt
    out["dod_conv"] = _safe(m["dod_succ"], m["dod_raids"], 100)
    out["touch_share"] = _safe(m["raid_touch_pts"], m["raid_pts"], 100)
    out["super_ten_rate"] = m["super_ten"] / mt
    out["pts_per_raid"] = _safe(m["raid_pts"], m["raids_succ"])
    out["tackle_pts_pm"] = m["tackle_pts"] / mt
    out["tackle_succ_pct"] = _safe(m["tackles_succ"], m["tackles"], 100)
    out["super_tackle_rate"] = m["super_tackles"] / mt
    out["assisted_share"] = _safe(m["assisted_tackles"],
                                  m["solo_tackles"] + m["assisted_tackles"], 100)
    out["high_five_rate"] = m["high_five"] / mt
    out["capture_share"] = _safe(m["tackle_capture_pts"], m["tackle_pts"], 100)
    out["tackles_pm"] = m["tackles"] / mt
    out["def_off_balance"] = _safe(m["tackle_pts"], m["raid_pts"] + m["tackle_pts"], 100)
    return out


def shrink(prof, cols, matches, k=SHRINK_K):
    """Pull thin records toward the pool mean, weighted by matches/(matches+k)."""
    X = prof[cols].to_numpy(float)
    mu = np.nanmean(X, axis=0)
    X = np.where(np.isfinite(X), X, mu)
    w = (matches.to_numpy(float) / (matches.to_numpy(float) + k))[:, None]
    return pd.DataFrame(w * X + (1 - w) * mu, index=prof.index, columns=cols)


def fit_space(z):
    n = min(z.shape[1], max(2, len(z) - 1), MAX_COMPONENTS)
    var = PCA(n_components=n, random_state=0).fit(z).explained_variance_ratio_
    k = max(MIN_COMPONENTS, min(int(np.searchsorted(np.cumsum(var), VARIANCE) + 1), n))
    p = PCA(n_components=k, random_state=0).fit(z)
    return p, k, float(np.cumsum(p.explained_variance_ratio_)[-1])


def self_rank(a, b):
    d = np.sqrt(((a[:, None, :] - b[None, :, :]) ** 2).sum(-1))
    return np.array([int(np.where(d[i].argsort() == i)[0][0]) + 1 for i in range(len(a))])


def season_history(facts):
    """Per player per season: a compact form line."""
    g = facts.groupby(["player_id", "season_id"])
    h = g[["raid_pts", "tackle_pts", "total_pts", "raids", "raids_succ",
           "tackles", "tackles_succ"]].sum()
    h["matches"] = g["match_id"].nunique()
    h["year"] = g["date"].apply(lambda s: pd.to_datetime(s, errors="coerce").dt.year.max())
    out = {}
    for (pid, sid), r in h.iterrows():
        out.setdefault(pid, []).append({
            "season": str(sid), "year": None if pd.isna(r["year"]) else int(r["year"]),
            "matches": int(r["matches"]),
            "raid_pts": int(r["raid_pts"]), "tackle_pts": int(r["tackle_pts"]),
            "total_pts": int(r["total_pts"]),
            "raid_succ_pct": round(float(_safe(r["raids_succ"], r["raids"], 100)), 1)
                             if r["raids"] else None,
            "tackle_succ_pct": round(float(_safe(r["tackles_succ"], r["tackles"], 100)), 1)
                               if r["tackles"] else None})
    for pid in out:
        out[pid].sort(key=lambda x: x["year"] or 0)
    return out


def write_match_logs(facts, teams, out_dir):
    """One file per player: their matches, newest first, for the modal."""
    mdir = os.path.join(out_dir, "matches")
    os.makedirs(mdir, exist_ok=True)
    # Show the season number (S1..S12), not the feed's internal series id.
    snum = {str(s["id"]): s["season"] for s in
            yaml.safe_load(open(os.path.join(CFG, "seasons.yml")))["seasons"]}
    for pid, g in facts.groupby("player_id"):
        rows = []
        for _, r in g.sort_values("date", ascending=False).iterrows():
            rows.append({
                "date": r["date"], "season": str(snum.get(str(r["season_id"]), r["season_id"])),
                "team": teams.get(str(r["team_id"]), str(r["team_id"])),
                "opp": teams.get(str(r["opp_id"]), str(r["opp_id"])),
                "raid_pts": int(r["raid_pts"]), "raids": int(r["raids"]),
                "raids_succ": int(r["raids_succ"]),
                "tackle_pts": int(r["tackle_pts"]), "tackles": int(r["tackles"]),
                "tackles_succ": int(r["tackles_succ"]),
                "total_pts": int(r["total_pts"]),
                "super10": bool(r["super_ten"]), "high5": bool(r["high_five"])})
        with open(os.path.join(mdir, f"{pid}.json"), "w") as fh:
            json.dump({"matches": rows}, fh, separators=(",", ":"))
    print(f"  match logs: {facts['player_id'].nunique()} players")


def team_names():
    out = {}
    for f in glob.glob(os.path.join(DATA, "raw", "teams", "*.json")):
        try:
            bio = json.load(open(f, encoding="utf-8")).get("bio", {})
        except Exception:
            continue
        if bio.get("team_id"):
            out[str(bio["team_id"])] = bio.get("team_name") or bio.get("short_name")
    return out


def build(seasons):
    facts = load_facts(seasons)
    roles = pd.read_parquet(os.path.join(DATA, "roles.parquet")).set_index("player_id")
    bio = (pd.read_parquet(os.path.join(DATA, "bio.parquet")).set_index("player_id")
           if os.path.exists(os.path.join(DATA, "bio.parquet")) else pd.DataFrame())
    teams = team_names()
    yr = {str(s["id"]): s["year"] for s in
          yaml.safe_load(open(os.path.join(CFG, "seasons.yml")))["seasons"]}
    facts["year"] = facts["season_id"].map(yr)
    max_year = int(facts["year"].max())

    fw = weight_by_recency(facts, HALF_LIFE)
    raw = aggregate(weight_by_recency(facts, 0), weighted=False)
    wtd = aggregate(fw, weighted=True)

    m_raw = metrics(raw)                 # for display (actual)
    m_wtd = metrics(wtd)                 # for the model (shape)

    cell = roles["cell"].reindex(m_wtd.index)
    matches_raw = raw["matches_raw"]
    pool = matches_raw[matches_raw >= MIN_MATCHES].index
    prof = m_wtd.loc[m_wtd.index.intersection(pool)].copy()
    prof_cell = cell.loc[prof.index]

    # Alternating matches for the split-half test.
    order = {mid: i for i, mid in enumerate(sorted(facts["match_id"].unique()))}
    facts["half"] = facts["match_id"].map(order) % 2

    spaces, validation, coords, pctd = {}, [], {}, {}
    for c, cols in CELL_METRICS.items():
        members = prof.index[prof_cell == c]
        if len(members) < MIN_CELL:
            continue
        sub = shrink(prof.loc[members], cols, wtd["matches"].loc[members])
        mu, sd = sub.mean(), sub.std().replace(0, 1)
        z = ((sub - mu) / sd).to_numpy()
        pca, k, var = fit_space(z)
        cc = pca.transform(z)
        for pid, row in zip(members, cc):
            coords[pid] = [round(float(x), 4) for x in row]

        # Percentile within the cell, on the shrunk metrics. Empty-raid % is the
        # one where lower is better, so its rank is flipped once here.
        ranked = sub.rank(pct=True) * 100
        for m in cols:
            if m in LOWER_IS_BETTER:
                ranked[m] = 100 - ranked[m]
        for pid in members:
            pctd[pid] = {m: round(float(ranked.at[pid, m]), 1) for m in cols}
        d = np.sqrt(((cc[:, None, :] - cc[None, :, :]) ** 2).sum(-1))
        med = float(np.median(d[np.triu_indices(len(cc), 1)])) if len(cc) > 1 else 1.0

        # Validation: split each member's matches in two, recompute, self-rank.
        halves = {}
        for h in (0, 1):
            hm = metrics(aggregate(weight_by_recency(
                facts[(facts["half"] == h) & facts["player_id"].isin(members)], 0), False))
            hc = facts[(facts["half"] == h)].groupby("player_id")["match_id"].nunique()
            halves[h] = hm[hc.reindex(hm.index).fillna(0) >= MIN_HALF]
        shared = sorted(set(members) & set(halves[0].index) & set(halves[1].index))
        if len(shared) >= MIN_CELL_VALIDATE:
            A = shrink(halves[0].loc[shared], cols, pd.Series(MIN_HALF, index=shared))
            B = shrink(halves[1].loc[shared], cols, pd.Series(MIN_HALF, index=shared))
            m2, s2 = A.mean(), A.std().replace(0, 1)
            pa, _, _ = fit_space(((A - m2) / s2).to_numpy())
            r = self_rank(pa.transform(((A - m2) / s2).to_numpy()),
                          pa.transform(((B - m2) / s2).to_numpy()))
            validation.append({"cell": c, "players": len(shared),
                               "median_rank": float(np.median(r)),
                               "chance_median_rank": (len(shared) + 1) / 2,
                               "ranked_first": round(float((r == 1).mean()), 3),
                               "top_five": round(float((r <= 5).mean()), 3)})
        spaces[c] = {"players": int(len(members)), "components": k,
                     "variance": round(var, 4), "median_distance": round(med, 4),
                     "metrics": cols, "mean": {x: round(float(mu[x]), 4) for x in cols},
                     "sd": {x: round(float(sd[x]), 4) for x in cols},
                     "loadings": [[round(float(v), 4) for v in comp] for comp in pca.components_]}

    hist = season_history(facts)
    emit(prof, prof_cell, coords, spaces, validation, pctd, m_raw, raw, roles, bio,
         teams, hist, facts, max_year, matches_raw)


def _nn(v):
    """NaN/NaT -> None. json.dump writes bare NaN otherwise, which is invalid JSON."""
    try:
        if v is None or (np.isscalar(v) and pd.isna(v)):
            return None
    except (TypeError, ValueError):
        pass
    return v


def emit(prof, prof_cell, coords, spaces, validation, pctd, m_raw, raw, roles, bio,
         teams, hist, facts, max_year, matches_raw):
    os.makedirs(OUT, exist_ok=True)
    last_year = facts.groupby("player_id")["year"].max()
    first_year = facts.groupby("player_id")["year"].min()
    last_team = (facts.sort_values("date").groupby("player_id")["team_id"].last())

    index, detail = [], {}
    for pid in prof.index:
        if pid not in coords:
            continue
        c = prof_cell[pid]
        r = roles.loc[pid] if pid in roles.index else {}
        b = bio.loc[pid] if pid in bio.index else {}
        name = (b.get("full_name") if isinstance(b, pd.Series) and pd.notna(b.get("full_name"))
                else r.get("name") if hasattr(r, "get") else pid)
        ly = None if pd.isna(last_year.get(pid)) else int(last_year.get(pid))
        index.append({
            "uid": pid, "player_id": pid, "name": name,
            "nationality": (b.get("nationality") if isinstance(b, pd.Series)
                            and pd.notna(b.get("nationality")) else None),
            "cell": c, "position": _nn(r.get("position")) if hasattr(r, "get") else None,
            "subrole": _nn(r.get("subrole")) if hasattr(r, "get") else None,
            "age": (float(b.get("age")) if isinstance(b, pd.Series)
                    and pd.notna(b.get("age")) else None),
            "matches": int(matches_raw.get(pid, 0)),
            "raids": int(raw.at[pid, "raids"]) if pid in raw.index else 0,
            "tackles": int(raw.at[pid, "tackles"]) if pid in raw.index else 0,
            "coords": coords[pid],
            "team": teams.get(str(last_team.get(pid)), None),
            "last_year": ly, "first_year": None if pd.isna(first_year.get(pid)) else int(first_year.get(pid)),
            "active": bool(ly is not None and ly >= max_year - 1),
            "thin": int(matches_raw.get(pid, 0)) < THIN_MATCHES,
        })
        cols = spaces[c]["metrics"] if c in spaces else CELL_METRICS[c]
        tot = raw.loc[pid] if pid in raw.index else None
        detail[pid] = {
            "name": name, "cell": c, "team": teams.get(str(last_team.get(pid)), None),
            "position": _nn(r.get("position")) if hasattr(r, "get") else None,
            "subrole": _nn(r.get("subrole")) if hasattr(r, "get") else None,
            "career": ({k: int(tot[k]) for k in
                        ["matches", "raids", "raid_pts", "tackles", "tackle_pts",
                         "total_pts", "super_raids", "super_tackles", "super_ten",
                         "high_five", "dod_raids", "dod_succ"] if k in tot.index}
                       if tot is not None else {}),
            "actual": {k: (None if pd.isna(m_raw.at[pid, k]) else round(float(m_raw.at[pid, k]), 2))
                       for k in cols},
            "percentile": {k: pctd.get(pid, {}).get(k) for k in cols},
            "seasons": hist.get(pid, []),
        }

    meta = {
        "built_at": datetime.now(timezone.utc).isoformat(),
        "sport": "kabaddi", "competition": "Pro Kabaddi League",
        "pool": len(index), "players": len(detail),
        "matches": int(facts["match_id"].nunique()),
        "seasons": sorted(set(facts["season_id"])),
        "cells": list(CELL_METRICS),
        "spaces": spaces, "validation": validation,
        "labels": LABELS, "lower_is_better": sorted(LOWER_IS_BETTER),
        "thresholds": {"min_matches": MIN_MATCHES, "thin_matches": THIN_MATCHES,
                       "shrink_k": SHRINK_K, "half_life_years": HALF_LIFE},
        "source": "Sportz Interactive / Pro Kabaddi League feeds",
    }
    for name, obj in (("index", index), ("detail", detail), ("meta", meta)):
        p = os.path.join(OUT, f"{name}.json")
        json.dump(obj, open(p, "w"), separators=(",", ":"), allow_nan=False)
        print(f"  {name+'.json':12} {os.path.getsize(p)/1e6:6.2f} MB")
    write_match_logs(facts, teams, OUT)

    print(f"\npool {len(index)} players, {int(facts['match_id'].nunique())} matches")
    for v in sorted(validation, key=lambda x: x["median_rank"] / x["chance_median_rank"]):
        print(f"  {v['cell']:16} n={v['players']:4}  {v['median_rank']:5.1f} of "
              f"{v['chance_median_rank']:5.1f}   first {v['ranked_first']:.0%}  "
              f"top5 {v['top_five']:.0%}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="all")
    args = ap.parse_args()
    cfg = yaml.safe_load(open(os.path.join(CFG, "seasons.yml")))
    ids = ([str(s["id"]) for s in cfg["seasons"]] if args.seasons == "all"
           else args.seasons.replace(",", " ").split())
    build(ids)


if __name__ == "__main__":
    main()
