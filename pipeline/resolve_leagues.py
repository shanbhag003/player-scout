"""Turn the league keys chosen in the workflow into each source's codes.

The workflow speaks in keys like EPL and LALIGA. Understat wants 'La_liga',
Transfermarkt wants 'ES1', and the master file wants 'La Liga'. This is the one
place that knows the difference, so adding a league is a change to
config/leagues.yml and nothing else.

Fails early and loudly on a league with no statistics source, rather than
letting the run finish and produce rows with no numbers in them.
"""
import argparse
import os
import sys

import yaml

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--leagues", nargs="+", required=True)
    ap.add_argument("--seasons", nargs="+", required=True)
    ap.add_argument("--config", default=os.path.join(HERE, "config", "leagues.yml"))
    args = ap.parse_args()

    with open(args.config) as f:
        config = yaml.safe_load(f)
    registry = {l["key"].upper(): l for l in config["leagues"]}

    unknown = [k for k in (x.upper() for x in args.leagues) if k not in registry]
    if unknown:
        print(f"Unknown league(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"Available: {', '.join(sorted(registry))}", file=sys.stderr)
        return 1

    chosen = [registry[k.upper()] for k in args.leagues]
    no_stats = [l["name"] for l in chosen if l["stats"]["source"] == "none"]
    if no_stats:
        print(f"No statistics source for: {', '.join(no_stats)}", file=sys.stderr)
        print("These leagues have ages and contracts available but no playing "
              "statistics, so there would be nothing to compare players on.\n"
              "Add a statistics source in config/leagues.yml first.", file=sys.stderr)
        return 1

    understat = [l["stats"]["code"] for l in chosen]
    transfermarkt = [l["bio"]["code"] for l in chosen if l["bio"]["source"] == "transfermarkt"]
    labels = [f"{int(s)}/{str(int(s) + 1)[-2:]}" for s in args.seasons]

    print(f"understat_codes={' '.join(understat)}")
    print(f"transfermarkt_codes={' '.join(transfermarkt)}")
    print(f"season_labels={' '.join(labels)}")
    print(f"league_names={', '.join(l['name'] for l in chosen)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
