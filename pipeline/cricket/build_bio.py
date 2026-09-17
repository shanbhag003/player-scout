"""Dates of birth, nationalities and full names.

Cricsheet carries none of these, so this is the one place the pipeline needs a
second source. It joins on an exact key rather than on names, which is why it is
trustworthy: the register gives every person a Cricinfo id, Wikidata stores the
same id as property P2697, and the two meet on a string with no fuzzy matching.

Two things learned from a real run:

  The query service has a sixty second limit, and one query covering every
  cricketer on Wikidata exceeds it. On timeout it returns a Java stack trace as
  plain text with a 200 status, which parses as a malformed CSV rather than as
  an error — so the failure looks like corrupt data. The query is therefore split
  into chunks, and every response is checked for being CSV at all before it is
  handed to the parser.

  This step must never fail the run. Losing an hour of archive parsing because
  someone else's endpoint was busy is not acceptable, and the model works without
  biography — you lose the age filter and full-name search, nothing more. So a
  failure here is loud, and then the pipeline carries on.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import pandas as pd

SPARQL = "https://query.wikidata.org/sparql"
UA = ("player-scout/1.0 (+https://shanbhag003.github.io/player-scout) "
      "python-urllib cricket biographical join")

# One chunk per leading character of the Cricinfo id. Each returns a few thousand
# rows and finishes well inside the timeout.
CHUNKS = list("0123456789")

QUERY = """
SELECT ?cricinfo ?personLabel ?dob ?countryLabel WHERE {
  ?person wdt:P2697 ?cricinfo .
  FILTER(STRSTARTS(?cricinfo, "%s"))
  OPTIONAL { ?person wdt:P569 ?dob }
  OPTIONAL { ?person wdt:P27 ?country }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
"""

FIELDS = ["cricinfo", "personLabel", "dob", "countryLabel"]


def _parse(body: str) -> pd.DataFrame:
    """Read whichever result format came back.

    Asking for CSV is not reliable: the service ignored `format=csv` on a real
    run and returned SPARQL Results XML with a 200. So rather than depend on
    content negotiation, take JSON when offered, XML when not, and only complain
    when it is neither.
    """
    text = body.lstrip()
    if text.startswith("{"):
        data = json.loads(text)
        rows = []
        for b in data.get("results", {}).get("bindings", []):
            rows.append({f: b.get(f, {}).get("value") for f in FIELDS})
        return pd.DataFrame(rows, columns=FIELDS)
    if text.startswith("<"):
        ns = {"s": "http://www.w3.org/2005/sparql-results#"}
        root = ET.fromstring(text)
        rows = []
        for result in root.findall(".//s:result", ns):
            row = {}
            for binding in result.findall("s:binding", ns):
                value = binding.find("s:literal", ns)
                if value is None:
                    value = binding.find("s:uri", ns)
                row[binding.get("name")] = value.text if value is not None else None
            rows.append({f: row.get(f) for f in FIELDS})
        return pd.DataFrame(rows, columns=FIELDS)
    if text.lower().startswith("cricinfo"):
        return pd.read_csv(io.StringIO(body))
    first = " / ".join(body.strip().splitlines()[:3])[:300]
    raise RuntimeError(f"unrecognised response — endpoint said: {first}")


def _get(query: str, timeout: int = 180) -> pd.DataFrame:
    url = f"{SPARQL}?{urllib.parse.urlencode({'query': query, 'format': 'json'})}"
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return _parse(r.read().decode("utf-8", "replace"))


def fetch_wikidata(retries: int = 3) -> pd.DataFrame:
    frames = []
    for chunk in CHUNKS:
        for attempt in range(1, retries + 1):
            try:
                df = _get(QUERY % chunk)
                frames.append(df)
                print(f"  ids starting {chunk}: {len(df):,} rows")
                break
            except (urllib.error.URLError, RuntimeError, TimeoutError,
                    pd.errors.ParserError) as e:
                if attempt == retries:
                    print(f"  ids starting {chunk}: giving up ({e})", file=sys.stderr)
                else:
                    time.sleep(5 * attempt)
        time.sleep(1)                       # be a good citizen
    if not frames:
        raise RuntimeError("every Wikidata chunk failed")
    return pd.concat(frames, ignore_index=True)


def build(register_path: str, wikidata) -> pd.DataFrame:
    reg = pd.read_csv(register_path, low_memory=False)
    reg["key_cricinfo"] = pd.to_numeric(reg["key_cricinfo"], errors="coerce")

    out = pd.DataFrame({
        "player_id": reg["identifier"],
        "short_name": reg["name"],
        "unique_name": reg["unique_name"],
        "cricinfo": reg["key_cricinfo"],
    })
    out["full_name"] = None
    out["nationality"] = None
    out["dob"] = pd.NaT

    if wikidata is None or len(wikidata) == 0:
        return out

    w = wikidata.copy()
    w["cricinfo"] = pd.to_numeric(w["cricinfo"], errors="coerce")
    w = w.dropna(subset=["cricinfo"])
    # A Cricinfo id appearing twice means two Wikidata items claim the same
    # player. Prefer the one carrying a date of birth rather than choose blindly.
    w = (w.sort_values("dob", na_position="last")
           .drop_duplicates("cricinfo").set_index("cricinfo"))

    out["full_name"] = out["cricinfo"].map(w["personLabel"])
    if "countryLabel" in w:
        out["nationality"] = out["cricinfo"].map(w["countryLabel"])
    out["dob"] = pd.to_datetime(out["cricinfo"].map(w["dob"]),
                                errors="coerce", utc=True).dt.tz_localize(None)
    # A label that is only a Q-number means the item has no English label. That
    # is not a name and must not be shown as one.
    out.loc[out["full_name"].astype(str).str.match(r"^Q\d+$", na=False), "full_name"] = None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--register", default="data/cricket/raw/people.csv")
    ap.add_argument("--wikidata-csv", help="a saved export, used instead of querying")
    ap.add_argument("--fallback-csv", help="used only if the live query fails")
    ap.add_argument("--out", default="data/cricket/bio.parquet")
    args = ap.parse_args()

    if not os.path.exists(args.register):
        print(f"no register at {args.register}; skipping biography", file=sys.stderr)
        return 0

    wd = None
    if args.wikidata_csv and os.path.exists(args.wikidata_csv):
        wd = pd.read_csv(args.wikidata_csv, low_memory=False)
        print(f"using saved Wikidata export: {len(wd):,} rows")
    else:
        print("querying Wikidata in chunks:")
        try:
            wd = fetch_wikidata()
        except Exception as e:
            print(f"\nWIKIDATA FAILED: {e}", file=sys.stderr)
            if args.fallback_csv and os.path.exists(args.fallback_csv):
                wd = pd.read_csv(args.fallback_csv, low_memory=False)
                print(f"falling back to {args.fallback_csv}: {len(wd):,} rows")
            else:
                # Deliberately not fatal. Ages and full names are an enhancement;
                # the model does not depend on them.
                print("continuing without ages, nationalities or full names.",
                      file=sys.stderr)

    bio = build(args.register, wd)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    bio.to_parquet(args.out, index=False)

    print(f"\nregister        {len(bio):,} people")
    print(f"  cricinfo key  {bio['cricinfo'].notna().mean():.1%}")
    print(f"  full name     {bio['full_name'].notna().mean():.1%}")
    print(f"  date of birth {bio['dob'].notna().mean():.1%}")
    print(f"  nationality   {bio['nationality'].notna().mean():.1%}")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
