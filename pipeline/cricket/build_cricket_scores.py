"""The cricket model.

Same method as the football side, with four things that are genuinely different
and were each settled by a test rather than by analogy.

  Format is the partition, not a filter. A player's T20 profile and his Test
  profile are separate rows in separate spaces and are never compared. Phase one
  ships men's T20 only; the others slot in as additional partitions.

  Role cells are fitted separately. Testing on 168 IPL batters showed a PCA
  fitted inside a role cell beats one fitted across all batters on every cell and
  every measure — openers 4.0 against 4.5 on median self-rank, middle order 9.0
  against 13.0 — and it holds out of sample with a training set of 23 players.
  So the floor for fitting a cell is low, and merging upward is a fallback for
  cells that cannot be fitted at all, not a default.

  Small samples are shrunk. A T20 innings is twenty balls; football's smallest
  unit was a season. Without shrinkage the top of every similarity list is a
  player with three good innings.

  Competition coefficients are fitted per metric, from players seen in more than
  one. Testing showed this does nothing between competitions of similar standard
  and cuts prediction error by a quarter to two-fifths across the widest gaps,
  which is exactly the case scouting cares about. It is not directionally
  biased: projecting a player up into a harder competition works as well as down.

Ships index.json, detail.json and meta.json, in the same shape the football site
already reads, so the frontend contract barely changes.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA

FACTS = os.path.join("data", "cricket", "facts")
DATA = os.path.join("data", "cricket")
OUT = os.path.join("site", "data", "cricket")

FORMAT = "T20"
GENDER = "male"
MIN_BALLS_BAT = 300          # to enter the batting pool
MIN_BALLS_BOWL = 300
MIN_HALF = 150               # per half, to be testable
MIN_CELL_SCORE = 12          # players needed to fit a cell at all
MIN_CELL_VALIDATE = 25
SHRINK_K = 250               # balls at which a profile is half its own
HALF_LIFE = 3.0              # years after which a ball counts half
VARIANCE = 0.95
MIN_COMPONENTS, MAX_COMPONENTS = 4, 10

BAT_METRICS = ["sr", "bpd", "bdry", "six_share", "dot_pct", "sr_pp", "sr_mid",
               "sr_death", "sh_pp", "sh_death", "sr_pace", "sr_spin", "spin_bias",
               "sr_first10", "accel", "bdry_spin"]
BOWL_METRICS = ["econ", "wkt_rate", "dot_rate", "bdry_conc", "six_share_conc",
                "econ_pp", "econ_mid", "econ_death", "sh_pp", "sh_death", "wide_rate"]

BAT_ROLES = {"opener", "top middle", "middle", "finisher"}

# The rungs a career climbs, weakest first. Exposure is the highest one a player
# has actually had a meaningful go at — which is the filter the whole tool exists
# for: find me someone who has never played an international or a top franchise
# league, and whose shape says he could.
EXPOSURE_LADDER = ["domestic", "franchise", "international_minor",
                   "international_established", "international_full"]
EXPOSURE_MIN_BALLS = 60          # a handful of balls at a level is not exposure


def exposure_of(per_tier: dict) -> str:
    reached = [t for t in EXPOSURE_LADDER if per_tier.get(t, 0) >= EXPOSURE_MIN_BALLS]
    return reached[-1] if reached else "domestic"


def load(kind: str, root: str = None) -> pd.DataFrame:
    fs = sorted(glob.glob(os.path.join(root or FACTS, f"*_{kind}.parquet")))
    if not fs:
        raise SystemExit(f"no {kind} files in {root or FACTS}")
    return pd.concat((pd.read_parquet(f) for f in fs), ignore_index=True)


COUNTS = ["balls", "runs", "dots", "fours", "sixes", "outs", "wkts", "wides", "noballs"]


def weight_by_recency(facts: pd.DataFrame, half_life: float) -> pd.DataFrame:
    """Discount old cricket.

    A career profile answers "what was this player", which is the wrong question
    for a signing: the bet runs two or three years forward and T20 decline is
    steep. So every count is weighted by the age of the match it came from, on a
    half-life. Raw balls are kept alongside, because pool entry and the sample
    provenance shown to the user should reflect what a player actually faced,
    not what the weighting left of it.

    half_life of 0 turns this off and gives the raw career shape.
    """
    f = facts.copy()
    f["balls_raw"] = f["balls"]
    if not half_life:
        f["w"] = 1.0
        return f
    d = pd.to_datetime(f["date"], errors="coerce")
    # Age is measured against each player's OWN last appearance, not the end of
    # the archive. Weighting against the archive would erase anyone retired:
    # de Villiers went from 4,781 balls to 470 effective, so his profile became
    # mostly the pool mean — and "who plays like de Villiers" is exactly the
    # question exploring mode exists to answer. Whether a player is still
    # available is a separate question, answered by the active filter.
    last = d.groupby(f["player_id"]).transform("max")
    age = (last - d).dt.days / 365.25
    f["w"] = np.power(0.5, age.fillna(0).clip(lower=0) / half_life)
    for c in COUNTS:
        if c in f:
            f[c] = f[c] * f["w"]
    return f


def _safe(num, den, scale=1.0):
    den = np.asarray(den, dtype=float)
    return np.where(den > 0, np.asarray(num, dtype=float) / np.where(den > 0, den, 1) * scale, np.nan)


def batting_profile(facts: pd.DataFrame, by) -> pd.DataFrame:
    """Sixteen rates per batter, from counts the parser already folded."""
    ph = facts[facts["kind"] == "bat_phase"]
    vs = facts[facts["kind"] == "bat_vs_bowler_typed"]
    pr = facts[facts["kind"] == "bat_progress"]

    tot = ph.groupby(by)[["balls", "runs", "dots", "fours", "sixes", "outs"]].sum()
    out = pd.DataFrame(index=tot.index)
    out["balls"] = tot["balls"]
    out["balls_raw"] = ph.groupby(by)["balls_raw"].sum() if "balls_raw" in ph else tot["balls"]
    out["runs"] = tot["runs"]
    out["outs"] = tot["outs"]
    out["sr"] = _safe(tot["runs"], tot["balls"], 100)
    out["bpd"] = _safe(tot["balls"], tot["outs"].clip(lower=1))
    out["bdry"] = _safe(tot["fours"] + tot["sixes"], tot["balls"], 100)
    out["six_share"] = _safe(tot["sixes"], (tot["fours"] + tot["sixes"]), 100)
    out["dot_pct"] = _safe(tot["dots"], tot["balls"], 100)

    for name, bucket in (("pp", "powerplay"), ("mid", "middle"), ("death", "death")):
        g = ph[ph["bucket"] == bucket].groupby(by)[["balls", "runs"]].sum().reindex(tot.index)
        out[f"sr_{name}"] = _safe(g["runs"], g["balls"], 100)
        out[f"sh_{name}"] = _safe(g["balls"], tot["balls"], 100)

    for t, suffix in (("pace", "pace"), ("spin", "spin")):
        g = vs[vs["bucket"] == t].groupby(by)[["balls", "runs", "fours", "sixes"]].sum().reindex(tot.index)
        out[f"sr_{suffix}"] = _safe(g["runs"], g["balls"], 100)
        if t == "spin":
            out["bdry_spin"] = _safe(g["fours"] + g["sixes"], g["balls"], 100)
    out["spin_bias"] = out["sr_spin"] - out["sr_pace"]

    f10 = pr[pr["bucket"] == "first10"].groupby(by)[["balls", "runs"]].sum().reindex(tot.index)
    later = pr[pr["bucket"] != "first10"].groupby(by)[["balls", "runs"]].sum().reindex(tot.index)
    out["sr_first10"] = _safe(f10["runs"], f10["balls"], 100)
    out["accel"] = _safe(later["runs"], later["balls"], 100) - out["sr_first10"]
    return out


def bowling_profile(facts: pd.DataFrame, by) -> pd.DataFrame:
    bp = facts[facts["kind"] == "bowl_phase"]
    tot = bp.groupby(by)[["balls", "runs", "dots", "fours", "sixes", "wkts", "wides"]].sum()
    out = pd.DataFrame(index=tot.index)
    out["balls"] = tot["balls"]
    out["balls_raw"] = bp.groupby(by)["balls_raw"].sum() if "balls_raw" in bp else tot["balls"]
    out["econ"] = _safe(tot["runs"], tot["balls"], 6)
    out["wkt_rate"] = _safe(tot["wkts"], tot["balls"], 100)
    out["dot_rate"] = _safe(tot["dots"], tot["balls"], 100)
    out["bdry_conc"] = _safe(tot["fours"] + tot["sixes"], tot["balls"], 100)
    out["six_share_conc"] = _safe(tot["sixes"], (tot["fours"] + tot["sixes"]), 100)
    out["wide_rate"] = _safe(tot["wides"], tot["balls"], 100)
    for name, bucket in (("pp", "powerplay"), ("mid", "middle"), ("death", "death")):
        g = bp[bp["bucket"] == bucket].groupby(by)[["balls", "runs"]].sum().reindex(tot.index)
        out[f"econ_{name}"] = _safe(g["runs"], g["balls"], 6)
        out[f"sh_{name}"] = _safe(g["balls"], tot["balls"], 100)
    return out


def fit_competition_effects(per_comp: pd.DataFrame, metrics, min_balls=150):
    """log(rate) = player effect + competition effect, weighted by balls.

    Fitted only from players seen in more than one competition. Comparing whole
    competitions instead would show which has the better players, not which is
    the harder place to play.

    Must be given RAW, unweighted records. How hard a competition is to play in
    is a property of that competition, not of a player's current form, so
    recency weighting has no business here: it discounts a player's older
    competitions below the threshold, drops them from the mover pool, and biases
    every coefficient toward whichever seasons happen to be recent.
    """
    t = per_comp[per_comp["balls"] >= min_balls].copy()
    t = t[t.groupby("player_id")["comp_key"].transform("nunique") >= 2]
    if t.empty:
        return {}, 0
    keys = sorted(t["comp_key"].unique())
    players = sorted(t["player_id"].unique())
    ki = {k: i for i, k in enumerate(keys)}
    pi = {p: i for i, p in enumerate(players)}
    eff = {}
    for m in metrics:
        s = t[np.isfinite(t[m]) & (t[m] > 0)]
        if len(s) < 40:
            continue
        X = np.zeros((len(s), len(players) + len(keys)))
        X[np.arange(len(s)), [pi[p] for p in s["player_id"]]] = 1
        X[np.arange(len(s)), len(players) + np.array([ki[k] for k in s["comp_key"]])] = 1
        w = np.sqrt(s["balls"].to_numpy())
        beta, *_ = np.linalg.lstsq(X * w[:, None], np.log(s[m].to_numpy()) * w, rcond=None)
        e = beta[len(players):]
        eff[m] = dict(zip(keys, np.exp(e - e.mean())))
    return eff, len(players)


def apply_adjustment(per_comp: pd.DataFrame, eff, metrics) -> pd.DataFrame:
    """Combine a player's competitions into one profile, on a common standard."""
    rows = {}
    for pid, grp in per_comp.groupby("player_id"):
        w = grp["balls"].to_numpy(float)
        rec = {"balls": w.sum(),
               "balls_raw": float(grp["balls_raw"].sum()) if "balls_raw" in grp else float(w.sum())}
        for m in metrics:
            v = grp[m].to_numpy(float)
            ok = np.isfinite(v) & (v > 0) & (w > 0)
            if not ok.any():
                rec[m] = np.nan
                continue
            if m in eff:
                c = np.array([eff[m].get(k, 1.0) for k in grp["comp_key"]])
                v = v / c
            rec[m] = float(np.exp(np.average(np.log(v[ok]), weights=w[ok])))
        rows[pid] = rec
    return pd.DataFrame.from_dict(rows, orient="index")


