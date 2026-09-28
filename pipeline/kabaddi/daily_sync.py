"""Decide, cheaply, whether there is anything new to rebuild — and pull only it.

A full rebuild is a couple of minutes of feed traffic and a model fit; running it
every morning when no kabaddi was played would be wasteful and rude to the feeds.
So this walks a chain of guards, backing out at the first that shows nothing new,
and only when it reaches the end does it pull the delta and signal a rebuild:

  1. series      Is a season present that we do not have? And which season is the
                 current one? (There is always a current one to check.)
  2. fixtures    Does that season's fixtures feed hold anything at all?
  3. completed   Are there completed matches whose scorecard we have not already
                 cached? If not, back out.
  4. pull        Fetch those scorecards and any player/team feeds they introduce,
                 into the cache, and say a rebuild is needed.

State is the cache itself — a scorecard on disk means that match is ingested — so
there is nothing separate to keep in sync. A brand-new season is appended to
seasons.yml (its year read from the series name) so the model's recency weighting
knows how old it is.

Writes `changed`, `new_matches` and `new_seasons` to $GITHUB_OUTPUT for the
workflow to branch on. Exit status is always 0: "nothing to do" is a success.

    python pipeline/kabaddi/daily_sync.py --raw data/kabaddi/raw
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import sys

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pull_feeds import load_feeds, fetch, game_ids, squad_ids  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CFG = os.path.join(HERE, "config", "kabaddi")
RAW = os.path.join(HERE, "data", "kabaddi", "raw")


def pkl_from_series(series: dict, alias: str, comp_type: str):
    """The PKL seasons the live registry knows, with a year read from the name."""
    out = []
    for x in (series.get("data", {}) or {}).get("series", []):
        if str(x.get("comp_type")) != str(comp_type) or str(x.get("alias", "")).lower() != alias:
            continue
        name = x.get("name", "")
        yr = re.search(r"(20\d{2})", name)
        sn = re.search(r"Season\s+(\d+)", name)
        out.append({"id": str(x["id"]),
                    "year": int(yr.group(1)) if yr else None,
                    "season": int(sn.group(1)) if sn else None,
                    "name": name})
    return out


def cached_scorecards(raw, sid):
    return {os.path.splitext(os.path.basename(f))[0]
            for f in glob.glob(os.path.join(raw, str(sid), "scorecards", "*.json"))}


def append_seasons(new):
    """Add newly-appeared seasons to seasons.yml, keeping the file's shape."""
    path = os.path.join(CFG, "seasons.yml")
    with open(path, "a") as fh:
        for s in sorted(new, key=lambda x: x["season"] or 0):
            fh.write(f'  - {{id: {s["id"]}, season: {s["season"]}, '
                     f'year: {s["year"]}}}   # added automatically\n')


def _out(**kv):
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a") as fh:
        for k, v in kv.items():
            fh.write(f"{k}={v}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=RAW)
    args = ap.parse_args()

    feeds = load_feeds()
    cfg = yaml.safe_load(open(os.path.join(CFG, "seasons.yml")))
    ct = cfg["competition"]["comp_type"]
    alias = cfg["competition"]["alias"]
    known = {str(s["id"]) for s in cfg["seasons"]}

    # ── guard 1: series ────────────────────────────────────────────────
    series = fetch(feeds["series"], cache=None, delay=0)
    if not series:
        print("series feed unreachable; nothing done")
        _out(changed="false", new_matches=0, new_seasons=0)
        return 0
    live = pkl_from_series(series, alias, ct)
    if not live:
        print("no PKL seasons in the registry; nothing done")
        _out(changed="false", new_matches=0, new_seasons=0)
        return 0
    live_ids = {s["id"] for s in live}
    new_seasons = [s for s in live if s["id"] not in known]
    # The current season is the newest by year; always worth checking for new
    # matches even when no brand-new season has appeared.
    current = max(live, key=lambda s: (s["year"] or 0))["id"]
    candidates = list({current} | {s["id"] for s in new_seasons})
    if new_seasons:
        print(f"new season(s): {', '.join(s['id'] for s in new_seasons)}")

    # ── guards 2 & 3 per candidate: fixtures, then completed matches ───
    total_new, touched = 0, []
    for sid in candidates:
        matches = fetch(feeds["matches"].format(id=sid),
                        os.path.join(args.raw, sid, "matches.json"), refresh=True)
        if not matches or not matches.get("matches"):
            print(f"  season {sid}: no fixtures yet")
            continue
        completed = set(game_ids(matches))
        have = cached_scorecards(args.raw, sid)
        new_games = sorted(completed - have)
        if not new_games:
            print(f"  season {sid}: up to date ({len(have)} matches)")
            continue

        # ── guard 4: pull the delta ────────────────────────────────────
        print(f"  season {sid}: {len(new_games)} new completed match(es)")
        for feed in ("standing", "leaderboard", "tracker"):
            url = (feeds[feed].format(ct=ct, id=sid) if "{ct}" in feeds[feed]
                   else feeds[feed].format(id=sid))
            fetch(url, os.path.join(args.raw, sid, f"{feed}.json"), refresh=True)
        teams, players = set(), set()
        for g in new_games:
            sc = fetch(feeds["scorecard"].format(game=g),
                       os.path.join(args.raw, sid, "scorecards", f"{g}.json"))
            if sc:
                t, p = squad_ids(sc)
                teams |= t
                players |= p
        for t in sorted(teams):
            dest = os.path.join(args.raw, "teams", f"{t}.json")
            if not os.path.exists(dest):
                fetch(feeds["team"].format(team=t), dest)
        for p in sorted(players):
            dest = os.path.join(args.raw, "players", f"{p}.json")
            if not os.path.exists(dest):
                fetch(feeds["player"].format(player=p), dest)
        total_new += len(new_games)
        touched.append(sid)

    if new_seasons:
        append_seasons(new_seasons)

    changed = total_new > 0 or bool(new_seasons)
    if not changed:
        print("\nup to date; nothing to rebuild")
    else:
        print(f"\nrebuild needed: {total_new} new match(es) in {', '.join(touched) or '-'}"
              f"{', new season' if new_seasons else ''}")
    _out(changed=str(changed).lower(), new_matches=total_new,
         new_seasons=len(new_seasons))
    return 0


if __name__ == "__main__":
    sys.exit(main())
