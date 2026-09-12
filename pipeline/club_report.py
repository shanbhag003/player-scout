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
    print("\nNo club changed since the last refresh.")
