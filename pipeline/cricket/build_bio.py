"""Dates of birth, nationalities and full names.

Cricsheet carries none of these, so this is the one place the pipeline needs a
second source. It joins on an exact key rather than on names, which is the whole
reason it is trustworthy: the register gives every person a Cricinfo id, Wikidata
stores the same id as property P2697, and the two meet on a string with no fuzzy
matching anywhere. Football needed six passes to bridge two sources with no
shared key; here the key is published.

Match files only ever carry short names — "V Kohli", "SA Yadav" — so Wikidata's
label is also the only route to a full name, which the search box needs whatever
happens with ages.

Coverage is not uniform and the site should say so. It tracks the country a
player plays in rather than the level they play at: English and Indian domestic
cricketers are covered about as well as internationals, while minor-nation
internationals are barely covered at all.
"""
from __future__ import annotations

import argparse
import io
import os
import urllib.parse
import urllib.request

import pandas as pd

SPARQL = "https://query.wikidata.org/sparql"
QUERY = """
SELECT ?cricinfo ?personLabel ?dob ?countryLabel WHERE {
  ?person wdt:P2697 ?cricinfo .
  OPTIONAL { ?person wdt:P569 ?dob }
  OPTIONAL { ?person wdt:P27 ?country }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
"""
UA = ("player-scout/1.0 (+https://shanbhag003.github.io/player-scout) "
      "cricket biographical join")


def fetch_wikidata() -> pd.DataFrame:
    url = f"{SPARQL}?{urllib.parse.urlencode({'query': QUERY, 'format': 'csv'})}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/csv"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return pd.read_csv(io.BytesIO(r.read()))


def build(register_path: str, wikidata: pd.DataFrame) -> pd.DataFrame:
    reg = pd.read_csv(register_path, low_memory=False)
    reg["key_cricinfo"] = pd.to_numeric(reg["key_cricinfo"], errors="coerce")

    w = wikidata.copy()
    w["cricinfo"] = pd.to_numeric(w["cricinfo"], errors="coerce")
    w = w.dropna(subset=["cricinfo"])
    # A Cricinfo id appearing twice means two Wikidata items claim the same
    # player. Prefer the one that actually carries a date of birth, then drop the
    # rest rather than pick arbitrarily.
    w = (w.sort_values("dob", na_position="last")
           .drop_duplicates("cricinfo").set_index("cricinfo"))

    out = pd.DataFrame({
        "player_id": reg["identifier"],
        "short_name": reg["name"],
        "unique_name": reg["unique_name"],
        "cricinfo": reg["key_cricinfo"],
    })
    out["full_name"] = out["cricinfo"].map(w["personLabel"])
    out["nationality"] = out["cricinfo"].map(w["countryLabel"])
    dob = out["cricinfo"].map(w["dob"])
    out["dob"] = pd.to_datetime(dob, errors="coerce", utc=True).dt.tz_localize(None)
    # A Wikidata label that is just the Q-number means the item has no English
    # label; that is not a name and should not be shown as one.
    out.loc[out["full_name"].astype(str).str.match(r"^Q\d+$", na=False), "full_name"] = None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--register", default="data/cricket/raw/people.csv")
    ap.add_argument("--wikidata-csv", help="a saved query result; omit to query Wikidata")
    ap.add_argument("--out", default="data/cricket/bio.parquet")
    args = ap.parse_args()

    wd = pd.read_csv(args.wikidata_csv, low_memory=False) if args.wikidata_csv else fetch_wikidata()
    bio = build(args.register, wd)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    bio.to_parquet(args.out, index=False)

    print(f"register       {len(bio):,} people")
    print(f"  cricinfo key {bio['cricinfo'].notna().mean():.1%}")
    print(f"  full name    {bio['full_name'].notna().mean():.1%}")
    print(f"  date of birth{bio['dob'].notna().mean():.1%}")
    print(f"  nationality  {bio['nationality'].notna().mean():.1%}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
