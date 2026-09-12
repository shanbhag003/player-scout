"""Match a freshly pulled league-season to biography data and merge it in.

This is the only part of the pipeline that thinks. The two collectors produce
workbooks that share no player identifier, so players are matched on name, club
and minutes played across six passes of decreasing strictness. Everything that
survives is written into the master file, keyed on league, season and player.

    python scripts/merge_master.py \
        --understat understat.xlsx --squads squads.xlsx \
        --master data/master_players.csv --mode refresh

Modes
-----
    add_missing  only insert league-seasons the master does not already hold
    refresh      replace those league-seasons outright
    rebuild      discard the master and start from this input alone

Every run writes a report to data/reports/ recording what changed, the match
rate, and which players failed to match. Nothing is merged silently.
"""

import argparse
import html
import json
import os
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone

import pandas as pd
import yaml
from rapidfuzz import fuzz

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CLUB_NOISE = re.compile(
    r"\b(fc|afc|cf|ac|as|sc|ssc|bc|bsc|ud|cd|rc|rcd|sd|sv|tsg|vfb|vfl|fsv|"
    r"borussia|associazione|sportiva|calcio|club|futbol|football|deportivo|"
    r"societa|societe|olympique|stade|racing|real|athletic|atletico|"
    r"eintracht|hertha|werder|bayer|bayern|union|fussballclub|fussball)\b")

BIO_COLUMNS = ["player", "club", "position", "sub_position", "date_of_birth",
               "citizenship", "foot", "height_cm", "contract_expires",
               "market_value_eur", "highest_market_value_eur", "current_club",
               "player_id", "transfermarkt_url"]

# Biography facts that belong to the person rather than to a season, and so can
# safely be carried across seasons when one season's row is missing.
PERSON_FIELDS = ["tm_date_of_birth", "tm_citizenship", "tm_foot", "tm_height_cm"]


# ── normalisation ────────────────────────────────────────────────────────────

def strip_accents(text):
    # Understat serves some names HTML-escaped ("N&#039;Goumou").
    return (unicodedata.normalize("NFKD", html.unescape(str(text)))
            .encode("ascii", "ignore").decode())


def norm_name(text):
    text = re.sub(r"[^a-z ]", " ", strip_accents(text).lower())
    return re.sub(r"\s+", " ", text).strip()


