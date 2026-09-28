"""Pull the Pro Kabaddi League feeds and cache them as raw JSON.

The whole tournament is reachable from eight id-templated endpoints (see
config/kabaddi/feeds.yml). This module walks them in order:

    series registry ─▶ seasons ─▶ per season: matches, standing, leaderboard
                                   per match:  scorecard  ─▶ team ids, player ids
                                   per team:   team feed
                                   per player: player feed

Everything fetched is written to a cache tree and never refetched unless it is
missing or --refresh is passed. A scorecard for a completed match never changes,
so a full history is pulled once and only the in-progress season is refreshed
nightly. In production the cache tree is a GitHub Release asset, exactly like the
Cricsheet archive on the cricket side; nothing here is committed to the repo.

    python pipeline/kabaddi/pull_feeds.py --seasons all
    python pipeline/kabaddi/pull_feeds.py --seasons 185 --limit 5   # a quick look
    python pipeline/kabaddi/pull_feeds.py --check                   # verify the crawl
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

import yaml

HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CFG = os.path.join(HERE, "config", "kabaddi")
RAW = os.path.join(HERE, "data", "kabaddi", "raw")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")


def _cfg(name):
    with open(os.path.join(CFG, name)) as fh:
        return yaml.safe_load(fh)


def load_feeds():
    """feeds.yml with only the {base_*} placeholders resolved.

    A plain str.format would also try to bind {id}, {game} etc. and fail, so the
    bases are substituted by name and the id placeholders are left for the caller.
    """
    f = _cfg("feeds.yml")
    bases = {k: v for k, v in f.items() if k.startswith("base_")}
    out = {}
    for k, tmpl in f.items():
        if k.startswith("base_"):
            continue
        for b, val in bases.items():
            tmpl = tmpl.replace("{" + b + "}", val)
        out[k] = tmpl
    return out


def fetch(url: str, cache: str, refresh: bool = False, delay: float = 0.4) -> dict | None:
    """GET url, decode (some feeds are gzip with no header), cache the parsed JSON.

    The cache holds the parsed-and-reserialised JSON, not the raw bytes, so the
    gzip quirk is dealt with once here and every reader downstream sees plain
    UTF-8. A match that 404s (a fixture with no scorecard yet) is cached as a
    tombstone so a rebuild does not hammer it again.
    """
    if cache and os.path.exists(cache) and not refresh:
        with open(cache, encoding="utf-8") as fh:
            d = json.load(fh)
        return None if d == {"__missing__": True} else d
    try:
        with urlopen(Request(url, headers={"User-Agent": UA,
                                           "Accept-Encoding": "gzip"}), timeout=45) as r:
            body = r.read()
            if r.headers.get("Content-Encoding") == "gzip" or body[:2] == b"\x1f\x8b":
                body = gzip.decompress(body)
            data = json.loads(body.decode("utf-8", "replace"))
    except HTTPError as e:
        # 404/403/410 mean the feed does not exist for this id (older seasons
        # have no tracker, some fixtures never get a scorecard). Tombstone it so
        # a rebuild does not keep asking. Other codes (5xx) are treated as a soft
        # miss — logged, not cached — so a retry can pick them up.
        if e.code in (403, 404, 410):
            data = {"__missing__": True}
        else:
            print(f"  ! HTTP {e.code} {url}")
            return None
    except (URLError, TimeoutError) as e:
        print(f"  ! {url}\n    {e}")
        return None
    if cache:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
    time.sleep(delay)
    return None if data == {"__missing__": True} else data


def pkl_seasons():
    """The season list from config, checked against the live registry."""
    return _cfg("seasons.yml")


def game_ids(matches: dict) -> list[str]:
    """The match ids for a season, from the fixtures feed."""
    return [str(m["game_id"]) for m in matches.get("matches", [])
            if m.get("game_id") and m.get("event_state") == "R"]  # R = result in


def squad_ids(scorecard: dict):
    """Team ids and player ids that appear in one match's scorecard."""
    teams, players = set(), set()
    for t in scorecard.get("teams", {}).get("team", []):
        if t.get("id"):
            teams.add(str(t["id"]))
        for p in t.get("squad", []):
            if p.get("id"):
                players.add(str(p["id"]))
    return teams, players


def pull_season(feeds, ct, sid, out, limit=None, refresh=False):
    """Pull one season's fixtures, tables and every scorecard; collect ids."""
    sd = os.path.join(out, str(sid))
    matches = fetch(feeds["matches"].format(id=sid),
                    os.path.join(sd, "matches.json"), refresh)
    if not matches:
        print(f"  season {sid}: no matches feed")
        return set(), set()
    fetch(feeds["standing"].format(id=sid), os.path.join(sd, "standing.json"), refresh)
    fetch(feeds["leaderboard"].format(ct=ct, id=sid),
          os.path.join(sd, "leaderboard.json"), refresh)
    fetch(feeds["tracker"].format(ct=ct, id=sid), os.path.join(sd, "tracker.json"), refresh)

    gids = game_ids(matches)
    if limit:
        gids = gids[:limit]
    teams, players = set(), set()
    for g in gids:
        sc = fetch(feeds["scorecard"].format(game=g),
                   os.path.join(sd, "scorecards", f"{g}.json"), refresh)
        if sc:
            t, p = squad_ids(sc)
            teams |= t
            players |= p
    print(f"  season {sid:>3}: {len(gids):>3} matches, "
          f"{len(teams):>2} teams, {len(players):>3} players")
    return teams, players


def pull_entities(feeds, teams, players, out, refresh=False):
    """Team and player feeds are cross-season; pull each id once, shared."""
    for t in sorted(teams):
        fetch(feeds["team"].format(team=t), os.path.join(out, "teams", f"{t}.json"), refresh)
    for p in sorted(players):
        fetch(feeds["player"].format(player=p),
              os.path.join(out, "players", f"{p}.json"), refresh)
    print(f"  entities: {len(teams)} teams, {len(players)} players")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="all",
                    help="'all', or space/comma separated season ids")
    ap.add_argument("--limit", type=int, default=None,
                    help="cap matches per season (for a quick look)")
    ap.add_argument("--out", default=RAW)
    ap.add_argument("--refresh", action="store_true",
                    help="refetch even if cached (use for the in-progress season)")
    ap.add_argument("--check", action="store_true",
                    help="verify the crawl on a few seasons and exit")
    args = ap.parse_args()

    feeds = load_feeds()
    cfg = pkl_seasons()
    ct = cfg["competition"]["comp_type"]
    all_ids = [str(s["id"]) for s in cfg["seasons"]]

    if args.check:
        # Old, mid and current season, to prove the templates hold across the
        # whole history (the cache token especially), without a full pull.
        print("checking crawl on seasons 1, 89, 185 (limit 3 scorecards each):")
        for sid in ["1", "89", "185"]:
            pull_season(feeds, ct, sid, args.out, limit=3)
        return

    ids = all_ids if args.seasons == "all" else args.seasons.replace(",", " ").split()
    print(f"pulling {len(ids)} season(s) -> {args.out}")
    teams, players = set(), set()
    for sid in ids:
        t, p = pull_season(feeds, ct, sid, args.out, args.limit, args.refresh)
        teams |= t
        players |= p
    pull_entities(feeds, teams, players, args.out, args.refresh)


if __name__ == "__main__":
    main()
