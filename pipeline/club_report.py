"""Write the newest club refresh into the workflow summary."""
import glob
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
files = sorted(glob.glob(os.path.join(HERE, "data", "reports", "clubs-*.json")))
if not files:
    print("No refresh report was produced.")
    raise SystemExit(0)

r = json.load(open(files[-1]))
print("| | |")
print("|---|---|")
if r.get("upstream_snapshot"):
    print(f"| Upstream snapshot | {r['upstream_snapshot']} |")
print(f"| Players in the master | {r['identified_players']:,} |")
print(f"| Found upstream | {r['matched_upstream']:,} |")
for field, n in (r.get("fields") or {}).items():
    print(f"| {field.replace('tm_', '').replace('_', ' ')} changed | {n:,} rows |")

moves = r.get("club_moves") or []
if moves:
    print(f"\n**{len(moves)} club moves picked up** (first few):\n")
    print("| Player | Was | Now |")
    print("|---|---|---|")
    for m in moves[:12]:
        print(f"| {m['player']} | {m['was']} | {m['now']} |")
else:
    fields = r.get("fields") or {}
    if fields and not any(fields.values()):
        print("\n**Nothing changed at all** — not one club, contract or market value "
              "across every player. Market values move constantly, so this means the "
              "source archive has not been rebuilt since the master was assembled.")
        print("\nThe source is a periodic scrape of Transfermarkt, not a live feed, so "
              "it lags the website. A move visible there will appear here once the "
              "archive is next published.")
        if r.get("archive_last_modified"):
            print(f"\nArchive last modified: `{r['archive_last_modified']}`")
    else:
        print("\nNo club changed since the last refresh.")
