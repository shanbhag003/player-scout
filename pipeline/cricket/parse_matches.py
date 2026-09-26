"""Turn Cricsheet match files into per-match player facts.

Deliveries are never kept. Eighteen million of them is two gigabytes, which
cannot live in a git repository and does not need to: everything the model asks
for can be answered from counts held one level up, at player-per-match. That
table is around four million rows, survives in a release asset, and means a new
metric in phase two costs a rebuild of the master rather than a re-parse of the
archive.

Three fact kinds are written, because the model needs cuts that do not nest:

  bat_phase       batter x match x innings x phase
  bat_vs_bowler   batter x match x innings x bowler
  bowl_phase      bowler x match x innings x phase

The second exists so a batter's record against pace and against spin can be
assembled later by joining bowler identities to their type. Splitting on type
here instead would bake in a classification that is itself derived from this
data — and would have to be thrown away the first time it improved.

Identity comes from the registry block every match carries, which maps the names
used in the file to stable Cricsheet person ids. Football needed six matching
passes to bridge two sources with no shared key; here the key is given.
"""
from __future__ import annotations

import argparse
import json
import os
import zipfile
from collections import defaultdict

import pandas as pd
import yaml

from resolve_competition import Resolver

CONFIG = os.path.join("config", "cricket", "competitions.yml")

# A bowler is credited with these and not the others. A run out is not a wicket
# taken, and the retirements are not dismissals at all.
BOWLER_WICKETS = {"caught", "bowled", "lbw", "stumped", "caught and bowled", "hit wicket"}
# These end a batter's innings without it counting against their average.
NOT_OUT_KINDS = {"retired hurt", "retired not out"}


def load_config(path: str = CONFIG) -> dict:
    with open(path) as fh:
        return yaml.safe_load(fh)


def tier_of(teams, cfg, comp) -> str:
    """The standard of a fixture, which is not the same as its competition."""
    if not comp.get("tier_by_teams"):
        return comp.get("tier", "unknown")
    full = set(cfg["tiers"]["full_member"])
    estab = full | set(cfg["tiers"]["established"])
    t = set(teams)
    if t <= full:
        return "international_full"
    if t <= estab:
        return "international_established"
    return "international_minor"


def phase_bands(fmt_cfg, innings):
    """Phase boundaries for one innings, in overs.

    The innings' own powerplay block is preferred where the format has one,
    because ODI powerplay regulations changed several times and a fixed band
    would mislabel a decade of cricket.
    """
    bands = [(int(a), int(b), str(c)) for a, b, c in fmt_cfg["phases"]]
    if not fmt_cfg.get("use_powerplays"):
        return bands
    pps = innings.get("powerplays") or []
    mandatory = [p for p in pps if p.get("type") == "mandatory"]
    if not mandatory:
        return bands
    # `to` is given as over.ball; the powerplay ends within that over.
    end = int(float(mandatory[0]["to"]))
    rest = [b for b in bands if b[0] > end]
    if not rest:
        return bands
    return [(0, end, bands[0][2])] + [(end + 1, b[1], b[2]) for b in rest]


def phase_for(over: int, bands) -> str:
    for lo, hi, name in bands:
        if lo <= over <= hi:
            return name
    return bands[-1][2]


