"""Fetch match data from Cricsheet.

Two modes, because two jobs need different things.

  --window 7      the rolling "recently added" zip. Around ninety matches, a few
                  hundred kilobytes, mixed across every competition. This is what
                  the daily job pulls.
  --full          per-competition zips, for a rebuild. Hundreds of megabytes, so
                  it is resumable: a run that dies at competition thirty picks up
                  at thirty rather than at one.

Seven days rather than two for the daily window, deliberately. If a run fails on
a Tuesday, Wednesday heals it. Two days leaves no margin.

Note that Cricsheet also REVISES matches, and revisions come back through the
same window. Every match carries meta.revision, which the parser records, so the
store upserts on match id rather than appending. Appending would double-count a
corrected scorecard.

Data source: Cricsheet (https://cricsheet.org), Open Data Commons Attribution
Licence. Attribution is a licence condition. Be polite: this is one person's
project, hosted at their expense.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.error
import urllib.request

import yaml

BASE = "https://cricsheet.org/downloads"
UA = ("player-scout/1.0 (+https://shanbhag003.github.io/player-scout) "
      "cricket data via cricsheet.org")
CONFIG = os.path.join("config", "cricket", "competitions.yml")


def fetch(url: str, dest: str, retries: int = 3) -> bool:
    """Download one file. Returns False if Cricsheet does not have it."""
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as fh:
                while chunk := r.read(1 << 20):
                    fh.write(chunk)
            return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False                 # this combination simply does not exist
            if attempt == retries:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries:
                raise
        time.sleep(2 * attempt)
    return False


def window(days: int, out: str) -> str:
    os.makedirs(out, exist_ok=True)
    name = f"recently_added_{days}_json.zip"
    dest = os.path.join(out, name)
    if not fetch(f"{BASE}/{name}", dest):
        raise SystemExit(f"cricsheet has no {name}; valid windows are 2, 7 and 30")
    print(f"{name}  {os.path.getsize(dest) / 1e6:.1f} MB")
    return dest


def full(cfg: dict, out: str, only=None, force=False):
    """One zip per competition per gender.

    Most competitions publish as <key>_<gender>_json.zip. A few only exist in one
    gender and publish as <key>_json.zip, so both are tried before giving up.
    """
    os.makedirs(out, exist_ok=True)
    got, missing, skipped = [], [], []
    comps = [c for c in cfg["competitions"] if not only or c["key"] in only]
    for c in comps:
        for gender in c.get("genders", ["male"]):
            stem = f"{c['key']}_{gender}"
            dest = os.path.join(out, f"{stem}.zip")
            if os.path.exists(dest) and not force:
                skipped.append(stem)          # resumable: already have it
                continue
            ok = fetch(f"{BASE}/{c['key']}_{gender}_json.zip", dest)
            if not ok:
                ok = fetch(f"{BASE}/{c['key']}_json.zip", dest)
            if ok:
                got.append((stem, os.path.getsize(dest)))
                print(f"  {stem:22} {os.path.getsize(dest) / 1e6:7.1f} MB")
            else:
                if os.path.exists(dest):
                    os.remove(dest)
                missing.append(stem)
                print(f"  {stem:22} not published", file=sys.stderr)
            time.sleep(1)                     # one request a second, no more
    print(f"\nfetched {len(got)}, already had {len(skipped)}, not published {len(missing)}")
    if missing:
        print("not published (check the key in competitions.yml against "
              "cricsheet.org/downloads):")
        for m in missing:
            print(f"  {m}")
    return got


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--window", type=int, choices=[2, 7, 30],
                   help="rolling recently-added window, in days")
    g.add_argument("--full", action="store_true", help="every competition zip")
    ap.add_argument("--only", nargs="*", help="limit --full to these competition keys")
    ap.add_argument("--out", default="data/cricket/raw")
    ap.add_argument("--config", default=CONFIG)
    ap.add_argument("--force", action="store_true", help="re-fetch what is already there")
    args = ap.parse_args()

    with open(args.config) as fh:
        cfg = yaml.safe_load(fh)

    if args.window:
        window(args.window, args.out)
    else:
        full(cfg, args.out, args.only, args.force)


if __name__ == "__main__":
    main()
