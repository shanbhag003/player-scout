# Player data

The single source of truth behind Player Scout: one row per player per
league-season, with playing statistics, date of birth, contract expiry, market
value and a real positional label on the same row.

Updating it is a form with four boxes. You never run anything locally.

---

## What is in the master today

`data/master_players.csv` — **13,980 rows, 5,718 players, 25 league-seasons.**
The big five leagues, 2021/22 to 2025/26.

98.5% of rows carry a date of birth, and 99.9% of players with 900 or more
minutes are matched to their biography.

The current season is deliberately absent. Partial seasons produce per-90 rates
from tiny samples, and biography data for a season in progress usually is not
published yet.

---

## Adding a season or a league

**Actions** → **Update master data** → **Run workflow**.

| Box | What to put in it |
|---|---|
| **leagues** | Keys from `config/leagues.yml`, space separated. Default is the big five. |
| **seasons** | Starting years. `2026` means 2026/27. Several are fine: `2024 2025 2026`. |
| **mode** | See below. |
| **min_minutes** | Usually `0`. Filtering happens later in the dashboard. |
| **dry_run** | Tick to see what would change without saving it. |

Then press the green button. Fifteen to forty minutes depending on how much you
asked for. The master is committed automatically when it finishes, and the run
summary shows exactly what changed.

### Modes

- **add_missing** — only insert league-seasons the master does not already
  hold. Existing data is untouched. This is the safe default and what you want
  when a season ends.
- **refresh** — replace those league-seasons outright. Use this when a source
  has corrected its numbers, or when the season you pulled was still in
  progress last time.
- **rebuild** — throw the master away and start from this pull alone. Only for
  starting over.

### Examples

Add the 2026/27 Premier League and La Liga once those seasons finish:

```
leagues:  EPL LALIGA
seasons:  2026
mode:     add_missing
```

Correct a season already in the master:

```
leagues:  SERIEA
seasons:  2024
mode:     refresh
```

---

## Adding a league that is not listed

Open `config/leagues.yml` and add a block. Each league needs two sources:

```yaml
  - key: EREDIVISIE
    name: Eredivisie
    country: Netherlands
    stats: {source: understat, code: null}
    bio:   {source: transfermarkt, code: NL1}
```

**The catch, and it is a real one.** Understat publishes the big five leagues
and nothing else. There is no Eredivisie, no Liga Portugal, no Championship. So
those leagues are already listed in the config with `stats: {source: none}`,
and the workflow will refuse to run them:

```
No statistics source for: Eredivisie
These leagues have ages and contracts available but no playing statistics,
so there would be nothing to compare players on.
```

That is deliberate. Transfermarkt covers most of Europe, so you could pull ages
and contracts for the Eredivisie tomorrow — and end up with several hundred
players carrying a birthday and no xG, which would quietly poison the
dashboard.

Adding one of those leagues properly means finding a statistics source that
covers it and writing a small puller for it. Once it exists, set
`stats.source` to its name and everything downstream works unchanged.

---

## How a run works

```
  your choices                    resolve_leagues.py
  EPL, 2026          ────────►    EPL → understat 'EPL', transfermarkt 'GB1'
                                  refuses leagues with no statistics source
                                            │
                    ┌───────────────────────┴───────────────────────┐
                    ▼                                               ▼
         pull_understat.py                              build_squads.py
         playing statistics                       ages, contracts, values
                    │                                               │
                    └───────────────────────┬───────────────────────┘
                                            ▼
                                   merge_master.py
                     matches the two on name, club and minutes,
                     then inserts or replaces league-seasons
                                            │
                                            ▼
                              data/master_players.csv
                              data/reports/merge-*.json
```

Only the master and the reports are committed. The two workbooks are kept as
run artifacts for fourteen days so you can inspect a run, then discarded — they
are large, they change constantly, and they can always be pulled again.

---

## Matching

The two sources share no player identifier, so players are matched across six
passes, each more permissive than the last. Every row records which pass matched
it, in `match_pass`, and how confident it was, in `match_score`.

| Pass | Rule |
|---|---|
| `exact_name` | Same normalised name, league and season |
| `club_fuzzy` | Same club, fuzzy name, corroborated by minutes |
| `surname_club` | Shared surname inside the same club |
| `token_minutes` | Shared name component, same club, minutes agree within 8% |
| `league_fuzzy` | Strong name match anywhere in the league — catches loan spells |
| `cross_season` | Absent this season, present in another; borrows the date of birth |
| `identity_repaired` | Had another player's biography; cleared and refilled |