def parse_match(raw: dict, mid: str, comp: dict, cfg: dict):
    """One match in, (appearance rows, fact rows) out. Returns None if unusable."""
    info = raw.get("info") or {}
    fmt = comp["format"]
    fmt_cfg = cfg["formats"][fmt]

    if info.get("balls_per_over", 6) != fmt_cfg["balls_per_over"]:
        return None                       # not the format this competition claims
    gender = info.get("gender")
    if gender not in comp.get("genders", ["male", "female"]):
        return None

    teams = info.get("teams") or []
    season = str(info.get("season", (info.get("dates") or ["?"])[0][:4]))
    date = (info.get("dates") or [None])[0]
    registry = ((info.get("registry") or {}).get("people")) or {}
    tier = tier_of(teams, cfg, comp)

    def pid(name):
        # Fall back to the name only if the registry is silent, which it never
        # was across 2,400 sampled matches — but a silent wrong id would be worse
        # than a visible odd one.
        return registry.get(name) or f"name:{name}"

    facts = defaultdict(lambda: defaultdict(float))
    order = {}          # batting position, by first appearance at the crease
    bowled = set()
    fielding = defaultdict(lambda: defaultdict(float))
    # Per-match, per-player line for the match-log view: the whole innings, not
    # split by phase, plus how the batter got out. Everything here is already
    # seen in the loops below; it is only that nothing kept it at this grain.
    line = defaultdict(lambda: defaultdict(float))
    dismissal = {}      # (innings, batter) -> {"kind":..., "bowler":..., "fielder":...}

    for ino, inn in enumerate(raw.get("innings") or [], start=1):
        if inn.get("super_over"):
            continue                       # a tiebreak, not part of anyone's record
        bands = phase_bands(fmt_cfg, inn)
        bat_team = inn.get("team")
        seen = 0
        faced_so_far = defaultdict(int)     # balls this batter has faced, this innings
        for ov in inn.get("overs") or []:
            over_no = ov.get("over", 0)
            ph = phase_for(over_no, bands)
            for d in ov.get("deliveries") or []:
                batter, bowler = d["batter"], d["bowler"]
                for who in (batter, d.get("non_striker")):
                    if who and (ino, who) not in order:
                        seen += 1
                        order[(ino, who)] = seen
                bowled.add(bowler)

                ex = d.get("extras") or {}
                wide = 1 if ex.get("wides") else 0
                noball = 1 if ex.get("noballs") else 0
                byes = (ex.get("byes") or 0) + (ex.get("legbyes") or 0)
                runs_bat = d["runs"]["batter"]
                faced = 0 if wide else 1          # a wide is not faced; a no-ball is
                legal = 0 if (wide or noball) else 1
                dot = 1 if (faced and runs_bat == 0) else 0

                # How far into their own innings this ball fell. A batter who
                # needs ten balls to get going and one who starts at full tempo
                # can post identical rates and are not the same player.
                fs = faced_so_far[batter]
                stage = "first10" if fs < 10 else "next15" if fs < 25 else "settled"
                faced_so_far[batter] += faced

                bkey = ("bat_phase", ino, pid(batter), ph)
                vkey = ("bat_vs_bowler", ino, pid(batter), pid(bowler))
                gkey = ("bat_progress", ino, pid(batter), stage)
                for k in (bkey, vkey, gkey):
                    facts[k]["balls"] += faced
                    facts[k]["runs"] += runs_bat
                    facts[k]["dots"] += dot
                    facts[k]["fours"] += 1 if runs_bat == 4 else 0
                    facts[k]["sixes"] += 1 if runs_bat == 6 else 0

                lb = line[(ino, pid(batter))]
                lb["bat_balls"] += faced; lb["bat_runs"] += runs_bat
                lb["fours"] += 1 if runs_bat == 4 else 0
                lb["sixes"] += 1 if runs_bat == 6 else 0
                lb["_bat_team"] = bat_team

                lo = line[(ino, pid(bowler))]
                lo["bowl_balls"] += legal
                lo["conceded"] += d["runs"]["total"] - byes
                lo["bowl_wkts"] += 0            # ensures the row exists even wicketless

                okey = ("bowl_phase", ino, pid(bowler), ph)
                facts[okey]["balls"] += legal
                # Economy is charged with everything except byes, which are the
                # keeper's fault, not the bowler's.
                facts[okey]["runs"] += d["runs"]["total"] - byes
                facts[okey]["dots"] += dot if legal else 0
                facts[okey]["fours"] += 1 if runs_bat == 4 else 0
                facts[okey]["sixes"] += 1 if runs_bat == 6 else 0
                facts[okey]["wides"] += wide
                facts[okey]["noballs"] += noball

                for w in d.get("wickets") or []:
                    kind, out = w.get("kind"), w.get("player_out")
                    if kind in NOT_OUT_KINDS or not out:
                        continue
                    fielders = [f.get("name") for f in (w.get("fielders") or []) if f.get("name")]
                    dismissal[(ino, pid(out))] = {
                        "kind": kind,
                        "bowler": bowler if kind in BOWLER_WICKETS or kind == "caught and bowled" else None,
                        "fielder": fielders[0] if fielders else None}
                    if kind in BOWLER_WICKETS:
                        line[(ino, pid(bowler))]["bowl_wkts"] += 1
                    facts[("bat_phase", ino, pid(out), ph)]["outs"] += 1
                    facts[("bat_vs_bowler", ino, pid(out), pid(bowler))]["outs"] += 1
                    if out == batter:
                        facts[gkey]["outs"] += 1
                    if kind in BOWLER_WICKETS:
                        facts[okey]["wkts"] += 1
                    # Also credited to the bowler, because a stumping is the
                    # single sharpest signal that someone bowls spin: of the
                    # bowlers who have never conceded one, every labelled case
                    # was pace. The keeper still gets it in the fielding rows.
                    if kind == "stumped":
                        facts[okey]["stumped"] += 1
                    for f in w.get("fielders") or []:
                        fn = f.get("name")
                        if not fn:
                            continue
                        col = ("stumpings" if kind == "stumped"
                               else "catches" if kind in ("caught", "caught and bowled")
                               else "run_outs" if kind == "run out" else None)
                        if col:
                            fielding[pid(fn)][col] += 1

    if not facts:
        return None

    outcome = info.get("outcome") or {}
    if outcome.get("winner"):
        result = outcome["winner"]
    elif "result" in outcome:
        result = outcome["result"]           # draw / tie / no result
    else:
        result = None
    base = dict(match_id=mid, competition=comp["key"], competition_name=comp["name"],
                format=fmt, tier=tier, gender=gender, season=season, date=date,
                venue=(info.get("venue") or None),
                result=result,
                revision=(raw.get("meta") or {}).get("revision", 0))

    fact_rows = []
    for (kind, ino, player, bucket), m in facts.items():
        fact_rows.append({**base, "kind": kind, "innings": ino, "player_id": player,
                          "bucket": bucket, **{k: int(v) for k, v in m.items()}})
    for player, m in fielding.items():
        fact_rows.append({**base, "kind": "field", "innings": 0, "player_id": player,
                          "bucket": "all", **{k: int(v) for k, v in m.items()}})

    # One match-log row per player per innings, carrying the innings totals and
    # the dismissal. The private _bat_team is dropped before writing.
    for (ino, player), m in line.items():
        d = dismissal.get((ino, player), {})
        fact_rows.append({**base, "kind": "line", "innings": ino, "player_id": player,
                          "bucket": m.get("_bat_team") or "",
                          "bat_balls": int(m.get("bat_balls", 0)),
                          "bat_runs": int(m.get("bat_runs", 0)),
                          "fours": int(m.get("fours", 0)),
                          "sixes": int(m.get("sixes", 0)),
                          "bowl_balls": int(m.get("bowl_balls", 0)),
                          "conceded": int(m.get("conceded", 0)),
                          "bowl_wkts": int(m.get("bowl_wkts", 0)),
                          "out_kind": d.get("kind"),
                          "out_bowler": d.get("bowler"),
                          "out_fielder": d.get("fielder")})

    app_rows = []
    squads = info.get("players") or {}
    pos_by_player = {}
    for (ino, name), p in order.items():
        pos_by_player.setdefault(name, []).append(p)
    for team, squad in squads.items():
        opp = next((t for t in teams if t != team), None)
        for name in squad:
            app_rows.append({**base, "player_id": pid(name), "player_name": name,
                             "team": team, "opposition": opp,
                             "bat_pos": min(pos_by_player.get(name, [99])),
                             "batted": int(name in pos_by_player),
                             "bowled": int(name in bowled)})
    return app_rows, fact_rows


