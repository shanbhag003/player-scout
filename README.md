# Player Scout

Find the players who play the same way.

Live at **[shanbhag003.github.io/player-scout](https://shanbhag003.github.io/player-scout)**.

Player Scout is a statistical scouting tool. Search a player and it returns the
others whose profile most resembles theirs — not the same standard, the same
*shape*. Or start from a need instead of a name: describe the player you want and
it goes looking.

It covers two sports, football and men's T20 cricket, and runs entirely on
free-tier infrastructure — a static front end on GitHub Pages, a Python data
pipeline on GitHub Actions, and parquet data files stored as release assets. No
server, no database, no cost.

---

## What it does

**Similar players.** Every player is placed in a space built from their own
per-role metrics, compressed with principal component analysis. Similarity is the
distance between two players in that space, so "who is like this player" has a
concrete answer rather than a hand-picked one.

**Scouting.** The same pool, approached from the other end. Choose a discipline,
a role, an age bracket, an exposure level and a set of competitions, and the tool
returns everyone who fits — because a scout usually has a need, not a name.

**Comparison.** Line up to six players side by side: a radar of their shapes, a
season-by-season form line, and every metric with each player marked against
their role.

Both sports share one shell, one stylesheet and one design. Only the model
underneath differs.

---

## Cricket — how the numbers are built

Men's T20 only, for now. Test and one-day cricket are different games and belong
in separate models rather than a shared one.

**Source.** Every ball of every match Cricsheet publishes. Player identity comes
from Cricsheet's own register, so nothing depends on matching people by name.
Dates of birth and full names join from Wikidata on an exact ESPNcricinfo id,
with a hand-written override file for the handful Wikidata gets wrong.

**Metrics.** Sixteen rates per batter and eleven per bowler, split by phase of the
innings and by whether the bowler was pace or spin — both derived from the
deliveries themselves. A thin record is pulled toward the average for its role,
because a strike rate off eighty balls is mostly noise. Older cricket counts for
less, on a three-year half-life measured from each player's own last match.

**Levelling competitions.** One coefficient per metric per competition, fitted
only from players seen in more than one — the same person either side of a move.
It does almost nothing between competitions of similar standard and cuts
prediction error by a quarter to two-fifths across the widest gaps, which is the
case scouting cares about. Displayed numbers are always the raw, unadjusted
figures; the levelled version sits behind a toggle, and the percentile ranking is
computed on the levelled figures so an over in the IPL and an over in a domestic
competition can be compared.

**Validation.** Each player's matches are split in two and the halves treated as
strangers. A top-order batter finds his own second half around 45th of 235, where
guessing would put him 118th.

**Known limits.** Coverage is *what happened*, not *how* — line, length, pace off
the pitch and shot type are commercial data with no open equivalent, so two
players with identical outcomes can be different players. Cricsheet withholds all
matches involving Afghanistan; Afghan players therefore carry franchise cricket
only, flagged on their profile. The sample floors are reasoned rather than
formally tested.

---

## Repository layout

```
site/                     the front end — static HTML, CSS, JS, no framework
  index.html · app.js       football
  cricket.html · cricket.js cricket
  style.css                 shared stylesheet
  assets/flags/             flag SVGs

pipeline/
  build_channels.py         assembles the production and staging site
  cricket/
    pull_cricsheet.py       fetch match archives
    resolve_competition.py  route each match file to a competition
    parse_matches.py        JSON → per-match player facts
    build_master.py         facts → roles and bowler types
    build_bio.py            register + Wikidata → names, ages, nationality
    build_cricket_scores.py the model: metrics, shrinkage, PCA, JSON output
    store.py                read/write the parquet release assets

config/cricket/
  competitions.yml          every competition, its format, gender and tier
  event_aliases.csv         Cricsheet event names → competition keys
  bowler_seeds.csv          hand labels seeding the pace/spin classifier
  name_aliases.csv          full names Wikidata does not supply

.github/workflows/
  cricket-daily.yml         nightly: pull the rolling window, rebuild, publish
  cricket-rebuild.yml       manual: full re-parse of the whole archive
  deploy-site.yml           deploy the site on any push to site/
```

Data files are never committed. The facts live in a GitHub Release; the site is
deployed as a Pages artifact. A job running every night leaves the repository the
same size it was the day before.

---

## How it runs

Three workflows, no local setup:

- **Cricket daily** pulls Cricsheet's rolling seven-day window, folds it into the
  stored facts, rebuilds the model, and publishes the built data. Seven days
  rather than one, so a missed night heals itself.
- **Cricket rebuild** re-parses the entire archive from scratch. Run it when the
  model changes, when a competition is added, and monthly, since Cricsheet
  revises older scorecards.
- **Deploy site** rebuilds and deploys the front end on any push under `site/`,
  fetching the built cricket data from its release. Frontend changes go live in
  under a minute without touching the data pipeline.

Production and staging are the same code, one build flag apart. Staging carries a
banner and `noindex` and is where things are tried before promotion.

---

## Data and attribution

Match data is from **[Cricsheet](https://cricsheet.org)**, used under the
**Open Data Commons Attribution Licence (ODC-BY)**. Attribution is a licence
condition, not a courtesy — if you fork or reuse this, keep the credit.

Cricsheet withholds all matches involving Afghanistan, in protest at Afghan women
cricketers being ignored by the ICC and most full members. Afghan players'
records here are incomplete as a direct result.

Biographical data is from **[Wikidata](https://www.wikidata.org)**. Football data
is from the transfermarkt-datasets project and Understat. Flags are from
**[flag-icons](https://github.com/lipis/flag-icons)** (MIT).

---

## Licence

The data carries Cricsheet's ODC-BY licence as above. Add your own licence for
the code in this repository.
