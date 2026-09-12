# Player Scout

Search a footballer and see who else plays like them.

Every player with 1,800+ minutes across Europe's big five leagues since 2021/22 —
2,779 in all — reduced to a set of per-90 metrics, adjusted for the league they
were produced in, standardised against others in the same position, compressed
with principal component analysis, and ranked by distance in that space.

**Setup: [DEPLOY.md](DEPLOY.md).**

## How it fits together

```
  Understat  ──┐
               ├── pipeline/merge_master.py ──► data/master_players.csv
  Transfermarkt┘        matches on name, club and minutes
                                    │
                                    ▼
                        pipeline/build_scores.py
              aggregate · league-adjust · percentile · PCA · validate
                                    │
                                    ▼
                  site/data/*.json ──► GitHub Pages
```

Three workflows: **Update data** runs the whole chain when a season ends,
**Rebuild scores** reruns only the model, **Deploy site** publishes. Raw match
data is downloaded, used and discarded — only the finished files are committed.

## The method

- **One profile per player, not per season.** Rates come from summed totals over
  summed minutes, so a 3,000-minute season outweighs a 200-minute one. Seasons
  under 270 minutes are excluded from per-90 charts — a two-minute cameo divides
  out to nonsense.
- **League adjustment.** Coefficients are fitted from the 624 players observed in
  more than one league, comparing each with themselves before and after a move.
  Comparing whole leagues would only measure which has the better players.
- **Position first.** Each position is fitted separately; what separates wingers
  is not what separates centre-backs. Widening a search uses a second PCA fitted
  across the position group, because coordinates from different fits are not
  comparable.
- **Identity is resolved once, globally.** The statistics source's player id is
  the identity, since it is present on every row and survives club and league
  changes. Biographies are then assigned one-to-one, strongest claim first, so
  two players who share a name cannot end up sharing a date of birth.
- **Style and availability are separate questions.** Results default to players
  still in the big five; anyone who has left carries the season they left, and a
  current club that differs from the one in the data is labelled as such.

## Does it work?

Each player's seasons are split in two, a profile built from each, and we check
where a player's own second-half profile ranks among all candidates given the
first. A model fitting noise would not find him.

| Position | Players | Median rank | Chance |
| --- | --- | --- | --- |
| Attacking Midfield | 161 | 19 | 81 |
| Right Winger | 153 | 27 | 77 |
| Right-Back | 206 | 30 | 104 |
| Centre-Back | 464 | 85 | 232 |
| Goalkeeper | 160 | 62 | 80 |

Real signal, well short of certainty. The goalkeeper row is why goalkeepers are
not ranked at all: at 62 against a chance of 80, a list would be close to random.
They still get percentiles for build-up involvement, with a note that the metric
reflects a team's possession as much as the keeper.

## What it cannot see

The source publishes shooting, chance creation and possession involvement. There
are no tackles, interceptions, duels, clearances or goalkeeping actions. Defenders
are therefore compared on what they offer going forward, and the results header
says so rather than implying otherwise.

That limitation is a licensing one, not a design choice. FBref lost its Opta feed
in January 2026, which ended the only free source of progression metrics.

## Layout

```
config/
  leagues.yml        which leagues exist and where each source's data comes from
  aliases.csv        name equivalences the matcher cannot infer
pipeline/
  pull_understat.py  playing statistics
  build_squads.py    ages, contracts, market values, positional labels
  resolve_leagues.py league keys to each source's codes
  merge_master.py    matching and incremental merge — six passes
  build_scores.py    the model
  merge_report.py    run summaries
  score_report.py
data/
  master_players.csv one row per player per season
  reports/           one JSON per update
site/
  index.html · app.js · style.css · assets · data
```

## Running it locally

Not required — the workflows do this — but if you want to:

```bash
pip install -r requirements.txt
python pipeline/build_scores.py
cd site && python -m http.server 8000
```

## Data

Playing statistics from [Understat](https://understat.com); ages, contracts,
market values and positional labels from
[transfermarkt-datasets](https://github.com/dcaribou/transfermarkt-datasets),
with missing birth dates filled from Wikidata. Please respect those sources'
terms.
