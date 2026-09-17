"""Keep the parsed facts in a GitHub release, not in git.

Daily commits of a data file are the one thing that would sink this repository.
Git keeps every version of every file forever, so committing forty megabytes a
night adds fourteen gigabytes a year and the clone becomes unusable long before
the data does. Release assets replace in place and never touch history, which is
why they are the store.

Upsert, never append. Cricsheet revises existing matches and revisions arrive
through the same rolling window as new ones, so a match that comes back replaces
its own rows. Appending would silently double-count a corrected scorecard.

Falls back to a plain local directory when no token is present, so the whole
pipeline can be run and tested without GitHub in the loop.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import urllib.error
import urllib.parse
import urllib.request

import pandas as pd

API = "https://api.github.com"
UPLOADS = "https://uploads.github.com"
KINDS = ("appearances", "facts")


def _req(url, token, method="GET", data=None, ctype=None, raw=False):
    headers = {"Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28",
               "User-Agent": "player-scout"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if ctype:
        headers["Content-Type"] = ctype
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read() if raw else json.loads(r.read() or b"{}")


class Store:
    """Facts live either in a release (`repo` set) or in a directory."""

    def __init__(self, repo=None, tag="cricket-data", token=None, local="data/cricket/facts"):
        self.repo, self.tag, self.local = repo, tag, local
        self.token = token or os.environ.get("GITHUB_TOKEN")
        self.remote = bool(repo and self.token)
        os.makedirs(local, exist_ok=True)

    # ── release plumbing ────────────────────────────────────────────────
    def _release(self, create=True):
        try:
            return _req(f"{API}/repos/{self.repo}/releases/tags/{self.tag}", self.token)
        except urllib.error.HTTPError as e:
            if e.code != 404 or not create:
                raise
        body = json.dumps({
            "tag_name": self.tag, "name": "Cricket data",
            "body": ("Parsed Cricsheet facts. Rebuilt by the pipeline; not part of "
                     "the git history. Source: Cricsheet, ODC-BY."),
            "prerelease": True,
        }).encode()
        return _req(f"{API}/repos/{self.repo}/releases", self.token, "POST", body,
                    "application/json")

    def pull(self):
        """Fetch every asset into the local directory."""
        if not self.remote:
            print(f"store: local only ({self.local})")
            return
        rel = self._release()
        for asset in rel.get("assets", []):
            if not asset["name"].endswith(".parquet"):
                continue
            url = f"{API}/repos/{self.repo}/releases/assets/{asset['id']}"
            headers = {"Accept": "application/octet-stream"}
            req = urllib.request.Request(url, headers={
                **headers, "Authorization": f"Bearer {self.token}",
                "User-Agent": "player-scout"})
            with urllib.request.urlopen(req, timeout=600) as r, \
                    open(os.path.join(self.local, asset["name"]), "wb") as fh:
                shutil.copyfileobj(r, fh)
            print(f"  pulled {asset['name']}")

    def push(self, names=None):
        """Replace assets. Delete first: the API will not overwrite by name."""
        if not self.remote:
            print(f"store: local only, nothing pushed")
            return
        rel = self._release()
        existing = {a["name"]: a["id"] for a in rel.get("assets", [])}
        files = sorted(glob.glob(os.path.join(self.local, "*.parquet")))
        for path in files:
            name = os.path.basename(path)
            if names and name not in names:
                continue
            if name in existing:
                _req(f"{API}/repos/{self.repo}/releases/assets/{existing[name]}",
                     self.token, "DELETE")
            with open(path, "rb") as fh:
                blob = fh.read()
            url = (f"{UPLOADS}/repos/{self.repo}/releases/{rel['id']}/assets"
                   f"?{urllib.parse.urlencode({'name': name})}")
            _req(url, self.token, "POST", blob, "application/octet-stream")
            print(f"  pushed {name} ({len(blob)/1e6:.1f} MB)")

    # ── the actual merge ────────────────────────────────────────────────
    def upsert(self, incoming_dir: str):
        """Fold freshly parsed competitions into what is already stored.

        Keyed on match id: any match present in the incoming data replaces every
        stored row for that match, whether it is new or a revision.
        """
        touched, summary = set(), []
        for path in sorted(glob.glob(os.path.join(incoming_dir, "*.parquet"))):
            name = os.path.basename(path)
            new = pd.read_parquet(path)
            if new.empty:
                continue
            dest = os.path.join(self.local, name)
            if os.path.exists(dest) and os.path.abspath(dest) != os.path.abspath(path):
                old = pd.read_parquet(dest)
                ids = set(new["match_id"])
                added = len(ids - set(old["match_id"]))
                revised = len(ids & set(old["match_id"]))
                merged = pd.concat([old[~old["match_id"].isin(ids)], new], ignore_index=True)
            else:
                merged, added, revised = new, new["match_id"].nunique(), 0
            merged.to_parquet(dest, index=False)
            touched.add(name)
            summary.append({"file": name, "added": added, "revised": revised,
                            "rows": len(merged)})
        for s in summary:
            print(f"  {s['file']:34} +{s['added']:4} new, {s['revised']:4} revised, "
                  f"{s['rows']:>9,} rows")
        return touched, summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["pull", "push", "upsert"])
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"))
    ap.add_argument("--tag", default="cricket-data")
    ap.add_argument("--local", default="data/cricket/facts")
    ap.add_argument("--incoming", default="data/cricket/incoming")
    args = ap.parse_args()

    store = Store(args.repo, args.tag, local=args.local)
    if args.action == "pull":
        store.pull()
    elif args.action == "push":
        store.push()
    else:
        touched, _ = store.upsert(args.incoming)
        store.push(touched)


if __name__ == "__main__":
    main()
