"""Probe: will Transfermarkt serve a GitHub Actions runner, and can we parse it?

Answers four questions and changes nothing. Do not build the scraper until all
four come back green.

  1. Does Transfermarkt answer at all from this IP?  It sits behind Cloudflare,
     and Cloudflare has a long history of blocking datacentre ranges. Actions
     runners are Azure IPs.
  2. Can we read a player profile?  We hold 5,520 exact profile URLs, so this is
     the one page we know we can address.
  3. Can we get from a player to their club's squad page?  There are no club IDs
     anywhere in the project, so the squad-page plan depends on discovering them
     from profiles.
  4. What does the markup actually look like?  Nothing here was written against
     the real HTML, so the probe dumps enough structure to write a parser from.

Usage:
    python pipeline/probe_transfermarkt.py
    python pipeline/probe_transfermarkt.py --n 5
"""

import argparse
import os
import re
import sys
import time
from html import unescape

import pandas as pd
import requests

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(HERE, "data", "master_players.csv")

# A real browser header set. Cloudflare fingerprints more than the user agent,
# so a bare requests default would fail for reasons that tell us nothing about
# whether the IP itself is acceptable.
HDR = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/124.0.0.0 Safari/537.36"),
    "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,"
               "image/avif,image/webp,*/*;q=0.8"),
    "Accept-Language": "en-GB,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

DELAY = 4          # deliberately unhurried. This is a probe, not a job.

# What a profile page should contain if we got real content back.
PROFILE_MARKERS = ["Date of birth", "Contract expires", "Market value",
                   "Current club", "Joined", "Citizenship"]


def looks_blocked(r):
    """Distinguish 'Cloudflare stopped us' from 'the page is just different'."""
    body = r.text[:4000].lower()
    signs = []
    if r.status_code in (403, 429, 503):
        signs.append(f"status {r.status_code}")
    for phrase in ("just a moment", "checking your browser", "cf-challenge",
                   "attention required", "enable javascript and cookies",
                   "cf_chl_opt"):
        if phrase in body:
            signs.append(f"body contains {phrase!r}")
    if r.headers.get("cf-mitigated"):
        signs.append(f"cf-mitigated: {r.headers['cf-mitigated']}")
    return signs


def title_of(html):
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    return unescape(m.group(1)).strip()[:90] if m else "(no title)"


def find_club_links(html):
    """Club links look like /slug/startseite/verein/31. Return (id, slug) pairs."""
    hits = re.findall(r'href="/([^"/]+)/(?:startseite|kader)/verein/(\d+)', html)
    seen, out = set(), []
    for slug, cid in hits:
        if cid not in seen:
            seen.add(cid)
            out.append((cid, slug))
    return out


def context_around(html, needle, width=220):
    """The markup surrounding a label, so we can see how the value is held."""
    i = html.find(needle)
    if i < 0:
        return None
    chunk = html[max(0, i - 60):i + width]
    return re.sub(r"\s+", " ", chunk)


def get(session, url, label):
    print(f"\n  {label}")
    print(f"    {url}")
    t0 = time.time()
    try:
        r = session.get(url, headers=HDR, timeout=45)
    except Exception as e:                                    # noqa: BLE001
        print(f"    FAILED: {type(e).__name__}: {e}")
        return None
    dt = time.time() - t0
    print(f"    HTTP {r.status_code}  {len(r.content)/1024:.0f} KB  {dt:.1f}s"
          f"  cf-ray={r.headers.get('cf-ray', '-')}")
    blocked = looks_blocked(r)
    if blocked:
        print(f"    BLOCKED: {'; '.join(blocked)}")
        return None
    print(f"    title: {title_of(r.text)}")
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", default=MASTER)
    ap.add_argument("--n", type=int, default=3,
                    help="how many player profiles to try")
    args = ap.parse_args()

    master = pd.read_csv(args.master, low_memory=False)
    urls = (master[["tm_player", "tm_player_id", "tm_transfermarkt_url"]]
            .dropna().drop_duplicates("tm_player_id").head(args.n))
    print("Transfermarkt probe")
    print(f"{DELAY}s between requests, {len(urls)} profiles from the master\n")
    print("=" * 74)

    session = requests.Session()
    ok_profile = ok_squad = False
    club_id = club_slug = None
    first_html = None

    # ---- 1. player profiles, straight from URLs we already hold
    for i, (_, row) in enumerate(urls.iterrows()):
        if i:
            time.sleep(DELAY)
        r = get(session, row.tm_transfermarkt_url, f"profile: {row.tm_player}")
        if r is None:
            continue
        ok_profile = True
        if first_html is None:
            first_html = r.text
        found = [m for m in PROFILE_MARKERS if m.lower() in r.text.lower()]
        print(f"    markers present: {len(found)}/{len(PROFILE_MARKERS)}"
              f"  {', '.join(found) or 'none'}")
        links = find_club_links(r.text)
        if links and club_id is None:
            club_id, club_slug = links[0]
            print(f"    club link found: id={club_id} slug={club_slug}")

    if not ok_profile:
        print("\n" + "=" * 74)
        print("VERDICT: Transfermarkt did not serve a single profile.")
        print("  Everything below depends on this, so stop here.")
        print("  403/503 or a challenge page means the runner's IP is blocked.")
        print("  There is no fix from inside Actions - it needs a residential IP.")
        return 1

    # ---- 2. squad page, using an id discovered above
    if club_id:
        time.sleep(DELAY)
        url = (f"https://www.transfermarkt.co.uk/{club_slug}/kader/verein/"
               f"{club_id}/plus/1")
        r = get(session, url, f"squad page: {club_slug}")
        if r is not None:
            rows = len(re.findall(r'<tr class="(?:odd|even)"', r.text))
            tables = re.findall(r'<table class="([^"]*)"', r.text)[:6]
            print(f"    squad rows (tr.odd/tr.even): {rows}")
            print(f"    table classes seen: {tables}")
            for label in ("Contract", "Market value", "Date of birth"):
                print(f"    column label {label!r}: "
                      f"{'present' if label.lower() in r.text.lower() else 'MISSING'}")
            ok_squad = rows > 5
    else:
        print("\n  no club link found on any profile - squad-page route unproven")

    # ---- 3. structure dump, so a parser can be written from real markup
    if first_html:
        print("\n" + "=" * 74)
        print("MARKUP AROUND THE FIELDS WE NEED (from the first profile)")
        print("=" * 74)
        for label in ("Contract expires", "Market value", "Current club",
                      "Date of birth"):
            ctx = context_around(first_html, label)
            print(f"\n  {label}:")
            print(f"    {ctx[:400] if ctx else '(label not found in the HTML)'}")

    # ---- verdict
    print("\n" + "=" * 74)
    if ok_profile and ok_squad:
        print("VERDICT: both routes work. Build squad-page-first with a "
              "profile tail.")
    elif ok_profile:
        print("VERDICT: profiles work, squad pages did not.")
        print("  Profiles alone means 5,520 requests per refresh - roughly six")
        print("  hours at a polite rate, which does not fit the workflow.")
        print("  Worth re-running to see whether the squad page was a one-off.")
    print("=" * 74)
    return 0 if ok_profile else 1


if __name__ == "__main__":
    sys.exit(main())
