"""Refresh the parts of a player record that change between seasons.

A player's numbers are fixed once a season ends. Where they play is not: a
transfer in the window makes the club recorded against them wrong, and the
interface has no way of knowing. Cristian Romero's record said Tottenham for
weeks after he had left.

So this runs on its own schedule, independent of the seasonal collection. It
touches four fields and nothing else:

    tm_current_club
    tm_market_value_eur
    tm_contract_expires
    tm_transfermarkt_url

Everything derived from match data - minutes, shots, expected goals, every
percentile - is left exactly as it was. A club move is not a reason to rescore
anyone.

    python pipeline/refresh_clubs.py
    python pipeline/refresh_clubs.py --dry-run
"""

import argparse
import io
import json
import os
import sys
import zipfile
from datetime import datetime, timezone

import pandas as pd
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_squads import DATA_URL, HDR, load_tables   # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(HERE, "data", "master_players.csv")

# Only these move. Anything else in the master stays untouched.
DATE_FIELDS = {"tm_contract_expires"}


def tidy(value, field):
    """Put both sides into the same shape before comparing.

    Upstream publishes dates as timestamps and the master stores them as plain
    dates, so a raw comparison reports every contract as changed and then writes
    `2028-06-30 00:00:00` over `2028-06-30`. Nothing has changed; only the
    formatting has.
    """
    if pd.isna(value):
        return None
    if field in DATE_FIELDS:
        parsed = pd.to_datetime(value, errors="coerce")
        return None if pd.isna(parsed) else parsed.strftime("%Y-%m-%d")
    if field == "tm_market_value_eur":
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None
    return str(value).strip() or None


REFRESHABLE = {
    "current_club_name": "tm_current_club",
    "market_value_in_eur": "tm_market_value_eur",
    "contract_expiration_date": "tm_contract_expires",
    "url": "tm_transfermarkt_url",
}


def fetch_players():
    print(f"downloading player records from {DATA_URL}")
    r = requests.get(DATA_URL, headers=HDR, timeout=300)
    r.raise_for_status()
    tables = load_tables(r.content, ["players"])
    players = tables.get("players")
    if players is None or players.empty:
        raise RuntimeError("no players table in the archive")
    print(f"  {len(players):,} player records")
    return players


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", default=MASTER)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report", default=os.path.join(HERE, "data", "reports"))
    ap.add_argument("--inspect", type=int, metavar="TM_ID",
                    help="print every upstream field for one player and stop")
    args = ap.parse_args()

    master = pd.read_csv(args.master, low_memory=False)
    known = master["tm_player_id"].dropna().astype("int64").unique()
    print(f"master holds {len(master):,} rows covering {len(known):,} identified players")

    players = fetch_players()
    id_col = "player_id" if "player_id" in players.columns else players.columns[0]
    players[id_col] = pd.to_numeric(players[id_col], errors="coerce")
    fresh = players[players[id_col].isin(known)].drop_duplicates(id_col).set_index(id_col)
    print(f"  {len(fresh):,} of them found upstream")

    # How stale is the snapshot? If a date column exists, the newest value in it
    # is the best available answer.
    stamp = None
    for col in ("date_of_last_update", "last_updated", "date"):
        if col in players.columns:
            stamp = str(pd.to_datetime(players[col], errors="coerce").max())[:10]
            break
    if stamp:
        print(f"  upstream snapshot appears to be from {stamp}")

    if args.inspect:
        row = players[players[id_col] == args.inspect]
        if row.empty:
            print(f"\nplayer {args.inspect} is not in the upstream table")
        else:
            print(f"\nupstream record for {args.inspect}:")
            for k, v in row.iloc[0].items():
                print(f"  {str(k):34} {v}")
        held = master[pd.to_numeric(master['tm_player_id'], errors='coerce') == args.inspect]
        if not held.empty:
            print("\nwhat the master holds:")
            for c in ("tm_player", "team", "season", "tm_current_club",
                      "tm_contract_expires", "tm_market_value_eur"):
                if c in held.columns:
                    print(f"  {c:34} {held.iloc[-1][c]}")
        return

    available = {src: dst for src, dst in REFRESHABLE.items() if src in fresh.columns}
    missing = sorted(set(REFRESHABLE) - set(available))
    if missing:
        print(f"  not published upstream, left alone: {', '.join(missing)}")

    ids = pd.to_numeric(master["tm_player_id"], errors="coerce")
    changes, examples = {}, []
    for src, dst in available.items():
        if dst not in master.columns:
            continue
        incoming = ids.map(fresh[src]).map(lambda v: tidy(v, dst))
        current = master[dst].map(lambda v: tidy(v, dst))
        # Never blank a value we already hold just because the feed omits it.
        new = incoming.where(incoming.notna(), current)
        differs = new.notna() & current.notna() & (new != current)
        added = new.notna() & current.isna()
        changes[dst] = int(differs.sum())
        if int(added.sum()):
            changes[f"{dst} (newly filled)"] = int(added.sum())
        if dst == "tm_current_club":
            for _, row in master[differs].drop_duplicates("player_uid").head(12).iterrows():
                examples.append({
                    "player": row.get("tm_player") or row.get("player"),
                    "was": row[dst], "now": new[row.name],
                })
        master[dst] = new

    print("\nfields updated:")
    for dst, n in changes.items():
        print(f"  {dst:26} {n:6,} rows changed")
    if examples:
        print("\nclub moves picked up:")
        for e in examples:
            print(f"  {str(e['player'])[:26]:26} {str(e['was'])[:24]:24} -> {e['now']}")

    log = {
        "upstream_snapshot": stamp,
        "refreshed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rows": len(master), "identified_players": int(len(known)),
        "matched_upstream": int(len(fresh)),
        "fields": changes, "skipped_fields": missing,
        "club_moves": examples,
    }
    os.makedirs(args.report, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    with open(os.path.join(args.report, f"clubs-{stamp}.json"), "w") as f:
        json.dump(log, f, indent=1, default=str)

    if args.dry_run:
        print("\nDry run: master not written.")
    else:
        master.to_csv(args.master, index=False)
        print(f"\nwrote {args.master}")


if __name__ == "__main__":
    main()