def norm_club(text):
    text = re.sub(r"[^a-z0-9 ]", " ", strip_accents(text).lower())
    text = CLUB_NOISE.sub(" ", text)
    text = re.sub(r"\b(18|19|20)\d{2}\b", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def surname_key(name):
    parts = norm_name(name).split()
    return parts[-1] if parts else ""


def load_config(path):
    with open(path) as f:
        return yaml.safe_load(f)


def load_aliases(path):
    """Curated name equivalences, applied before matching.

    Some players are recorded under a nickname at one source and a legal name
    at the other: Bono is Yassine Bounou. Fuzzy matching cannot bridge those,
    and loosening it far enough to try would start matching Robert of Real
    Betis to Robert Lewandowski.
    """
    if not path or not os.path.exists(path):
        return {}
    frame = pd.read_csv(path, comment="#")
    return {norm_name(r["understat_name"]): norm_name(r["transfermarkt_name"])
            for _, r in frame.iterrows()}


# ── loading ──────────────────────────────────────────────────────────────────

def prepare(stats, bio, config, aliases):
    canon = config.get("league_name_aliases", {})

    def fix(value):
        return canon.get(norm_name(value).replace(" ", ""),
                         canon.get(norm_name(value), value))

    stats = stats.copy()
    bio = bio.copy()
    stats["player"] = stats["player"].map(lambda v: html.unescape(str(v)))
    stats["league"] = stats["league"].map(fix)
    bio["league"] = bio["league"].map(fix)
    stats["season_key"] = stats["season"]
    bio["season_key"] = bio["season_label"]
    stats["name_key"] = stats["player"].map(norm_name).map(lambda n: aliases.get(n, n))
    bio["name_key"] = bio["player"].map(norm_name)
    stats["club_key"] = stats["team"].map(norm_club)
    bio["club_key"] = bio["club"].map(norm_club)
    stats["surname"] = stats["player"].map(surname_key)
    bio["surname"] = bio["player"].map(surname_key)
    return stats.reset_index(drop=True), bio.reset_index(drop=True)


# ── matching ─────────────────────────────────────────────────────────────────

def match(stats, bio):
    index = defaultdict(list)
    for bi in range(len(bio)):
        index[(bio.at[bi, "league"], bio.at[bi, "season_key"])].append(bi)

    seasons = sorted(set(stats["season_key"]) | set(bio["season_key"]))
    order = {s: i for i, s in enumerate(seasons)}
    taken, done, results = set(), set(), []

    # 1. Identical normalised name inside the same league and season.
    exact = defaultdict(list)
    for (lg, sn), rows in index.items():
        for bi in rows:
            exact[(lg, sn, bio.at[bi, "name_key"])].append(bi)
    for si in range(len(stats)):
        key = (stats.at[si, "league"], stats.at[si, "season_key"], stats.at[si, "name_key"])
        options = [b for b in exact.get(key, []) if b not in taken]
        if len(options) == 1:
            taken.add(options[0]); done.add(si)
            results.append((si, options[0], "exact_name", 100.0))
        elif len(options) > 1:
            best = min(options, key=lambda b: abs(
                (bio.at[b, "minutes"] or 0) - (stats.at[si, "minutes"] or 0)))
            taken.add(best); done.add(si)
            results.append((si, best, "exact_name_minutes", 95.0))

    # Club names differ between sources, so derive the mapping from the
    # confident matches rather than maintaining a lookup table by hand.
    votes = defaultdict(Counter)
    for si, bi, _, _ in results:
        votes[(stats.at[si, "league"], stats.at[si, "club_key"])][bio.at[bi, "club_key"]] += 1
    club_map = {k: v.most_common(1)[0][0] for k, v in votes.items() if v}

    def club_pool(si):
        target = club_map.get((stats.at[si, "league"], stats.at[si, "club_key"]))
        if not target:
            return []
        key = (stats.at[si, "league"], stats.at[si, "season_key"])
        return [b for b in index.get(key, [])
                if b not in taken and bio.at[b, "club_key"] == target]

    # 2. Same club and season, fuzzy name, corroborated by minutes.
    for si in range(len(stats)):
        if si in done:
            continue
        mins = stats.at[si, "minutes"] or 0
        best, best_score = None, 0.0
        for bi in club_pool(si):
            score = fuzz.token_set_ratio(stats.at[si, "name_key"], bio.at[bi, "name_key"])
            bmins = bio.at[bi, "minutes"] or 0
            if stats.at[si, "surname"] == bio.at[bi, "surname"]:
                score += 12
            if abs(bmins - mins) <= max(300, 0.35 * max(mins, bmins, 1)):
                score += 8
            if score > best_score:
                best, best_score = bi, score
        if best is not None and best_score >= 82:
            taken.add(best); done.add(si)
            results.append((si, best, "club_fuzzy", round(best_score, 1)))

    # 3. Surname or containment, same club and season.
    for si in range(len(stats)):
        if si in done:
            continue
        mins = stats.at[si, "minutes"] or 0
        options = [bi for bi in club_pool(si)
                   if stats.at[si, "surname"] == bio.at[bi, "surname"]
                   or stats.at[si, "name_key"] in bio.at[bi, "name_key"]
                   or bio.at[bi, "name_key"] in stats.at[si, "name_key"]]
        if options:
            best = min(options, key=lambda b: abs((bio.at[b, "minutes"] or 0) - mins))
            taken.add(best); done.add(si)
            results.append((si, best, "surname_club", 75.0))

    # 4. A shared name component, the same club, and minutes agreeing within 8%.
    #    Sources often keep different parts of a long name: Understat's
    #    "Nianzou Kouassi" is Transfermarkt's "Tanguy Nianzou", and
    #    "Marcos de Sousa" is "Marcos Andre". Neither surname nor whole-string
    #    fuzzy matching bridges those. Minutes played within one club-season is
    #    close to a fingerprint, which is what makes this safe. If two
    #    candidates fit, neither is taken.
    for si in range(len(stats)):
        if si in done:
            continue
        mins = stats.at[si, "minutes"] or 0
        tokens = {t for t in stats.at[si, "name_key"].split() if len(t) >= 4}
        if not tokens or mins <= 0:
            continue
        fits = []
        for bi in club_pool(si):
            btokens = {t for t in bio.at[bi, "name_key"].split() if len(t) >= 4}
            bmins = bio.at[bi, "minutes"] or 0
            if (tokens & btokens) and abs(bmins - mins) <= max(60, 0.08 * max(mins, bmins, 1)):
                fits.append(bi)
        if len(fits) == 1:
            taken.add(fits[0]); done.add(si)
            results.append((si, fits[0], "token_minutes", 85.0))

    # 5. League and season only, strong fuzzy name. Catches loan spells, where
    #    the two sources record the player at different clubs.
    for si in range(len(stats)):
        if si in done:
            continue
        key = (stats.at[si, "league"], stats.at[si, "season_key"])
        best, best_score = None, 0.0
        for bi in index.get(key, []):
            if bi in taken:
                continue
            score = fuzz.token_set_ratio(stats.at[si, "name_key"], bio.at[bi, "name_key"])
            if stats.at[si, "surname"] == bio.at[bi, "surname"]:
                score += 10
            if score > best_score:
                best, best_score = bi, score
        if best is not None and best_score >= 92:
            taken.add(best); done.add(si)
            results.append((si, best, "league_fuzzy", round(best_score, 1)))

    # 6. Absent from this season's biography rows but present in another.
    #    Date of birth does not change, so borrowing it is safe; the season it
    #    came from is recorded so a stale contract date is visible.
    anywhere = defaultdict(list)
    for bi in range(len(bio)):
        anywhere[bio.at[bi, "name_key"]].append(bi)
    for si in range(len(stats)):
        if si in done:
            continue
        options = anywhere.get(stats.at[si, "name_key"], [])
        if not options:
            continue
        same_league = [b for b in options if bio.at[b, "league"] == stats.at[si, "league"]]
        pool = same_league or options
        nearest = min(pool, key=lambda b: abs(
            order.get(bio.at[b, "season_key"], 0) - order.get(stats.at[si, "season_key"], 0)))
        done.add(si)
        results.append((si, nearest, "cross_season", 70.0))

    return results, club_map


def assemble(stats, bio, results):
    lookup = {si: (bi, how, score) for si, bi, how, score in results}
    rows = []
    for si in range(len(stats)):
        row = stats.iloc[si].to_dict()
        bi, how, score = lookup.get(si, (None, "unmatched", 0.0))
        for col in BIO_COLUMNS:
            row[f"tm_{col}"] = (bio.at[bi, col]
                                if bi is not None and col in bio.columns else None)
        row["match_pass"] = how
        row["match_score"] = score
        row["bio_season"] = bio.at[bi, "season_key"] if bi is not None else None
        rows.append(row)
    out = pd.DataFrame(rows)
    # Identity comes from the statistics source, not the biography source. Its
    # id is present on every row and survives club and league changes - Harry
    # Kane keeps id 647 moving from Tottenham to Bayern - whereas a player who
    # matched a biography row in one season and not another would otherwise get
    # two different identities and be split in half by the dashboard.
    out["player_uid"] = out["id"].map(lambda v: f"us{int(v)}")
    return out


def resolve_identity(master):
    """Force one biography per player, and repair rows that picked another.

    Matching runs per season, so a player can match one person in one season and
    a different person in the next. That is not hypothetical: Understat ids 1245
    and 7430 are Emerson Palmieri and Emerson Royal, and season-by-season
    matching handed each of them the other's contract in some years.

    For every player, the biography claimed by the most minutes at the highest
    confidence wins, and rows that disagree have their biography cleared and
    refilled from that player's own nearest season.
    """
    master = master.copy()
    fixed, conflicts = 0, []

    has_bio = master["tm_player_id"].notna()
    if not has_bio.any():
        return master, {"rows_repaired": 0, "identity_conflicts": []}

    weight = master["match_score"].fillna(0) * master["minutes"].fillna(0).clip(lower=1)
    scored = (master.assign(_w=weight)[has_bio]
              .groupby(["player_uid", "tm_player_id"])["_w"].sum()
              .reset_index().sort_values("_w", ascending=False))

    # Assign greedily, strongest claim first, and never hand the same biography
    # to two players. Two people genuinely share a display name more often than
    # you would guess - Understat 1245 and 7430 are both "Emerson" - so a
    # per-player vote alone would give both of them the same date of birth.
    # Losing a claim sends that player to their next-best biography instead.
    canonical, used = {}, set()
    for row in scored.itertuples(index=False):
        if row.player_uid in canonical or row.tm_player_id in used:
            continue
        canonical[row.player_uid] = row.tm_player_id
        used.add(row.tm_player_id)

    for uid in scored["player_uid"].unique():
        if uid not in canonical:
            rows = master[master["player_uid"] == uid]
            conflicts.append({
                "player_uid": uid,
                "players": sorted(set(rows["player"])),
                "career_minutes": int(rows["minutes"].fillna(0).sum()),
                "note": "shares a name with another player and every candidate "
                        "biography was already claimed; add a line to "
                        "config/aliases.csv to separate them",
            })

    bio_cols = [c for c in master.columns if c.startswith("tm_")]
    target = master["player_uid"].map(canonical)
    # Wrong if the row claims a different biography than its player was awarded,
    # or if its player was awarded none at all but the row still carries one.
    wrong = ((target.notna() & (master["tm_player_id"] != target))
             | (target.isna() & master["tm_player_id"].notna()))
    fixed = int(wrong.sum())
    if fixed:
        master.loc[wrong, bio_cols] = None
        master.loc[wrong, "match_pass"] = "identity_repaired"
        master.loc[wrong, "bio_season"] = None
        # Refill from a season where this player did claim the right biography.
        donors = (master[~wrong & master["tm_player_id"].notna()]
                  .sort_values("match_score", ascending=False)
                  .drop_duplicates("player_uid").set_index("player_uid"))
        for col in bio_cols:
            if col in donors.columns:
                master.loc[wrong, col] = master.loc[wrong, "player_uid"].map(donors[col])

    return master, {"rows_repaired": fixed, "identity_conflicts": conflicts}


def backfill_person(master):
    """Carry time-invariant facts across every season of the same player."""
    for col in PERSON_FIELDS:
        if col in master.columns:
            master[col] = master.groupby("player_uid")[col].transform(
                lambda s: s.ffill().bfill())
    return master


# ── merging ──────────────────────────────────────────────────────────────────

def merge(master, incoming, mode):
    """Upsert incoming league-seasons into the master, returning (master, log)."""
    incoming_keys = set(zip(incoming["league"], incoming["season"]))
    log = {"mode": mode, "incoming_rows": len(incoming),
           "league_seasons": sorted(f"{l} {s}" for l, s in incoming_keys)}

    if master is None or mode == "rebuild":
        log["existing_rows"] = 0 if master is None else len(master)
        log["action"] = "replaced everything"
        return backfill_person(incoming.copy()), log

    log["existing_rows"] = len(master)
    existing_keys = set(zip(master["league"], master["season"]))

    if mode == "add_missing":
        new_keys = incoming_keys - existing_keys
        skipped = sorted(f"{l} {s}" for l, s in (incoming_keys & existing_keys))
        incoming = incoming[[k in new_keys for k in zip(incoming["league"], incoming["season"])]]
        log["skipped_already_present"] = skipped
        combined = pd.concat([master, incoming], ignore_index=True)
    else:  # refresh
        mask = [k not in incoming_keys for k in zip(master["league"], master["season"])]
        log["replaced_rows"] = int(len(master) - sum(mask))
        combined = pd.concat([master[mask], incoming], ignore_index=True)

    combined = combined.drop_duplicates(subset=["league", "season", "id"], keep="last")
    log["final_rows"] = len(combined)
    log["rows_added"] = len(combined) - len(master)
    return backfill_person(combined), log


def report(master, incoming, log, club_map, path):
    matched = incoming[incoming["match_pass"] != "unmatched"]
    regulars = incoming[incoming["minutes"] >= 900]
    reg_matched = regulars[regulars["match_pass"] != "unmatched"]
    unmatched = incoming[(incoming["match_pass"] == "unmatched") & (incoming["minutes"] >= 900)]

    log.update({
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "match_rate": round(len(matched) / max(len(incoming), 1), 4),
        "match_rate_900min": round(len(reg_matched) / max(len(regulars), 1), 4),
        "by_pass": incoming["match_pass"].value_counts().to_dict(),
        "club_mappings": len(club_map),
        "date_of_birth_coverage": round(float(master["tm_date_of_birth"].notna().mean()), 4),
        "contract_coverage": round(float(master["tm_contract_expires"].notna().mean()), 4),
        "master_rows": len(master),
        "master_players": int(master["player_uid"].nunique()),
        "master_league_seasons": sorted(
            f"{l} {s}" for l, s in set(zip(master["league"], master["season"]))),
        "unmatched_over_900_minutes": unmatched[
            ["player", "team", "league", "season", "minutes"]
        ].to_dict("records"),
    })
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(log, f, indent=1, default=str)
    return log


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--understat", required=True)
    ap.add_argument("--squads", required=True)
    ap.add_argument("--master", default=os.path.join(HERE, "data", "master_players.csv"))
    ap.add_argument("--config", default=os.path.join(HERE, "config", "leagues.yml"))
    ap.add_argument("--aliases", default=os.path.join(HERE, "config", "aliases.csv"))
    ap.add_argument("--mode", default="refresh",
                    choices=["add_missing", "refresh", "rebuild"])
    ap.add_argument("--only-seasons", nargs="*", default=None,
                    help="restrict to these season labels, e.g. 2025/26. Guards "
                         "against merging a partial season by accident.")
    ap.add_argument("--report", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-missing-bio", action="store_true",
                    help="merge league-seasons that have no biography data")
    args = ap.parse_args()

    config = load_config(args.config)
    aliases = load_aliases(args.aliases)
    stats = pd.read_excel(args.understat, "All players")
    bio = pd.read_excel(args.squads, "Squads")
    if args.only_seasons:
        stats = stats[stats["season"].isin(args.only_seasons)]
        bio = bio[bio["season_label"].isin(args.only_seasons)]
    stats, bio = prepare(stats, bio, config, aliases)
    print(f"incoming statistics : {len(stats):,} player-seasons")
    print(f"incoming biography  : {len(bio):,} player-seasons")
    print(f"aliases             : {len(aliases)}")

    # A league-season with statistics but no biography rows would merge as a
    # block of empty ages and contracts. Refuse it: almost always the cause is
    # pulling a season the biography source has not published yet.
    stats_keys = set(zip(stats["league"], stats["season_key"]))
    bio_keys = set(zip(bio["league"], bio["season_key"]))
    orphans = sorted(f"{l} {s}" for l, s in (stats_keys - bio_keys))
    if orphans:
        print("\nNo biography data for: " + ", ".join(orphans))
        print("The biography source has probably not published these yet.")
        if not args.allow_missing_bio:
            print("Nothing merged. Rerun with --allow-missing-bio to accept "
                  "statistics with no ages or contracts.")
            return 1
        print("Continuing anyway: these rows will have no age or contract.")

    results, club_map = match(stats, bio)
    incoming = assemble(stats, bio, results)

    master = None
    if os.path.exists(args.master) and args.mode != "rebuild":
        master = pd.read_csv(args.master, low_memory=False)

    combined, log = merge(master, incoming, args.mode)
    combined, identity = resolve_identity(combined)
    log.update(identity)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    report_path = args.report or os.path.join(HERE, "data", "reports", f"merge-{stamp}.json")
    log = report(combined, incoming, log, club_map, report_path)

    print(f"\nmatched          : {log['match_rate']:.1%} overall, "
          f"{log['match_rate_900min']:.1%} of players with 900+ minutes")
    for name, n in log["by_pass"].items():
        print(f"  {name:20} {n:6,}")
    print(f"\nmaster           : {log['master_rows']:,} rows, "
          f"{log['master_players']:,} players, "
          f"{len(log['master_league_seasons'])} league-seasons")
    print(f"date of birth    : {log['date_of_birth_coverage']:.1%}")
    if log.get("rows_repaired"):
        print(f"identity repairs : {log['rows_repaired']} rows given the wrong "
              f"person's biography, corrected")
    for c in log.get("identity_conflicts", []):
        print(f"  no biography for {' / '.join(c['players'])} "
              f"({c['career_minutes']:,} minutes): {c['note']}")
    print(f"contract date    : {log['contract_coverage']:.1%}")
    if log.get("skipped_already_present"):
        print(f"skipped (already present): {', '.join(log['skipped_already_present'])}")

    if args.dry_run:
        print("\nDry run: master not written.")
    else:
        combined.to_csv(args.master, index=False)
        print(f"\nwrote {args.master}")
    print(f"report: {report_path}")


if __name__ == "__main__":
    raise SystemExit(main() or 0)
