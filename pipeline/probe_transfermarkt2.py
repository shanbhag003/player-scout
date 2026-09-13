"""Probe 2: what is actually answering us?

The first probe got HTTP 202, a 2 KB body, no cf-ray header and a 0.0s response
time. That is not Transfermarkt - nothing reached Germany, and 202 is not a
status a web page returns. Something in between is replying with a stub.

This one makes no judgements. It fetches a few things and prints the complete
response: every header, the full body, and the redirect chain. It also fetches a
control URL that has nothing to do with Transfermarkt, to establish whether the
runner's outbound network works at all.

    python pipeline/probe_transfermarkt2.py
"""

import sys
import time

import requests

HDR = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/124.0.0.0 Safari/537.36"),
    "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,"
               "image/avif,image/webp,*/*;q=0.8"),
    "Accept-Language": "en-GB,en;q=0.9",
}

TARGETS = [
    ("control: example.com",
     "https://example.com/"),
    ("control: github.com",
     "https://github.com/"),
    ("transfermarkt: home page",
     "https://www.transfermarkt.co.uk/"),
    ("transfermarkt: player profile",
     "https://www.transfermarkt.co.uk/virgil-van-dijk/profil/spieler/139208"),
    ("transfermarkt: .com domain",
     "https://www.transfermarkt.com/virgil-van-dijk/profil/spieler/139208"),
    ("transfermarkt: .de domain",
     "https://www.transfermarkt.de/virgil-van-dijk/profil/spieler/139208"),
]


def show(label, url, session):
    print("\n" + "=" * 74)
    print(label)
    print(url)
    print("=" * 74)
    t0 = time.time()
    try:
        r = session.get(url, headers=HDR, timeout=45, allow_redirects=True)
    except Exception as e:                                   # noqa: BLE001
        print(f"  EXCEPTION {type(e).__name__}: {e}")
        return
    dt = time.time() - t0

    print(f"  status        {r.status_code} {r.reason}")
    print(f"  elapsed       {dt:.2f}s")
    print(f"  bytes         {len(r.content):,}")
    print(f"  final url     {r.url}")
    if r.history:
        print(f"  redirects     {' -> '.join(str(h.status_code) for h in r.history)}")
    print("  response headers:")
    for k, v in r.headers.items():
        print(f"    {k}: {str(v)[:120]}")

    body = r.text
    print(f"  body ({len(body):,} chars):")
    if len(body) <= 3000:
        for line in body.splitlines():
            print(f"    {line[:160]}")
    else:
        for line in body[:1500].splitlines():
            print(f"    {line[:160]}")
        print(f"    ... [{len(body) - 3000:,} chars omitted] ...")
        for line in body[-1500:].splitlines():
            print(f"    {line[:160]}")


def main():
    s = requests.Session()
    for i, (label, url) in enumerate(TARGETS):
        if i:
            time.sleep(3)
        show(label, url, s)

    print("\n" + "=" * 74)
    print("HOW TO READ THIS")
    print("=" * 74)
    print("""
  Controls fail too
      The runner has no general outbound access, or an egress proxy is in
      front of everything. Nothing to do with Transfermarkt.

  Controls work, Transfermarkt returns 202 with a stub
      Something is intercepting requests to this host specifically. Read the
      response headers - a proxy or filter almost always names itself in one
      of them (via, server, x-cache, x-deny-reason, or similar).

  Transfermarkt returns a Cloudflare challenge
      Expect cf-ray and cf-mitigated headers and a body mentioning a browser
      check. That is a genuine bot block: the IP is the problem, and no
      header tuning fixes it from a datacentre.

  Transfermarkt returns real HTML
      The first probe was wrong somewhere. The body printed above is what we
      write the parser against.
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
