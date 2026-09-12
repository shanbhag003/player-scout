# Deploying Player Scout

One repository, free to run, all of it in a browser. Nothing to install, no
command line, no local Python.

**About twelve minutes of clicking.** The data and the scores are already in the
zip, so the site works the moment it deploys.

---

## What you are setting up

| Piece | Job | Cost |
| --- | --- | --- |
| GitHub repository | holds the code, the master data and the scored output | free |
| GitHub Actions | collects data, matches it, scores every player | free on public repos |
| GitHub Pages | serves the site | free |

Raw match data is never stored here. The collectors download it, use it, and
throw it away; only the finished files are kept.

---

## Step 1 — Create the repository

1. Sign in at [github.com](https://github.com).
2. Click **+** at the top right, then **New repository**.
3. Name it `player-scout`.
4. Choose **Public** — Actions minutes and Pages are only free on public repos.
5. Don't tick "Add a README file"; the zip has one.
6. **Create repository**.

## Step 2 — Upload the files

1. Unzip `player-scout.zip`.
2. On the empty repository page, click **uploading an existing file**.
3. Select everything *inside* the unzipped folder — not the folder itself — and
   drag it in.
4. Wait for the list to settle (the master file is 7 MB), then **Commit changes**.

**If `.github` is missing from the list**, your computer is hiding folders whose
name starts with a dot. Mac: **Cmd + Shift + .** in Finder. Windows: **View →
Show → Hidden items**. Then upload it, or create the three workflow files by
hand with **Add file → Create new file**, typing the full path
`.github/workflows/update-data.yml` as the name.

## Step 3 — Let the workflows save their results

1. **Settings → Actions → General**
2. Scroll to **Workflow permissions**
3. Choose **Read and write permissions** → **Save**

Miss this and every run succeeds right up to the final commit, then fails.

## Step 4 — Turn on Pages

1. **Settings → Pages**
2. Under **Build and deployment**, set **Source** to **GitHub Actions**

Nothing to save; it applies at once.

## Step 5 — Deploy

**Actions → Deploy site → Run workflow.**

That's it — the scored data is already in the repository, so there is nothing to
build. A minute or two later, **Settings → Pages** shows your address:

`https://YOUR-USERNAME.github.io/player-scout/`

---

## The three workflows

| Workflow | When you run it |
| --- | --- |
| **Update data** | a season has finished, or you want to add a league |
| **Rebuild scores** | the data is fine but you changed the model |
| **Deploy site** | runs itself whenever anything under `site/` changes |

### Update data

**Actions → Update data → Run workflow**, four boxes:

- **leagues** — keys from `config/leagues.yml`, space separated
- **seasons** — starting years. `2026` means 2026/27
- **mode** — `add_missing` inserts only what the master lacks (the safe default),
  `refresh` replaces those league-seasons, `rebuild` starts over
- **dry_run** — tick to see what would change without saving it

One run does everything: pulls playing statistics, pulls ages and contracts,
matches the two, rescores every player, commits. Fifteen to forty minutes. The
site redeploys itself afterwards.

The run summary reports the match rate, what changed in the master, and the new
scores.

### Rebuild scores

Use this after editing `pipeline/build_scores.py` — a different metric set, a new
minutes threshold, a change to how positions group. It reads the master already
in the repository, so nothing is downloaded. Two to three minutes.

---

## When a player does not match

The update summary lists every unmatched player with 900+ minutes. If one is the
same person under a different name — the two sources disagree more often than you
would expect — fix it permanently:

1. **Code → config → aliases.csv**, click the pencil
2. Add a line, Understat's spelling first:

   ```
   Franck Zambo,Frank Anguissa
   ```

3. **Commit changes**, then rerun **Update data** with mode `refresh`

Only add a line when you are certain. The alias file overrides all matching, so a
wrong entry silently gives one player another's contract and market value.

---

## Adding a league

Open `config/leagues.yml` and add a block. Each league needs two sources — one
for playing statistics, one for ages and contracts.

**Several are listed already and will be refused on purpose**, because Understat
publishes the big five and nothing else:

```
No statistics source for: Eredivisie
These leagues have ages and contracts available but no playing statistics,
so there would be nothing to compare players on.
```

Transfermarkt covers most of Europe, so without that guard you would end up with
hundreds of Dutch players carrying a birthday, a contract and no xG — quietly
corrupting every comparison. Adding one properly means finding a statistics
source that covers it and writing a puller. Once it exists, set `stats.source`
and everything downstream works unchanged.

---

## Changing how the model works

Near the top of `pipeline/build_scores.py`:

| To change | Edit |
| --- | --- |
| Minutes needed to qualify | `MIN_MINUTES` |
| Which metrics drive similarity | `SIMILARITY_METRICS` |
| Which eight appear on the radar | `RADAR_METRICS` |
| How positions group when a search widens | `POSITION_GROUP` |
| The wording shown for defenders and keepers | `POSITION_FRAMING` |
| How much variation PCA keeps | the `0.80` in `score_position` |

Then run **Rebuild scores**.

For appearance, edit `site/style.css` — every colour is in the first twenty
lines. Changes under `site/` deploy in a couple of minutes with no rebuild.

---

## Optional artwork

None of these are needed; everything falls back to a clean lettered badge.

| File | Replaces |
| --- | --- |
| `site/assets/understat.svg` | the **US** monogram |
| `site/assets/transfermarkt.svg` | the **TM** monogram |
| `site/assets/leagues/premier-league.svg` and four more | the two-letter league badges |
| `site/assets/flags/<code>.svg` | any flag not already bundled |

League slugs are in `site/assets/leagues.json`, flag codes in
`site/assets/countries.json`. League badges are greyscaled by CSS, so supply the
full-colour originals.

**None of these marks are bundled** — Understat's, Transfermarkt's and the five
leagues' logos are trademarked, so sourcing them is your call. For flags, 55 are
generated and cover 93.8% of players; [flag-icons](https://github.com/lipis/flag-icons)
is MIT-licensed and uses the same codes if you want the rest.

---

## Sharing a view

The address bar tracks what you are looking at, so any view is linkable:

```
...github.io/player-scout/?p=us7322&tab=compare&with=us8015,us11094
```

That lands on Saka with two players already in the comparison — useful for
sending someone straight to a result rather than a search box.

---

## If something goes wrong

**"Permission denied" or 403 on the commit step**
Step 3 was missed. Set workflow permissions to read and write, then rerun.

**"No statistics source for: …"**
Working as intended. See "Adding a league".

**"No biography data for: Premier League 2026/27"**
You pulled a season Transfermarkt has not published yet. Wait, or tick
**allow_missing_bio** to accept statistics with no ages or contracts.

**The pull step fails or returns nothing**
Understat was unreachable or refused the request. Nothing is written unless the
whole run succeeds, so the master is untouched. Try later.

**Pages returns 404**
The first deployment takes a few minutes. If it persists, confirm Step 4 —
Source must be **GitHub Actions**, not a branch.

**A position shows no results**
Goalkeepers are deliberately not ranked. Elsewhere, widen the scope or loosen the
filters.

**I want to undo a run**
Every run is a commit. **Code → the clock icon → find the commit before the bad
one → revert.**

---

## What is committed, and what is not

Kept in the repository:

- `data/master_players.csv` — one row per player per season, statistics and
  biography joined
- `data/reports/` — one JSON per update, recording exactly what changed
- `site/data/` — the three files the site reads

Kept for 14 days as run artifacts, then discarded: `understat.xlsx` and
`squads.xlsx`. They are large, they change constantly, and they can always be
pulled again.

---

## One thing to keep in mind

There is no schedule on **Update data**, deliberately. Completed seasons do not
change, and the statistics source's `robots.txt` disallows automated access — a
daily job would be repeatedly requesting a site that asks you not to, in order to
change nothing. Run it when a season ends.

Whether to run it at all is your call to make against those terms, each time.
