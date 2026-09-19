"""Assemble the Pages artifact as two channels.

Production is served at the site root, staging under /staging/. One repository,
one deploy, and — the part that matters — the SAME code in both. Staging differs
from production by a build flag, never by a branch. If staging ran different code
you would be testing something you are not going to ship, and merging would
become the risky step rather than the safe one.

What the channel decides:
  - which sports are live (cricket is `soon` in production until promoted)
  - whether cricket's data files are copied in at all
  - noindex, so a half-finished page is not indexed and shown to strangers
  - whether analytics fire, so your own testing does not pollute the metrics
  - the cache-busting stamp, so staging cannot be served production's stylesheet

Production is built first and must succeed. Staging is allowed to fail: a broken
cricket build should leave staging stale, never take football down.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(HERE, "site")
OUT = os.path.join(HERE, "_site")

CHANNELS = {
    "production": {
        "sports": [{"id": "football", "name": "Football", "status": "live"},
                   {"id": "cricket", "name": "Cricket", "status": "soon"},
                   {"id": "kabaddi", "name": "Kabaddi", "status": "soon"}],
        "analytics": True, "noindex": False, "banner": None, "subdir": "",
    },
    "staging": {
        "sports": [{"id": "football", "name": "Football", "status": "live"},
                   {"id": "cricket", "name": "Cricket", "status": "live"},
                   {"id": "kabaddi", "name": "Kabaddi", "status": "soon"}],
        "analytics": False, "noindex": True,
        "banner": "Staging — data and features here are unfinished.",
        "subdir": "staging",
    },
}


BANNER_CSS = """
.staging-banner{background:#F0BC63;color:#101720;font:600 13px/1.4 system-ui,sans-serif;
  text-align:center;padding:.35rem .8rem;letter-spacing:.01em}
"""


def stamp(root: str, channel: str) -> str:
    """Version the stylesheet and script.

    The channel goes into the hash so staging and production can never be served
    each other's cached assets.
    """
    digest = hashlib.sha1(channel.encode())
    # The banner needs a rule and it must exist in both stylesheets, because the
    # two sports do not share one.
    for sheet in ("style.css", "cricket.css"):
        sp = os.path.join(root, sheet)
        if os.path.exists(sp) and "staging-banner" not in open(sp).read():
            with open(sp, "a") as f:
                f.write(BANNER_CSS)

    for name in ("app.js", "style.css"):
        p = os.path.join(root, name)
        if os.path.exists(p):
            with open(p, "rb") as f:
                digest.update(f.read())
    v = digest.hexdigest()[:8]
    page = os.path.join(root, "index.html")
    with open(page) as f:
        html = f.read()
    html = re.sub(r'href="style\.css(\?v=[a-f0-9]+)?"', f'href="style.css?v={v}"', html)
    html = re.sub(r'src="app\.js(\?v=[a-f0-9]+)?"', f'src="app.js?v={v}"', html)
    with open(page, "w") as f:
        f.write(html)
    return v


def build(channel: str, out_root: str, base_url: str) -> str | None:
    cfg = CHANNELS[channel]
    dest = os.path.join(out_root, cfg["subdir"]) if cfg["subdir"] else out_root
    os.makedirs(dest, exist_ok=True)

    # Work out what is actually deployable BEFORE copying anything. A sport can
    # be marked live in config and still have no data — a frontend-only deploy
    # may run before the data job has ever published — and shipping its page
    # with nothing behind it is worse than leaving it out.
    sports = []
    for s in cfg["sports"]:
        if s["status"] != "live" or s["id"] == "football":
            sports.append(s)
            continue
        src = os.path.join(SITE, "data", s["id"])
        if os.path.isdir(src) and any(f.endswith(".json") for f in os.listdir(src)):
            sports.append(s)
        else:
            print(f"  {channel}: {s['id']} has no data, shipping it as 'soon'")
            sports.append(dict(s, status="soon"))
    live = {s["id"] for s in sports if s["status"] == "live"}

    for entry in os.listdir(SITE):
        if entry == "data":
            continue
        # A sport that is not live here does not ship its page at all. A stray
        # cricket.html would load, find no data and show an error to someone who
        # never asked for cricket.
        stem = entry.split(".")[0]
        if stem in ("cricket", "kabaddi") and stem not in live:
            continue
        src = os.path.join(SITE, entry)
        dst = os.path.join(dest, entry)
        (shutil.copytree if os.path.isdir(src) else shutil.copy2)(
            src, dst, **({"dirs_exist_ok": True} if os.path.isdir(src) else {}))

    for sport in live:
        if sport == "football":
            src = os.path.join(SITE, "data")
            os.makedirs(os.path.join(dest, "data"), exist_ok=True)
            for f in (os.listdir(src) if os.path.isdir(src) else []):
                if f.endswith(".json"):
                    shutil.copy2(os.path.join(src, f), os.path.join(dest, "data", f))
        else:
            shutil.copytree(os.path.join(SITE, "data", sport),
                            os.path.join(dest, "data", sport), dirs_exist_ok=True)

    info = {"channel": channel, "sports": sports, "analytics": cfg["analytics"],
            "banner": cfg["banner"], "base": base_url}
    with open(os.path.join(dest, "channel.json"), "w") as f:
        json.dump(info, f, indent=2)
    # Loaded before the app so the switcher knows what is live here, and so
    # analytics can be off on staging without a second code path.
    with open(os.path.join(dest, "channel.js"), "w") as f:
        f.write("window.PS_CHANNEL = " + json.dumps(info) + ";\n")

    page = os.path.join(dest, "index.html")
    with open(page) as f:
        html = f.read()
    if cfg["noindex"]:
        html = html.replace("<head>", '<head>\n  <meta name="robots" content="noindex,nofollow">', 1)
    with open(page, "w") as f:
        f.write(html)
    if cfg["noindex"]:
        with open(os.path.join(dest, "robots.txt"), "w") as f:
            f.write("User-agent: *\nDisallow: /\n")

    if cfg["banner"]:
        for name in os.listdir(dest):
            if not name.endswith(".html"):
                continue
            fp = os.path.join(dest, name)
            with open(fp) as f:
                h = f.read()
            with open(fp, "w") as f:
                f.write(h.replace("<body>",
                        f'<body>\n<div class="staging-banner">{cfg["banner"]}</div>', 1))

    v = stamp(dest, channel)
    print(f"  {channel:11} -> {dest}   assets v={v}   sports live: {', '.join(sorted(live))}")
    return dest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--staging-only", action="store_true",
                    help="still builds production; only skips failing the run if "
                         "staging is the thing that changed")
    ap.add_argument("--base", default="/player-scout")
    args = ap.parse_args()

    if os.path.exists(args.out):
        shutil.rmtree(args.out)
    os.makedirs(args.out)

    print("building channels:")
    if build("production", args.out, args.base) is None:
        raise SystemExit("production build failed — refusing to deploy")
    try:
        if build("staging", args.out, f"{args.base}/staging") is None:
            print("  staging skipped; production deploys unchanged")
    except Exception as e:                      # staging must never take prod down
        print(f"  staging failed ({e}); production deploys unchanged")


if __name__ == "__main__":
    main()
