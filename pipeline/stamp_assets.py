"""Version the stylesheet and script so a stale cache cannot mix them.

A browser holding an old style.css against a new index.html produces a page
that looks broken in ways that have nothing to do with the code. Appending a
content hash makes each change a new URL.

Run after editing anything in site/. The deploy workflow does it automatically.
"""
import hashlib
import os
import re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(HERE, "site")

digest = hashlib.sha1()
for name in ("app.js", "style.css"):
    with open(os.path.join(SITE, name), "rb") as f:
        digest.update(f.read())
version = digest.hexdigest()[:8]

path = os.path.join(SITE, "index.html")
with open(path) as f:
    html = f.read()
before = html
html = re.sub(r'href="style\.css(\?v=[a-f0-9]+)?"', f'href="style.css?v={version}"', html)
html = re.sub(r'src="app\.js(\?v=[a-f0-9]+)?"', f'src="app.js?v={version}"', html)
if html != before:
    with open(path, "w") as f:
        f.write(html)
    print(f"asset version set to {version}")
else:
    print(f"asset version already {version}")
