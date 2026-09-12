"""Write a short report of the last build into the workflow summary page."""
import json
import os

META = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "site", "data", "meta.json")

if not os.path.exists(META):
    print("No output produced — the run stopped before scoring.")
    raise SystemExit(0)

m = json.load(open(META))
print("| | |")
print("|---|---|")
print(f"| Players scored | {m['pool']:,} |")
print(f"| Still in the big five | {m['active_players']:,} |")
print(f"| Seasons | {m['seasons'][0]}–{m['seasons'][-1]} |")
print(f"| Leagues | {', '.join(m['leagues'])} |")
print(f"| League movers used | {m['league_movers']} |")
print(f"| Built | {m['built_at']} |")
print()
print("**Does a player find himself?** Median rank of a player's own second-half "
      "profile, given the first.")
print()
print("| Position | Players | Median rank | Chance |")
print("|---|---|---|---|")
for v in sorted(m.get("validation", []), key=lambda v: -v["players"]):
    if v["players"] > 100:
        print(f"| {v['position']} | {v['players']} | {v['median_rank']:.0f} "
              f"| {v['chance_median_rank']:.0f} |")