def shrink(prof: pd.DataFrame, metrics, k=SHRINK_K) -> pd.DataFrame:
    """Pull thin records toward the pool mean. A 60-ball profile is noise."""
    X = prof[metrics].to_numpy(float)
    mu = np.nanmean(X, axis=0)
    X = np.where(np.isfinite(X), X, mu)
    w = (prof["balls"].to_numpy(float) / (prof["balls"].to_numpy(float) + k))[:, None]
    return pd.DataFrame(w * X + (1 - w) * mu, index=prof.index, columns=metrics)


def fit_space(z: np.ndarray):
    n = min(z.shape[1], max(2, len(z) - 1), MAX_COMPONENTS)
    var = PCA(n_components=n, random_state=0).fit(z).explained_variance_ratio_
    k = max(MIN_COMPONENTS, min(int(np.searchsorted(np.cumsum(var), VARIANCE) + 1), n))
    p = PCA(n_components=k, random_state=0).fit(z)
    return p, k, float(np.cumsum(p.explained_variance_ratio_)[-1])


def self_rank(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    d = np.sqrt(((a[:, None, :] - b[None, :, :]) ** 2).sum(-1))
    return np.array([int(np.where(d[i].argsort() == i)[0][0]) + 1 for i in range(len(a))])


def typed_matchups(facts: pd.DataFrame, types: dict) -> pd.DataFrame:
    """Relabel batter-against-bowler rows by the bowler's derived type.

    The parser deliberately keeps the bowler's identity rather than their type,
    because the type is itself derived from this data and would otherwise be
    frozen at parse time.
    """
    vb = facts[facts["kind"] == "bat_vs_bowler"].copy()
    vb["bucket"] = vb["bucket"].map(types)
    vb = vb[vb["bucket"].notna()]
    vb["kind"] = "bat_vs_bowler_typed"
    return vb


def build_discipline(facts, roles, players, discipline, metrics, min_balls, cells,
                     facts_raw=None):
    by = ["player_id", "comp_key"]
    profile = batting_profile if discipline == "batting" else bowling_profile

    # Coefficients come from the unweighted record; the profile they are applied
    # to is the weighted one.
    per_comp_raw = profile(facts_raw if facts_raw is not None else facts, by).reset_index()
    eff, movers = fit_competition_effects(per_comp_raw, metrics)

    per_comp = profile(facts, by).reset_index()
    prof = apply_adjustment(per_comp, eff, metrics)
    # Pool entry is judged on real balls faced, not on what the weighting left.
    prof = prof[prof["balls_raw"] >= min_balls]
    if prof.empty:
        return None

    prof = prof.join(cells.rename("cell"), how="inner")
    prof = prof[prof["cell"].notna()]
    z_all = shrink(prof, metrics)

    # Halves, for the validation that decides whether any of this works.
    # Validation asks whether there is enough of a record to recognise a player,
    # which is a question about sample size, so it uses raw balls too.
    halves = {}
    src = facts_raw if facts_raw is not None else facts
    for h in (0, 1):
        p = profile(src[src["half"] == h], ["player_id"])
        halves[h] = p[p["balls_raw"] >= MIN_HALF]

    spaces, validation = {}, []
    coords = {}
    for cell, members in prof.groupby("cell"):
        if len(members) < MIN_CELL_SCORE:
            continue
        sub = z_all.loc[members.index]
        mu, sd = sub.mean(), sub.std().replace(0, 1)
        z = ((sub - mu) / sd).to_numpy()
        pca, k, var = fit_space(z)
        c = pca.transform(z)
        for pid, row in zip(members.index, c):
            coords[pid] = [round(float(x), 4) for x in row]
        d = np.sqrt(((c[:, None, :] - c[None, :, :]) ** 2).sum(-1))
        med = float(np.median(d[np.triu_indices(len(c), 1)])) if len(c) > 1 else 1.0

        shared = sorted(set(members.index) & set(halves[0].index) & set(halves[1].index))
        v = None
        if len(shared) >= MIN_CELL_VALIDATE:
            A = shrink(halves[0].loc[shared], metrics)
            B = shrink(halves[1].loc[shared], metrics)
            m2, s2 = A.mean(), A.std().replace(0, 1)
            za, zb = ((A - m2) / s2).to_numpy(), ((B - m2) / s2).to_numpy()
            p2, _, _ = fit_space(za)
            r = self_rank(p2.transform(za), p2.transform(zb))
            v = {"cell": cell, "discipline": discipline, "players": len(shared),
                 "median_rank": float(np.median(r)), "chance_median_rank": (len(shared) + 1) / 2,
                 "ranked_first": round(float((r == 1).mean()), 3),
                 "top_five": round(float((r <= 5).mean()), 3)}
            validation.append(v)

        spaces[cell] = {
            "players": int(len(members)), "components": k, "variance": round(var, 4),
            "median_distance": round(med, 4),
            "metrics": metrics,
            "mean": {m: round(float(mu[m]), 4) for m in metrics},
            "sd": {m: round(float(sd[m]), 4) for m in metrics},
            "loadings": [[round(float(x), 4) for x in comp] for comp in pca.components_],
        }
    return {"spaces": spaces, "coords": coords, "validation": validation,
            "effects": {m: {k: round(float(v), 4) for k, v in e.items()} for m, e in eff.items()},
            "movers": movers, "profile": prof, "z": z_all}


def _comp_cfg():
    import yaml
    with open(os.path.join("config", "cricket", "competitions.yml")) as fh:
        return yaml.safe_load(fh)["competitions"]


def percentiles(z: pd.DataFrame, cells: pd.Series, metrics) -> pd.DataFrame:
    """Rank each player against their own cell, not the whole pool.

    An opener's dot percentage means nothing measured against finishers.
    """
    out = pd.DataFrame(index=z.index, columns=metrics, dtype=float)
    for _, idx in cells.groupby(cells):
        sub = z.loc[z.index.intersection(idx.index)]
        if len(sub) < 5:
            continue
        out.loc[sub.index, metrics] = sub[metrics].rank(pct=True).to_numpy() * 100
    return out


MIN_SEASON_BALLS = 60          # ten overs; below that a season rate is noise


def season_history(facts, profile_fn, metrics, keep=("sr", "bdry", "dot_pct", "econ",
                                                     "wkt_rate", "dot_rate")):
    """What happened, season by season — from the RAW record.

    This must not be given the recency-weighted facts. The chart already puts
    time on the x-axis, so discounting old seasons as well counts time twice:
    Bumrah's 2015/16 held 565 balls and disappeared entirely, and his 2019 read
    71 balls when he had bowled 526.
    """
    h = profile_fn(facts, ["player_id", "season"])
    cols = [c for c in keep if c in h.columns]
    h = h[h["balls_raw"] >= MIN_SEASON_BALLS].copy()
    h["balls"] = h["balls_raw"]
    h = h[cols + ["balls"]].round(2)
    out = {}
    for (pid, season), row in h.iterrows():
        out.setdefault(pid, []).append({"season": season, "balls": int(row["balls"]),
                                        **{c: (None if pd.isna(row[c]) else float(row[c]))
                                           for c in cols}})
    return out


def emit(bat, bowl, players, roles, facts, out_dir, half_life=HALF_LIFE, facts_raw=None):
    """index.json, detail.json, meta.json — the shape the site already reads."""
    os.makedirs(out_dir, exist_ok=True)
    last_overall = pd.to_datetime(facts["date"], errors="coerce").max()

    apps = load("appearances")
    apps = apps[(apps["format"] == FORMAT) & (apps["gender"] == GENDER)].copy()
    apps["date"] = pd.to_datetime(apps["date"], errors="coerce")
    seen = apps.groupby("player_id")["date"].max()
    first = apps.groupby("player_id")["date"].min()
    matches = apps.groupby("player_id")["match_id"].nunique()
    teams = (apps.sort_values("date").groupby(["player_id", "competition_name"])["team"]
             .last().reset_index().groupby("player_id")
             .apply(lambda d: [{"competition": c, "team": t}
                               for c, t in zip(d["competition_name"], d["team"])],
                    include_groups=False).to_dict())

    bio_path = os.path.join(DATA, "bio.parquet")
    bio = (pd.read_parquet(bio_path).set_index("player_id")
           if os.path.exists(bio_path) else pd.DataFrame())
    as_of = pd.to_datetime(facts["date"], errors="coerce").max()

    # Balls by tier and by competition, so exposure can be judged on substance
    # and "has played in the IPL" becomes a filter rather than a guess.
    tier_balls, comp_balls = {}, {}
    for kind, disc in (("bat_phase", "batting"), ("bowl_phase", "bowling")):
        sub = facts[facts["kind"] == kind]
        for (pid, tier), b in sub.groupby(["player_id", "tier"])["balls_raw"].sum().items():
            tier_balls.setdefault((pid, disc), {})[tier] = int(b)
        for (pid, comp), b in sub.groupby(["player_id", "competition"])["balls_raw"].sum().items():
            comp_balls.setdefault((pid, disc), {})[comp] = int(b)

    # The country a player represents, taken from who they turn out for in
    # internationals. This is cricketing eligibility, which is the question a
    # franchise actually asks — and it covers far more players than Wikidata's
    # citizenship, which is patchy and reports English players as British.
    # Invitational sides are not nationalities. Rashid Khan's only international
    # appearances in this archive are for an ICC World XI, because Afghanistan's
    # matches are withheld — so reading his team gave "ICC World XI".
    INVITATIONAL = {"ICC World XI", "World XI", "Asia XI", "Africa XI",
                    "Rest of World", "MCC"}
    intl = apps[apps["tier"].str.startswith("international")
                & ~apps["team"].isin(INVITATIONAL)].sort_values("date")
    represents = intl.groupby("player_id")["team"].last().to_dict()

    # A player who has never played an international has no team to read it off,
    # and Wikidata citizenship is the wrong answer: it reports every English
    # county player as British. But the competition says it — someone who only
    # turns out in the T20 Blast is English. Fall back to that.
    HOME = {"ntb": "England", "cch": "England", "rlc": "England", "bwt": "England",
            "hnd": "England", "wtb": "England", "cec": "England", "rhf": "England",
            "wod": "England", "wsl": "England",
            "sma": "India", "ipl": "India", "wpl": "India", "wtc": "India",
            "bbl": "Australia", "ssh": "Australia", "odc": "Australia", "wbb": "Australia",
            "psl": "Pakistan", "bpl": "Bangladesh", "lpl": "Sri Lanka",
            "sat": "South Africa", "ctc": "South Africa", "msl": "South Africa",
            "cpl": "West Indies", "wcl": "West Indies", "sft": "West Indies", "blz": "West Indies",
            "ssm": "New Zealand", "pks": "New Zealand",
            "ipt": "Ireland", "ipo": "Ireland", "npl": "Nepal", "mlc": "United States of America"}
    home = (apps[apps["competition"].isin(HOME)]
            .assign(country=lambda d: d["competition"].map(HOME))
            .groupby("player_id")["country"]
            .agg(lambda s: s.value_counts().idxmax()).to_dict())

    keepers = set(roles[roles.get("keeper", False) == True].index) if "keeper" in roles else set()

    # Citizenship beats a guess from the competition, but "United Kingdom" is
    # not a cricket nation — 276 players carry it — so that one falls through.
    VAGUE = {"United Kingdom", "Great Britain"}

    def nationality_of(pid):
        team = represents.get(pid)
        if team:
            return team
        wd = bio.at[pid, "nationality"] if pid in bio.index else None
        if pd.notna(wd) and wd not in VAGUE:
            return wd
        return home.get(pid) or (wd if pd.notna(wd) else None)

    # Afghanistan's matches are withheld from the archive, so anyone who plays
    # for them has no international record here at all. That is not a gap the
    # reader can infer, so it is flagged per player.
    AFFECTED = {"Afghanistan"}

    # Career totals, split by the standard played at. A scout wants to know what
    # a player has actually done, not only how his rates compare — and wants it
    # separated, because runs against associate nations are not runs in the IPL.
    def bucket(tier):
        if tier.startswith("international"):
            return "international"
        return "franchise" if tier == "franchise" else "domestic"

    career = {}
    for kind, disc in (("bat_phase", "batting"), ("bowl_phase", "bowling")):
        sub = facts[facts["kind"] == kind]
        if sub.empty:
            continue
        cols = [c for c in ["balls_raw", "runs", "outs", "wkts", "fours", "sixes", "dots"]
                if c in sub]
        g = sub.assign(grp=sub["tier"].map(bucket)).groupby(["player_id", "grp"])[cols].sum()
        for (pid, grp), row in g.iterrows():
            rec = career.setdefault(pid, {}).setdefault(disc, {})
            rec[grp] = {c: int(row[c]) for c in cols}

    matches_by = (apps.assign(grp=apps["tier"].map(bucket))
                  .groupby(["player_id", "grp"])["match_id"].nunique())
    cricinfo = (bio["cricinfo"].dropna().astype("int64").to_dict()
                if not bio.empty and "cricinfo" in bio else {})

    index, detail = [], {}
    for disc, res, prof_fn, metrics in (("batting", bat, batting_profile, BAT_METRICS),
                                        ("bowling", bowl, bowling_profile, BOWL_METRICS)):
        prof = res["profile"]
        pct = percentiles(res["z"], prof["cell"], metrics)
        hist = season_history(facts_raw if facts_raw is not None else facts, prof_fn, metrics)
        for pid, row in prof.iterrows():
            if pid not in res["coords"]:
                continue
            last = seen.get(pid)
            index.append({
                "uid": f"{pid}:{disc}",
                "player_id": pid,
                "name": players.at[pid, "name"] if pid in players.index else pid,
                # The match files only ever carry a short name, so the full name
                # and everything else biographical comes from the register plus
                # Wikidata, joined on an exact Cricinfo id.
                "full_name": (bio.at[pid, "full_name"]
                              if pid in bio.index and pd.notna(bio.at[pid, "full_name"]) else None),
                "nationality": nationality_of(pid),
                "keeper": pid in keepers,
                "partial_record": nationality_of(pid) in AFFECTED,
                "age": (round(float((as_of - bio.at[pid, "dob"]).days / 365.25), 1)
                        if pid in bio.index and pd.notna(bio.at[pid, "dob"]) else None),
                "discipline": disc,
                "cell": row["cell"],
                "role": roles.at[pid, "role"] if pid in roles.index else None,
                "balls": int(row["balls_raw"]),
                "effective_balls": int(row["balls"]),
                "matches": int(matches.get(pid, 0)),
                "coords": res["coords"][pid],
                "last_seen": None if pd.isna(last) else last.date().isoformat(),
                "first_seen": (None if pid not in first.index or pd.isna(first[pid])
                               else first[pid].date().isoformat()),
                "active": bool(pd.notna(last) and (last_overall - last).days <= 550),
                "exposure": exposure_of(tier_balls.get((pid, disc), {})),
                "tier_balls": tier_balls.get((pid, disc), {}),
                "competition_balls": comp_balls.get((pid, disc), {}),
            })
            d = detail.setdefault(pid, {"name": index[-1]["name"],
                                        "teams": teams.get(pid, []),
                                        "role": index[-1]["role"],
                                        "cricinfo": cricinfo.get(pid)})
            car = (career.get(pid, {}) or {}).get(disc, {})
            if car:
                total = {}
                for grp, rec in car.items():
                    for k, v in rec.items():
                        total[k] = total.get(k, 0) + v
                d.setdefault("career", {})[disc] = {
                    "total": total,
                    **{g: rec for g, rec in car.items()},
                    "matches": {g: int(matches_by.get((pid, g), 0))
                                for g in list(car) + ["total"]
                                if g != "total"},
                }
            d[disc] = {
                "balls": int(row["balls_raw"]),
                "effective_balls": int(row["balls"]),
                "adjusted": {m: (None if pd.isna(row[m]) else round(float(row[m]), 2))
                             for m in metrics},
                "percentile": {m: (None if pd.isna(pct.at[pid, m]) else round(float(pct.at[pid, m]), 1))
                               for m in metrics},
                "seasons": hist.get(pid, []),
            }

    meta = {
        "built_at": datetime.now(timezone.utc).isoformat(),
        "sport": "cricket", "format": FORMAT, "gender": GENDER,
        "pool": len(index), "players": len(detail),
        "matches": int(facts["match_id"].nunique()),
        "competitions": sorted(facts["comp_key"].unique().tolist()),
        "competition_names": {c["key"]: c["name"] for c in _comp_cfg()},
        "competition_notes": {c["key"]: c["note"] for c in _comp_cfg() if c.get("note")},
        "spaces": {"batting": bat["spaces"], "bowling": bowl["spaces"]},
        "competition_effects": {"batting": bat["effects"], "bowling": bowl["effects"]},
        "movers": {"batting": bat["movers"], "bowling": bowl["movers"]},
        "validation": bat["validation"] + bowl["validation"],
        "exposure_ladder": EXPOSURE_LADDER,
        "bio_coverage": {"age": None, "nationality": None},
        "thresholds": {"min_season_balls": MIN_SEASON_BALLS, "min_balls_batting": MIN_BALLS_BAT, "min_balls_bowling": MIN_BALLS_BOWL,
                       "shrinkage_k": SHRINK_K, "variance": VARIANCE,
                       "recency_half_life_years": half_life},
        "source": "Cricsheet (https://cricsheet.org), Open Data Commons Attribution Licence",
        # Not a gap in the data — a decision by the person who maintains it.
        # Stated plainly, with a link to his own reasoning, so a reader sees
        # whose position it is rather than ours.
        "withheld": {
            "summary": ("Cricsheet withholds all matches involving or played in "
                        "Afghanistan, so Afghan players and opponents' records "
                        "against them are incomplete."),
            "matches": 374,
            "reason": ("The maintainer withholds them in protest at Afghan women "
                       "cricketers being ignored by the ICC and most full members."),
            "link": ("https://cricsheet.org/article/"
                     "explanation-for-withholding-of-afghanistani-matches/"),
        },
        "limits": ("No ball tracking, shot type or fielding positions exist in the open "
                   "data, so players are compared on outcomes rather than technique."),
    }
    for name, obj in (("index", index), ("detail", detail), ("meta", meta)):
        path = os.path.join(out_dir, f"{name}.json")
        with open(path, "w") as fh:
            json.dump(obj, fh, separators=(",", ":"))
        print(f"  {name+'.json':12} {os.path.getsize(path)/1e6:6.2f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--facts", default=FACTS)
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--half-life", type=float, default=HALF_LIFE,
                    help="years after which a ball counts half; 0 for raw career shape")
    args = ap.parse_args()
    facts = load("facts", args.facts)
    facts = facts[(facts["format"] == FORMAT) & (facts["gender"] == GENDER)].copy()
    facts["comp_key"] = np.where(facts["tier"].str.startswith("international"),
                                 facts["tier"], facts["competition"])
    # Alternating matches, the analogue of football's alternating seasons.
    order = {m: i for i, m in enumerate(sorted(facts["match_id"].unique()))}
    facts["half"] = facts["match_id"].map(order) % 2

    players = pd.read_parquet(os.path.join(args.data, "players.parquet")).set_index("player_id")
    roles = pd.read_parquet(os.path.join(args.data, "roles.parquet"))
    roles = roles[roles["format"] == FORMAT].set_index("player_id")
    types = players["bowler_type"].dropna().to_dict()

    facts = pd.concat([facts, typed_matchups(facts, types)], ignore_index=True)
    facts_raw = weight_by_recency(facts, 0)          # unweighted, for coefficients
    facts = weight_by_recency(facts, args.half_life)
    print(f"recency half-life: {args.half_life or 'off'} years "
          f"(measured from each player's own last match)")

    bat_cell = roles["bat_pos"].apply(
        lambda p: "opener" if 0 < p <= 2.5 else "top middle" if p <= 4.5
        else "middle" if p <= 6.5 else "finisher" if p <= 8.5 else None)
    bowl_cell = roles.index.map(lambda i: types.get(i)).map(
        {"pace": "pace", "spin": "spin"})
    bowl_cell = pd.Series(bowl_cell, index=roles.index)

    print(f"pool: {facts['player_id'].nunique():,} players, "
          f"{facts['match_id'].nunique():,} men's T20 matches, "
          f"{facts['comp_key'].nunique()} competitions")

    bat = build_discipline(facts, roles, players, "batting", BAT_METRICS,
                           MIN_BALLS_BAT, bat_cell, facts_raw)
    bowl = build_discipline(facts, roles, players, "bowling", BOWL_METRICS,
                            MIN_BALLS_BOWL, bowl_cell, facts_raw)

    print(f"\ncompetition coefficients fitted from "
          f"{bat['movers']} batters / {bowl['movers']} bowlers seen in 2+ competitions")
    for disc, res in (("batting", bat), ("bowling", bowl)):
        print(f"\n{disc}: {sum(s['players'] for s in res['spaces'].values()):,} scored")
        for cell, s in res["spaces"].items():
            print(f"  {cell:12} {s['players']:5,} players  {s['components']} axes  "
                  f"{s['variance']:.0%} variance")
        print("  validation (median self-rank against chance):")
        for v in sorted(res["validation"], key=lambda x: x["median_rank"] / x["chance_median_rank"]):
            print(f"    {v['cell']:12} n={v['players']:4}  {v['median_rank']:6.1f} "
                  f"of {v['chance_median_rank']:6.1f}   first {v['ranked_first']:.1%}  "
                  f"top5 {v['top_five']:.1%}")
    print()
    emit(bat, bowl, players, roles, facts, args.out, args.half_life, facts_raw)
    return bat, bowl


if __name__ == "__main__":
    main()