def iter_matches(path: str):
    """Yield (match_id, dict) from a directory of json or a Cricsheet zip."""
    if path.endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            for n in z.namelist():
                if not n.endswith(".json") or n.endswith("README.txt"):
                    continue
                try:
                    yield os.path.basename(n)[:-5], json.loads(z.read(n))
                except Exception:
                    continue
    else:
        for n in sorted(os.listdir(path)):
            if not n.endswith(".json"):
                continue
            try:
                with open(os.path.join(path, n)) as fh:
                    yield n[:-5], json.load(fh)
            except Exception:
                continue


def parse_source(src: str, comp: dict | None, cfg: dict, resolver: Resolver | None = None):
    """Parse a source. With `comp` every match is that competition; with
    `resolver` each match is routed on its own, which is what the daily rolling
    window needs."""
    apps, facts, skipped = [], [], 0
    for mid, raw in iter_matches(src):
        this = comp
        if this is None:
            this = resolver.resolve(raw.get("info") or {})
            if this is None:
                skipped += 1
                continue
        got = parse_match(raw, mid, this, cfg)
        if got is None:
            skipped += 1
            continue
        a, f = got
        apps.extend(a)
        facts.extend(f)
    return pd.DataFrame(apps), pd.DataFrame(facts), skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="zip or directory of match json")
    ap.add_argument("--competition", help="a key from competitions.yml; omit to route "
                                          "each match itself (for the rolling window)")
    ap.add_argument("--out", default="data/cricket/facts")
    ap.add_argument("--config", default=CONFIG)
    args = ap.parse_args()

    cfg = load_config(args.config)
    resolver = None
    comp = None
    if args.competition:
        comp = next((c for c in cfg["competitions"] if c["key"] == args.competition), None)
        if comp is None:
            raise SystemExit(f"unknown competition '{args.competition}' — add it to {args.config}")
    else:
        resolver = Resolver(cfg)

    apps, facts, skipped = parse_source(args.source, comp, cfg, resolver)
    if apps.empty:
        raise SystemExit(f"{args.competition}: nothing parsed from {args.source}")

    os.makedirs(args.out, exist_ok=True)
    ints = ("balls", "runs", "dots", "fours", "sixes", "outs", "wkts",
            "wides", "noballs", "catches", "stumpings", "run_outs", "stumped")
    for df in (apps, facts):
        for c in ints:
            if c in df:
                df[c] = df[c].fillna(0).astype("int32")

    # Gender is part of the filename, not just a column. Cricsheet publishes a
    # competition as two zips, and a filename keyed on the competition alone
    # means the second parse silently overwrites the first — losing every
    # women's match in every competition that has both.
    groups = sorted(set(zip(apps["competition"], apps["gender"])))
    for k, g in groups:
        for name, df in (("appearances", apps), ("facts", facts)):
            part = df[(df["competition"] == k) & (df["gender"] == g)]
            part.to_parquet(os.path.join(args.out, f"{k}_{g}_{name}.parquet"), index=False)

    print(f"matches {apps['match_id'].nunique():,}   skipped {skipped}   "
          f"competition-genders {len(groups)}")
    for k, g in groups:
        a = apps[(apps["competition"] == k) & (apps["gender"] == g)]
        print(f"  {k}_{g:7} {a['match_id'].nunique():5,} matches  "
              f"{a['player_id'].nunique():5,} players  "
              f"{a['season'].min()}–{a['season'].max()}  {', '.join(sorted(a['tier'].unique()))}")
    if resolver is not None and resolver.report():
        print("\ncould not route — add a line to config/cricket/event_aliases.csv:")
        for label, n in resolver.report():
            print(f"  {n:4}  {label}")


if __name__ == "__main__":
    main()
