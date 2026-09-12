"""Write the newest merge report into the workflow summary page.

Saves opening a JSON file to find out whether a run did what you wanted.
"""
import glob
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

reports = sorted(glob.glob(os.path.join(HERE, "data", "reports", "merge-*.json")))
if not reports:
    print("No merge report was produced. The run probably stopped earlier.")
    raise SystemExit(0)

r = json.load(open(reports[-1]))
print(f"**Mode:** {r.get('mode')}  ")
print(f"**League-seasons pulled:** {', '.join(r.get('league_seasons', [])) or 'none'}  ")
print()
print("| | |")
print("|---|---|")
print(f"| Matched overall | {r.get('match_rate', 0):.1%} |")
print(f"| Matched, 900+ minutes | {r.get('match_rate_900min', 0):.1%} |")
print(f"| Rows in master | {r.get('master_rows', 0):,} |")
print(f"| Players in master | {r.get('master_players', 0):,} |")
print(f"| League-seasons in master | {len(r.get('master_league_seasons', []))} |")
print(f"| Date of birth coverage | {r.get('date_of_birth_coverage', 0):.1%} |")
print(f"| Contract coverage | {r.get('contract_coverage', 0):.1%} |")

skipped = r.get("skipped_already_present")
if skipped:
    print(f"\n**Skipped, already in the master:** {', '.join(skipped)}")

miss = r.get("unmatched_over_900_minutes", [])
if miss:
    print(f"\n**{len(miss)} regular players did not match.** "
          "Add any that are genuine name differences to `config/aliases.csv`.\n")
    print("| Player | Club | League | Season | Minutes |")
    print("|---|---|---|---|---|")
    for m in miss[:25]:
        print(f"| {m['player']} | {m['team']} | {m['league']} | {m['season']} | {m['minutes']:.0f} |")