`token_minutes` is the one doing unusual work. The two sources often keep
different parts of a long name — Understat's *Nianzou Kouassi* is
Transfermarkt's *Tanguy Nianzou*, and *Marcos de Sousa* is *Marcos André* — so
neither surname nor whole-string fuzzy matching bridges them. Minutes played
inside a single club-season is close to a fingerprint: 2,704 against 2,710 is
the same person. If two candidates fit, neither is taken.

### When a regular player does not match

The run summary lists every unmatched player with 900+ minutes. If one is a
genuine name difference, add a line to `config/aliases.csv`:

```csv
understat_name,transfermarkt_name
Bono,Yassine Bounou
Franck Zambo,Frank Anguissa
```

Edit it on GitHub directly and rerun with mode `refresh`. Only add a row when
you are certain it is the same person — the alias file is applied before any
matching and overrides everything.

Thresholds are deliberately strict. Loosened far enough to catch the last few,
fuzzy matching starts pairing *Robert* of Real Betis with Robert Lewandowski at
a perfect score. A blank contract date is visible; a wrong one is not.

---

## Player identity and links

`player_uid` comes from the statistics source's id, not the biography source's.
That id is on every row, and it survives club and league changes — Harry Kane
keeps the same id moving from Tottenham to Bayern. A player who matched a
biography row in one season but not another would otherwise end up with two
identities and be split in half by the dashboard.

After merging, biographies are assigned one-to-one: strongest claim first,
never the same biography to two players. Two people genuinely share a display
name more often than you would expect — Understat ids 1245 and 7430 are both
"Emerson", Palmieri and Royal, and season-by-season matching had been handing
each of them the other's date of birth and contract. Rows that end up on the
wrong person are cleared and refilled, and marked `identity_repaired`.

If a player loses every claim, they are left with no biography rather than a
wrong one, and the run summary names them so you can separate them with an
alias.

### Links to the sources

**Transfermarkt** is stored, as `tm_transfermarkt_url`. It has to be: the URL
contains a name slug that cannot be rebuilt from the id alone
(`/bukayo-saka/profil/spieler/433177`).

**Understat is not stored, deliberately.** Its URL is just the base plus the
player id, which is already a column at 100% coverage:

```
https://understat.com/player/{id}
```

Storing it would duplicate fourteen thousand strings carrying no information
the file does not already hold. The dashboard builds it at read time, the same
way it computes age from `date_of_birth` rather than storing an age that would
be wrong tomorrow.

## Columns

Statistics, per league-season: `minutes`, `games`, `goals`, `assists`, `xG`,
`npxG`, `xA`, `shots`, `key_passes`, `xGChain`, `xGBuildup`, plus per-90
versions of each.

Biography, prefixed `tm_`: `date_of_birth`, `sub_position`, `contract_expires`,
`market_value_eur`, `citizenship`, `foot`, `height_cm`, `transfermarkt_url`.

Bookkeeping: `player_uid` (stable across clubs and seasons), `match_pass`,
`match_score`, `bio_season` (which season the biography came from, so a stale
contract is visible).

**Dates are stored raw, never as ages.** Anything measured against today is
wrong tomorrow. Age is computed when the dashboard reads the file.

---

## Running it locally

Not needed — the workflow does everything — but if you want to:

```bash
pip install -r requirements.txt

python scripts/pull_understat.py --season 2025 --leagues EPL --out understat.xlsx
python scripts/build_squads.py  --seasons 2025 --leagues GB1 --out squads.xlsx
python scripts/merge_master.py --understat understat.xlsx --squads squads.xlsx \
       --mode add_missing --dry-run
```

---

## Notes on the sources

`scripts/pull_understat.py` and `scripts/build_squads.py` are your own
collectors, included unchanged.

Ages and contracts come from
[dcaribou/transfermarkt-datasets](https://github.com/dcaribou/transfermarkt-datasets),
an open maintained extract, with missing birth dates filled from Wikidata.

Playing statistics come from Understat, whose `robots.txt` disallows automated
access. That is why this workflow is manual-dispatch only and has no schedule,
matching the note in your original workflow file. Check the terms yourself
before each run; that call is yours, not the pipeline's.
