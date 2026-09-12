/* Player Scout — search, rank, compare.
   Everything renders from three JSON files the pipeline writes. */

const $ = (id) => document.getElementById(id);
const state = {
  meta: null, index: [], byUid: new Map(), detail: null,
  countries: {}, leagues: {}, selected: null, highlight: -1,
  filters: { scope: "position", age: "any", contract: "any", activeOnly: true },
  compare: [], tab: "profile",
};

const MAX_COMPARE = 5;
// Three matches. Below this a per-90 rate is arithmetic, not information:
// Lamine Yamal's two-minute cameo in 2022/23 works out at 19.38 per 90.
const MIN_SEASON_MINUTES = 270;                       // the searched player plus four
const SERIES = ["gold", "blue", "green", "violet", "coral"];

const SPORTS = [
  { id: "football", name: "Football", status: "live" },
  { id: "cricket", name: "Cricket", status: "soon" },
  { id: "kabaddi", name: "Kabaddi", status: "soon" },
];

const isNarrow = () => (typeof window.matchMedia === "function"
  ? window.matchMedia("(max-width: 680px)").matches
  : window.innerWidth <= 680);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/* ---------- boot ---------- */

async function boot() {
  try {
    if (window.__PS__) {
      Object.assign(state, {
        meta: window.__PS__.meta, index: window.__PS__.index,
        countries: window.__PS__.countries, leagues: window.__PS__.leagues || {},
        detail: window.__PS__.detail,
      });
    } else {
      const [meta, index, countries, leagues] = await Promise.all([
        fetch("data/meta.json").then((r) => r.json()),
        fetch("data/index.json").then((r) => r.json()),
        fetch("assets/countries.json").then((r) => r.json()),
        fetch("assets/leagues.json").then((r) => r.json()),
      ]);
      Object.assign(state, { meta, index, countries, leagues });
      fetch("data/detail.json").then((r) => r.json()).then((d) => { state.detail = d; });
    }
    state.index.forEach((p) => state.byUid.set(p.uid, p));
  } catch {
    $("hero").innerHTML = "<h1>The data files haven't been built yet.</h1>" +
      "<p>Run the scoring step, then reload this page.</p>";
    return;
  }
  renderSports();
  renderCoverCard();
  renderExamples();
  renderMethod();
  wire();

  // Detail arrives after the index in the deployed build, so a deep link waits
  // for it rather than rendering half a profile.
  const restore = () => { if (!readUrl()) return; };
  if (state.detail) restore();
  else {
    const t = setInterval(() => {
      if (state.detail) { clearInterval(t); restore(); }
    }, 60);
    setTimeout(() => clearInterval(t), 15000);
  }
}

function renderSports() {
  $("sports").innerHTML = SPORTS.map((s) => `
    <button class="sport" data-sport="${s.id}" ${s.status === "live" ? "" : "disabled"}
            aria-current="${s.status === "live"}">
      ${esc(s.name)}${s.status === "live" ? "" : '<span class="soon">soon</span>'}
    </button>`).join("");
}

function renderCoverCard() {
  const m = state.meta;
  const last = m.seasons[m.seasons.length - 1];
  $("top-note").textContent = `Complete through ${last}`;

  $("bigstats").innerHTML = [
    [m.pool.toLocaleString(), "players"],
    [m.active_players.toLocaleString(), "still in these leagues"],
    [m.seasons.length, "seasons"],
  ].map(([v, k]) => `<div><b>${v}</b><span>${esc(k)}</span></div>`).join("");

  $("leaguelist").innerHTML = m.leagues.map((l) => {
    const info = state.leagues[l] || {};
    const short = info.short || l.slice(0, 2);
    const badge = info.slug
      ? `<img src="assets/leagues/${info.slug}.svg" alt="" class="lmark"
           onerror="this.replaceWith(Object.assign(document.createElement('span'),
           {className:'lmark letters',textContent:'${short}'}))">`
      : `<span class="lmark letters">${esc(short)}</span>`;
    return `<li>${badge}<span class="lname">${esc(l)}</span>
      <span class="lcountry">${esc(info.country || "")}</span></li>`;
  }).join("");

  const entries = Object.entries(m.positions)
    .map(([k, v]) => [k, v.players]).sort((a, b) => b[1] - a[1]);
  const top = Math.max(...entries.map((e) => e[1]));
  $("posbars").innerHTML = `<h3>Players by position</h3>` + entries.map(([k, v]) =>
    `<div class="posrow"><span>${esc(k)}</span>
      <span class="postrack"><span style="width:${((v / top) * 100).toFixed(1)}%"></span></span>
      <b>${v}</b></div>`).join("");

  $("currency").innerHTML =
    `<span class="dot blue"></span>Seasons ${m.seasons[0]} to ${last} are complete. ` +
    `The season now in progress is not included yet — it will be added once it ` +
    `finishes, so part-season numbers never distort a career profile.`;
}

function renderExamples() {
  const picks = ["Rayan Cherki", "Bukayo Saka", "Lamine Yamal", "Ben White", "Florian Wirtz"]
    .map((n) => state.index.find((p) => p.name === n)).filter(Boolean);
  $("examples").innerHTML = picks.map((p) =>
    `<button class="pick" data-uid="${p.uid}">${flagHtml(p.nationality)}${esc(p.name)}</button>`
  ).join("");
  $("examples").querySelectorAll(".pick").forEach((b) =>
    b.addEventListener("click", () => select(b.dataset.uid)));
}

/* ---------- flags ---------- */

function flagHtml(country) {
  if (!country) return `<span class="flag"><span class="iso">?</span></span>`;
  const code = state.countries[country];
  const label = esc(country);
  const letters = (code || label).replace(/[^a-zA-Z]/g, "").slice(-3, -1).toUpperCase() || "??";
  if (!code) return `<span class="flag" title="${label}"><span class="iso">${esc(label.slice(0, 2))}</span></span>`;
  const src = window.__PS__?.flags?.[code] || `assets/flags/${code}.svg`;
  if (window.__PS__ && !window.__PS__.flags[code])
    return `<span class="flag" title="${label}"><span class="iso">${letters}</span></span>`;
  return `<span class="flag" title="${label}">
    <img src="${src}" alt="${label}" loading="lazy"
         onerror="this.replaceWith(Object.assign(document.createElement('span'),
                  {className:'iso',textContent:'${letters}'}))"></span>`;
}

/* ---------- search ---------- */

function search(term) {
  const q = norm(term.trim());
  if (q.length < 2) return [];
  const out = [];
  for (const p of state.index) {
    const n = norm(p.name), alt = norm(p.alt_name);
    let rank = n.startsWith(q) ? 0 : n.includes(q) ? 1 : alt.includes(q) ? 2 : -1;
    if (rank < 0 && norm(p.current_club || p.club).startsWith(q)) rank = 3;
    if (rank >= 0) out.push({ p, rank });
  }
  return out.sort((a, b) => a.rank - b.rank || b.p.minutes - a.p.minutes)
    .slice(0, 9).map((r) => r.p);
}

function renderSuggestions(list) {
  const box = $("suggestions");
  $("search").setAttribute("aria-expanded", String(list.length > 0));
  if (!list.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = list.map((p, i) => `
    <li role="option" data-uid="${p.uid}" aria-selected="${i === state.highlight}">
      ${flagHtml(p.nationality)}
      <span class="sug-name">${esc(p.name)}</span>
      <span class="sug-meta">${esc(p.position)} · ${esc(p.club)}</span>
    </li>`).join("");
  [...box.children].forEach((li) =>
    li.addEventListener("mousedown", (e) => { e.preventDefault(); select(li.dataset.uid); }));
}

/* ---------- shareable state ----------
   A refresh, a bookmark or a link someone sends should land on the same view.
   The player, the tab and anyone being compared all live in the query string. */

function writeUrl() {
  const u = new URL(window.location.href);
  const q = u.searchParams;
  if (!state.selected) { q.delete("p"); q.delete("tab"); q.delete("with"); }
  else {
    q.set("p", state.selected.uid);
    if (state.tab !== "profile") q.set("tab", state.tab); else q.delete("tab");
    if (state.compare.length) q.set("with", state.compare.join(",")); else q.delete("with");
  }
  history.replaceState(null, "", `${u.pathname}${q.toString() ? "?" + q : ""}`);
}

function readUrl() {
  const q = new URLSearchParams(window.location.search);
  const uid = q.get("p");
  if (!uid || !state.byUid.has(uid)) return false;
  select(uid, { silent: true });
  const withUids = (q.get("with") || "").split(",").filter((x) => state.byUid.has(x));
  withUids.slice(0, MAX_COMPARE - 1).forEach((x) => state.compare.push(x));
  if (state.compare.length) { renderResults(); renderCompare(); }
  const tab = q.get("tab");
  if (["profile", "similar", "compare"].includes(tab)) setTab(tab);
  return true;
}

/* ---------- selection and tabs ---------- */

function select(uid, opts = {}) {
  const p = state.byUid.get(uid);
  if (!p) return;
  state.selected = p;
  state.compare = [];
  $("search").value = p.name;
  $("suggestions").hidden = true;
  $("clear").hidden = false;
  $("hero").hidden = true;
  $("workspace").hidden = false;
  renderPlayerBar();
  renderProfileTab();
  renderResults();
  renderCompare();
  renderMethod();
  setTab("profile");
  if (!opts.silent) window.scrollTo({ top: 0, behavior: "smooth" });
}

function clearSelection() {
  setTab("profile");
  state.selected = null;
  state.compare = [];
  $("search").value = "";
  $("clear").hidden = true;
  $("suggestions").hidden = true;
  $("workspace").hidden = true;
  $("hero").hidden = false;
  writeUrl();
  $("search").focus();
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll("#tabs [role=tab]").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  ["profile", "similar", "compare"].forEach((t) => { $(`panel-${t}`).hidden = t !== tab; });
  writeUrl();
}

/* ---------- player bar ---------- */

function fmtValue(v) {
  if (v == null) return null;
  return v >= 1e6 ? `€${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}m` : `€${Math.round(v / 1e3)}k`;
}
function fmtDate(iso) {
  if (!iso) return null;
  return new Date(iso + "T00:00:00Z")
    .toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}
function monthsLeft(iso) {
  return iso ? (new Date(iso) - Date.now()) / 2.628e9 : null;
}
function contractText(iso) {
  const m = monthsLeft(iso);
  if (m == null) return "not recorded";
  if (m < 0) return "expired";
  if (m < 12) return `${Math.max(1, Math.round(m))} months left`;
  return `${(m / 12).toFixed(1).replace(/\.0$/, "")} years left`;
}

function renderPlayerBar() {
  const p = state.selected;
  const facts = [
    ["Age", p.age ?? "—"],
    ["Height", p.height ? `${p.height}cm` : "—"],
    ["Foot", p.foot || "—"],
    ["Value", fmtValue(p.value) || "—"],
    ["Contract", fmtDate(p.contract) || "—", contractText(p.contract)],
    ["Minutes", p.minutes.toLocaleString(), `${p.seasons} seasons`],
  ];
  $("playerbar").innerHTML = `
    <div class="pb-id">
      ${flagHtml(p.nationality)}
      <div>
        <h1>${esc(p.name)}</h1>
        <p class="pb-role">${whereLine(p)}${p.nationality ? ` · ${esc(p.nationality)}` : ""}</p>
      </div>
      <span class="availability ${p.active ? "active" : "gone"}">${
        p.active ? `In ${esc(p.league)}, ${p.last_season}` : `Left after ${p.last_season}`}</span>
    </div>
    <dl class="pb-facts">${facts.map(([k, v, sub]) =>
      `<div><dt>${esc(k)}</dt><dd>${esc(v)}${sub ? `<small>${esc(sub)}</small>` : ""}</dd></div>`
    ).join("")}</dl>
    <div class="pb-actions">
      <button class="ghost primary" id="go-compare" hidden></button>
      ${sourceLink("Understat", "US", state.meta.understat_url.replace("{id}", p.us_id), "understat")}
      ${p.transfermarkt ? sourceLink("Transfermarkt", "TM", p.transfermarkt, "transfermarkt") : ""}
      <button class="ghost" id="clear-player">Search another player</button>
    </div>`;
  $("clear-player").addEventListener("click", clearSelection);
  $("go-compare").addEventListener("click", () => setTab("compare"));
  syncCompareShortcut();
}

/* The comparison is worth nothing if people cannot find it, so the count is
   surfaced wherever a player has just been added. */
function syncCompareShortcut() {
  const n = state.compare.length;
  const btn = $("go-compare");
  if (btn) {
    btn.hidden = n === 0;
    btn.textContent = `Compare ${n + 1} players`;
  }
  const jump = $("results-jump");
  if (jump) {
    jump.hidden = n === 0;
    jump.textContent = `See comparison (${n + 1})`;
  }
}

function sourceLink(name, mono, href, slug) {
  return `<a class="srclink" href="${esc(href)}" target="_blank" rel="noopener noreferrer">
    <img src="assets/${slug}.svg" alt="" width="16" height="16"
         onerror="this.replaceWith(Object.assign(document.createElement('span'),
                  {className:'monogram',textContent:'${mono}'}))">
    <span>${esc(name)}</span></a>`;
}

/* ---------- radar drawing ---------- */

function radarSvg(series, metrics, labels, opts = {}) {
  // On a phone the full labels overrun the viewBox, so short forms are used and
  // the box is widened to give the text room.
  const compact = isNarrow();
  const pad = compact ? 96 : 62;
  const size = 300, cx = 150, cy = 150, r = compact ? 88 : 100, n = metrics.length;
  const angle = (i) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const at = (i, f) => [cx + Math.cos(angle(i)) * r * f, cy + Math.sin(angle(i)) * r * f];
  const pts = (get) => metrics.map((m, i) =>
    at(i, Math.max(0.04, (get(m) ?? 0) / 100)).map((v) => v.toFixed(1)).join(",")).join(" ");

  const rings = [0.25, 0.5, 0.75, 1].map((f) => {
    const cls = f === 1 ? " outer" : f === 0.5 ? " median" : "";
    return `<polygon class="radar-ring${cls}" points="${
      metrics.map((_, i) => at(i, f).map((v) => v.toFixed(1)).join(",")).join(" ")}"/>`;
  }).join("") +
  [[1, "100"], [0.5, "50"]].map(([f, t]) =>
    `<text class="radar-tick" x="${cx + 3}" y="${(cy - r * f + 3).toFixed(1)}">${t}</text>`).join("");

  const spokes = metrics.map((_, i) => {
    const [x, y] = at(i, 1);
    return `<line class="radar-spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
  }).join("");

  const shapes = series.map((s, k) =>
    `<polygon class="radar-area ${s.colour}${series.length > 1 && k > 0 ? " line" : ""}"
      points="${pts((m) => s.pct[m])}"/>`).join("");

  const text = metrics.map((m, i) => {
    const ang = angle(i);
    const [lx, ly] = [cx + Math.cos(ang) * (r + (compact ? 24 : 30)),
                      cy + Math.sin(ang) * (r + (compact ? 24 : 30))];
    const anchor = Math.abs(Math.cos(ang)) < 0.25 ? "middle" : Math.cos(ang) > 0 ? "start" : "end";
    const words = wrapLabel(compact
      ? ((state.meta.metric_short || {})[m] || labels[m] || m) : (labels[m] || m));
    const lines = words.map((w, k) =>
      `<tspan x="${lx.toFixed(1)}" dy="${k === 0 ? 0 : 10}">${esc(w)}</tspan>`).join("");
    const vals = series.map((s) =>
      `<tspan class="p-${s.colour}">${Math.round(s.pct[m] ?? 0)}</tspan>`)
      .join('<tspan class="ps">/</tspan>');
    return `<text class="radar-label" x="${lx.toFixed(1)}" y="${(ly - 5).toFixed(1)}"
      text-anchor="${anchor}">${lines}</text>
      <text class="radar-pair" x="${lx.toFixed(1)}"
      y="${(ly + 8 + (words.length - 1) * 10).toFixed(1)}" text-anchor="${anchor}">${vals}</text>`;
  }).join("");

  return `<svg viewBox="${-pad} -26 ${size + pad * 2} ${size + 52}" role="img"
    aria-label="${esc(opts.label || "Percentile profile")}">
    ${rings}${spokes}${shapes}${text}</svg>`;
}

function wrapLabel(text) {
  const words = String(text).split(" ");
  if (words.length < 3) return [text];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

function fmtMetric(metric, value) {
  if (value == null) return "—";
  return value < 1 ? value.toFixed(2) : value.toFixed(value < 10 ? 2 : 1);
}

/* ---------- profile tab ---------- */

function renderProfileTab() {
  const p = state.selected;
  const d = state.detail?.[p.uid];
  const pos = state.meta.positions[p.position] || {};
  const labels = state.meta.metric_labels;

  if (!d) return;

  if (!pos.scored && pos.level === "distribution_only") {
    const metrics = pos.metrics || state.meta.gk_metrics;
    $("radar-title").textContent = pos.headline;
    $("radar-sub").textContent = pos.note;
    $("radar").innerHTML = `<div class="pctbars">` + metrics.map((m) => `
      <div class="pctrow"><span class="pctlabel">${esc(labels[m] || m)}</span>
        <span class="pcttrack"><span class="pctfill" style="width:${d.pct[m] ?? 0}%"></span>
        <span class="pctmid"></span></span>
        <span class="pctval">${fmtMetric(m, d.adj[m])}</span>
        <span class="pctrank">${d.pct[m] ?? 0}</span></div>`).join("") + `</div>`;
    $("scale-help").innerHTML = esc(pos.caveat || "");
    $("radar-key").innerHTML = "";
  } else if (pos.scored) {
    const metrics = state.meta.radar_metrics;
    $("radar-title").textContent = "Profile against position";
    $("radar-sub").textContent =
      `Percentile among all ${pos.players} ${p.position.toLowerCase()}s in the pool, ` +
      `after adjusting for league.`;
    $("radar").innerHTML = radarSvg(
      [{ colour: "gold", pct: d.pct }], metrics, labels, { label: `Profile for ${p.name}` });
    $("scale-help").innerHTML =
      `Percentile = how many of those ${pos.players} this player beats. <b>50</b> is the ` +
      `position average, marked by the dotted ring. The pool is every ` +
      `${p.position.toLowerCase()} with ${state.meta.min_minutes.toLocaleString()}+ minutes ` +
      `since ${state.meta.seasons[0]}, including those who have since left the big five.`;
    $("radar-key").innerHTML =
      `<div class="keyhead"><span>Metric</span><span>Per 90</span><span>Percentile</span></div>` +
      metrics.map((m) => `
        <div class="keyrow"><span class="k">${esc(labels[m] || m)}</span>
          <span class="v">${fmtMetric(m, d.adj[m])}</span>
          <span class="p"><span class="pbar"><span style="width:${d.pct[m] ?? 0}%"></span></span>
          <b>${Math.round(d.pct[m] ?? 0)}</b></span></div>`).join("");
  }
  renderCareer(p);
  renderHistory(p);
}

function renderCareer(p) {
  const d = state.detail?.[p.uid];
  if (!d?.history?.length) { $("career").innerHTML = ""; return; }
  const S = state.meta.history_schema, col = (r, k) => r[S.indexOf(k)];
  const h = d.history;
  const sum = (k) => h.reduce((a, r) => a + (col(r, k) || 0), 0);
  const mins = sum("minutes");
  const clubs = [...new Set(h.map((r) => col(r, "team")))];
  const leagues = [...new Set(h.map((r) => col(r, "league")))];

  $("career-sub").textContent = `Totals across ${h.length} season${h.length > 1 ? "s" : ""}.`;
  const cells = [
    ["Matches", sum("games")],
    ["Goals", sum("goals").toFixed(0)],
    ["Assists", sum("assists").toFixed(0)],
    ["Non-penalty xG", (d.adj.npxG_90 * (mins / 90)).toFixed(1)],
    ["Expected assists", (d.adj.xA_90 * (mins / 90)).toFixed(1)],
    ["Goals + assists / 90", ((sum("goals") + sum("assists")) / (mins / 90)).toFixed(2)],
  ];
  $("career").innerHTML = cells.map(([k, v]) =>
    `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("") +
    `<p class="clubs">${clubs.length > 1 ? "Clubs" : "Club"}: <b>${clubs.map(esc).join(", ")}</b>` +
    (leagues.length > 1 ? ` · ${leagues.length} leagues` : "") + `</p>`;
}

function renderHistory(p) {
  const d = state.detail?.[p.uid];
  const bench = (state.meta.positions[p.position] || {}).benchmark;
  if (!d?.history?.length || !bench) { $("history").innerHTML = ""; return; }
  const S = state.meta.history_schema, col = (r, k) => r[S.indexOf(k)];
  const rows = [...d.history].sort((a, b) => col(a, "season").localeCompare(col(b, "season")));
  const isKeeper = bench.metric === "xGBuildup_90";
  const parts = isKeeper
    ? [{ key: "xGBuildup_90", label: "Build-up involvement", cls: "" }]
    : [{ key: "npxG_90", label: "Non-penalty xG", cls: "" },
       { key: "xA_90", label: "Expected assists", cls: "alt" }];
  const scale = bench.best || 1;
  const pc = (v) => Math.max(0, Math.min(100, (v / scale) * 100));
  const leader = (b) => b ? `${esc(b.player)} ${b.value.toFixed(2)}` : "—";

  $("history-sub").innerHTML = isKeeper
    ? `Build-up involvement per 90, as recorded. The axis runs to <b>${bench.best.toFixed(2)}</b>.`
    : `Per 90, as recorded — not league-adjusted. The axis runs to ` +
      `<b>${bench.best.toFixed(2)}</b>, the highest combined season by any ` +
      `${esc(p.position.toLowerCase())}: ${esc(bench.best_player)}, ${esc(bench.best_season)}. ` +
      `Each part peaks separately — non-penalty xG ${leader(bench.top_npxg)}, ` +
      `expected assists ${leader(bench.top_xa)}.`;

  const legend = `<div class="hlegend">
    ${parts.map((x) => `<span class="lg"><i class="sw ${x.cls}"></i>${esc(x.label)}</span>`).join("")}
    <span class="lg"><i class="tick median"></i>Position median ${bench.median.toFixed(2)}</span>
    <span class="lg"><i class="tick upper"></i>Top quarter ${bench.upper_quartile.toFixed(2)}</span>
  </div>`;
  const head = `<div class="hrow hhead"><span>Season</span><span>Club</span>
    <span class="htrackhead">0<em>${scale.toFixed(2)} per 90</em></span>
    <span class="hnum">Total</span><span class="hmins">Minutes</span></div>`;
  const body = rows.map((r) => {
    const mins = col(r, "minutes");
    const thin = mins < MIN_SEASON_MINUTES;
    const vals = parts.map((x) => col(r, x.key) || 0);
    const total = vals.reduce((a, b) => a + b, 0);
    if (thin) {
      return `<div class="hrow thin-season">
        <span class="hseason">${esc(col(r, "season"))}</span>
        <span class="hclub"><b>${esc(col(r, "team"))}</b> · ${esc(col(r, "league"))}</span>
        <span class="htrack empty"><em>too few minutes for a per-90 rate</em></span>
        <span class="hnum">—</span>
        <span class="hmins">${mins.toLocaleString()}</span></div>`;
    }
    const segs = parts.map((x, i) =>
      `<span class="hbar ${x.cls}" style="width:${pc(vals[i]).toFixed(2)}%"
        title="${esc(x.label)}: ${vals[i].toFixed(2)} per 90"></span>`).join("");
    return `<div class="hrow">
      <span class="hseason">${esc(col(r, "season"))}</span>
      <span class="hclub"><b>${esc(col(r, "team"))}</b> · ${esc(col(r, "league"))}</span>
      <span class="htrack">
        <span class="hmark median" style="left:${pc(bench.median).toFixed(2)}%"></span>
        <span class="hmark upper" style="left:${pc(bench.upper_quartile).toFixed(2)}%"></span>
        <span class="hfill">${segs}</span></span>
      <span class="hnum">${total.toFixed(2)}</span>
      <span class="hmins">${col(r, "minutes").toLocaleString()}</span></div>`;
  }).join("");
  $("history").innerHTML = legend + head + body;
}

/* ---------- similar players ---------- */

function passesFilters(c) {
  const f = state.filters;
  if (f.activeOnly && !c.active) return false;
  if (f.age !== "any") {
    const a = c.age;
    if (a == null) return false;
    if (f.age === "u21" && a >= 21) return false;
    if (f.age === "u24" && a >= 24) return false;
    if (f.age === "24-28" && (a < 24 || a > 28)) return false;
    if (f.age === "29+" && a < 29) return false;
  }
  if (f.contract !== "any") {
    const m = monthsLeft(c.contract);
    if (m == null || m > Number(f.contract)) return false;
  }
  return true;
}

function scopeInfo(p) {
  const group = state.meta.position_groups[p.position];
  const wide = state.filters.scope === "group" && state.meta.groups?.[group];
  return wide
    ? { key: "gcoords", meta: state.meta.groups[group], label: group,
        test: (c) => state.meta.position_groups[c.position] === group }
    : { key: "coords", meta: state.meta.positions[p.position], label: p.position,
        test: (c) => c.position === p.position };
}

function distanceTo(a, b, key) {
  if (!a[key]?.length || !b[key]?.length) return null;
  let s = 0;
  for (let i = 0; i < a[key].length; i++) s += (a[key][i] - b[key][i]) ** 2;
  return Math.sqrt(s);
}

function matchScore(p, c) {
  const s = scopeInfo(p);
  const d = distanceTo(p, c, s.key);
  return d == null || !s.meta?.median_distance
    ? null : 100 * Math.exp((-Math.LN2 * d) / s.meta.median_distance);
}

function rank(p) {
  const s = scopeInfo(p);
  let eligible = 0;
  const rows = [];
  for (const c of state.index) {
    if (c.uid === p.uid || !s.test(c) || !c[s.key]?.length) continue;
    eligible++;
    if (!passesFilters(c)) continue;
    const d = distanceTo(p, c, s.key);
    if (d != null) rows.push({ c, d });
  }
  rows.sort((a, b) => a.d - b.d);
  return { scope: s, eligible,
    rows: rows.slice(0, 10).map((r) => ({ ...r,
      score: 100 * Math.exp((-Math.LN2 * r.d) / s.meta.median_distance) })) };
}

function chipsFor(a, b) {
  const da = state.detail?.[a.uid], db = state.detail?.[b.uid];
  if (!da || !db) return [];
  const rows = state.meta.radar_metrics.map((m) => {
    const x = da.pct[m] ?? 50, y = db.pct[m] ?? 50;
    return { m, gap: Math.abs(x - y), edge: Math.min(Math.abs(x - 50), Math.abs(y - 50)), x, y };
  });
  const same = rows.filter((r) => r.edge > 15).sort((p, q) => p.gap - q.gap)[0]
            || [...rows].sort((p, q) => p.gap - q.gap)[0];
  const diff = [...rows].sort((p, q) => q.gap - p.gap).slice(0, 2);
  const short = state.meta.metric_short || {};
  const nm = (m) => short[m] || (state.meta.metric_labels[m] || m).toLowerCase();
  return [{ cls: "same", text: `Similar ${nm(same.m)}` },
    ...diff.map((r) => ({ cls: r.y > r.x ? "more" : "less",
      text: `${r.y > r.x ? "More" : "Less"} ${nm(r.m)}` }))];
}

function renderResults() {
  const p = state.selected;
  if (!p) return;
  const full = compareFull();
  const pos = state.meta.positions[p.position] || {};
  const group = state.meta.position_groups[p.position];
  const groupMeta = state.meta.groups?.[group];

  $("scope-position").textContent = `${p.position}s`;
  $("scope-group").textContent = groupMeta ? `All ${group.toLowerCase()}` : "Wider group";
  $("scope-group").disabled = !groupMeta;
  document.querySelectorAll("[data-scope]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.scope === state.filters.scope)));

  if (!pos.scored) {
    $("results-title").textContent = pos.headline || "Not ranked";
    $("results-note").textContent = pos.note || "";
    $("results-count").textContent = "";
    $("filters").hidden = true;
    $("tagkey").hidden = true;
    $("matches").innerHTML = "";
    $("thin").hidden = false;
    $("thin").textContent =
      "No similar-player list is offered for this position. Ranking goalkeepers " +
      "on the metrics available performs no better than picking at random, so a " +
      "list would imply a confidence the data cannot support.";
    return;
  }

  $("filters").hidden = false;
  $("tagkey").hidden = false;
  const { rows, eligible, scope } = rank(p);
  $("results-title").textContent = `Closest to ${p.name}`;
  $("results-note").textContent =
    (pos.level === "attacking_only" ? pos.note : scope.meta.note) || "";
  $("results-count").innerHTML = rows.length
    ? `${rows.length} shown of <b>${eligible}</b> in the pool` : "";

  if (!rows.length) {
    $("matches").innerHTML = "";
    $("thin").hidden = false;
    $("thin").textContent =
      `No ${scope.label.toLowerCase()} matches these filters. Widen the age range, ` +
      `or compare against the wider group.`;
    return;
  }
  $("thin").hidden = rows.length >= 5;
  if (rows.length < 5) {
    $("thin").textContent =
      `Only ${rows.length} match these filters. Loosen one, or compare against the wider group.`;
  }

  $("tagkey").innerHTML =
    (full ? `<span class="tagkey-full">Comparison is full. Remove a player to add another.</span> `
          : "") +
    `Tags compare each player with <b>${esc(p.name)}</b>: ` +
    `<em class="tag same">Similar</em> a shared trait, ` +
    `<em class="tag more">More</em> and <em class="tag less">Less</em> the two biggest gaps. ` +
    `<span class="tagkey-add">Use <b>+</b> to add a player to the comparison.</span>`;

  $("matches").innerHTML = rows.map((r, i) => {
    const c = r.c, chips = chipsFor(p, c), inCmp = state.compare.includes(c.uid);
    return `<li class="match${inCmp ? " is-open" : ""}">
      <button class="match-btn" data-uid="${c.uid}">
        <span class="rank">${i + 1}</span>
        <span class="score"><span class="score-num">${r.score.toFixed(0)}</span>
          <span class="score-track"><span style="width:${Math.min(100, r.score).toFixed(1)}%"></span></span></span>
        <span class="who">
          <span class="who-top">${flagHtml(c.nationality)}<b>${esc(c.name)}</b>
            ${c.active ? "" : '<em class="gone-tag">left</em>'}</span>
          <span class="who-sub">${whereLine(c)}</span>
        </span>
        <span class="meta-cell"><i>Age</i>${c.age ?? "—"}</span>
        <span class="meta-cell"><i>Contract</i>${esc(contractText(c.contract))}</span>
        <span class="meta-cell"><i>Value</i>${esc(fmtValue(c.value) || "—")}</span>
        <span class="reads">${chips.map((x) =>
          `<em class="tag ${x.cls}">${esc(x.text)}</em>`).join("")}</span>
      </button>
      <button class="addbtn${inCmp ? " on" : ""}" data-add="${c.uid}"
        aria-pressed="${inCmp}" ${!inCmp && full ? "disabled" : ""}
        title="${inCmp ? "Remove from comparison"
                : full ? `Comparison is full — remove someone first`
                : "Add to comparison"}">${inCmp ? "&minus;" : "+"}</button>
    </li>`;
  }).join("");

  $("matches").querySelectorAll(".match-btn").forEach((b) =>
    b.addEventListener("click", () => {
      if (!state.compare.includes(b.dataset.uid) && compareFull()) { setTab("compare"); return; }
      toggleCompare(b.dataset.uid, true);
      setTab("compare");
    }));
  $("matches").querySelectorAll(".addbtn").forEach((b) =>
    b.addEventListener("click", () => toggleCompare(b.dataset.add)));
  const jump = $("results-jump");
  if (jump && !jump.dataset.wired) {
    jump.dataset.wired = "1";
    jump.addEventListener("click", () => setTab("compare"));
  }
  syncCompareShortcut();
}

/* ---------- comparison ---------- */

function compareFull() {
  return state.compare.length >= MAX_COMPARE - 1;
}

function toggleCompare(uid, keep) {
  const i = state.compare.indexOf(uid);
  if (i >= 0) { if (!keep) state.compare.splice(i, 1); }
  else if (!compareFull()) state.compare.push(uid);
  else return;                       // full: drop someone first, never silently swap
  renderResults();
  renderCompare();
  syncCompareShortcut();
  writeUrl();
}

function compareSeries() {
  const p = state.selected;
  const list = [{ p, colour: SERIES[0] }];
  state.compare.forEach((uid, i) => {
    const c = state.byUid.get(uid);
    if (c) list.push({ p: c, colour: SERIES[(i + 1) % SERIES.length] });
  });
  return list.filter((s) => state.detail?.[s.p.uid]);
}

function renderCompare() {
  const base = state.selected;
  if (!base) return;
  const series = compareSeries();
  $("tab-compare").textContent =
    `Compare${state.compare.length ? ` (${state.compare.length + 1})` : ""}`;

  $("tray").innerHTML = series.map((s, i) => {
    const sc = i === 0 ? null : matchScore(base, s.p);
    return `<span class="trayitem ${s.colour}">
      <i class="swatch"></i>${flagHtml(s.p.nationality)}
      <b>${esc(s.p.name)}</b>
      ${i === 0 ? '<span class="base-tag">searched</span>'
        : `<span class="tray-score" title="Match score against ${esc(base.name)}">${
             sc == null ? "—" : sc.toFixed(0)}</span>
           <button class="traybtn" data-scout="${s.p.uid}">Scout instead</button>
           <button class="dropbtn" data-drop="${s.p.uid}" aria-label="Remove">&times;</button>`}
    </span>`;
  }).join("") +
    (state.compare.length < MAX_COMPARE - 1
      ? `<span class="trayhint">Add up to ${MAX_COMPARE - 1 - state.compare.length} more from
         <button class="linkish" data-goto="similar">Similar players</button></span>` : "");
  $("tray").querySelectorAll("[data-drop]").forEach((b) =>
    b.addEventListener("click", () => toggleCompare(b.dataset.drop)));
  $("tray").querySelectorAll("[data-scout]").forEach((b) =>
    b.addEventListener("click", () => select(b.dataset.scout)));
  $("tray").querySelectorAll("[data-goto]").forEach((b) =>
    b.addEventListener("click", () => setTab("similar")));

  if (series.length < 2) {
    $("compare-body").hidden = true;
    $("compare-empty").hidden = false;
    $("compare-empty").innerHTML =
      `Nothing to compare yet. Open <button class="linkish" data-goto2="similar">Similar
       players</button> and press <b>+</b> on up to ${MAX_COMPARE - 1} of them.`;
    $("compare-empty").querySelectorAll("[data-goto2]").forEach((b) =>
      b.addEventListener("click", () => setTab("similar")));
    return;
  }
  $("compare-body").hidden = false;
  $("compare-empty").hidden = true;

  const pos = state.meta.positions[base.position] || {};
  const mixed = series.some((s) => s.p.position !== base.position);
  $("cmp-radar-sub").textContent = mixed
    ? "Percentiles are against each player's own position, so the shapes compare roles rather than raw output."
    : `Percentile among ${pos.players} ${base.position.toLowerCase()}s.`;

  $("cmp-radar").innerHTML = radarSvg(
    series.map((s) => ({ colour: s.colour, pct: state.detail[s.p.uid].pct })),
    state.meta.radar_metrics, state.meta.metric_labels,
    { label: `Comparison of ${series.map((s) => s.p.name).join(", ")}` });

  renderCompareMetrics(series);
  renderTrend(series);
}

function renderCompareMetrics(series) {
  const labels = state.meta.metric_labels, notes = state.meta.metric_notes || {};
  // One column per player, so every value sits under its own heading.
  const legend = `<div class="mlegend">${series.map((s) =>
    `<span class="lg"><i class="sw ${s.colour}"></i>${esc(s.p.name)}</span>`).join("")}</div>`;
  const head = `<div class="mrow mhead"><span class="mlabel"></span><span></span>
    ${series.map((s) => `<span class="mv ${s.colour} name"><i class="sw ${s.colour}"></i></span>`)
      .join("")}</div>`;
  $("cmp-metrics").style.setProperty("--cols", series.length);
  $("cmp-metrics").innerHTML = legend + head + state.meta.metric_groups.map((g) => `
    <div class="mgroup"><h3>${esc(g.name)}</h3>
      ${g.metrics.map((m) => {
        const vals = series.map((s) => ({ ...s, pct: state.detail[s.p.uid].pct[m] ?? 50,
          val: state.detail[s.p.uid].adj[m] }));
        const best = Math.max(...vals.map((v) => v.pct));
        const lo = Math.min(...vals.map((v) => v.pct)), hi = best;
        return `<div class="mrow" title="${esc(notes[m] || "")}">
          <span class="mlabel">${esc(labels[m] || m)}</span>
          <span class="mtrack">
            <span class="mmid"></span>
            <span class="mspan" style="left:${lo}%;width:${(hi - lo).toFixed(1)}%"></span>
            ${vals.map((v) => `<span class="mdot ${v.colour}" style="left:${v.pct}%"
              title="${esc(v.p.name)}: ${fmtMetric(m, v.val)} (${Math.round(v.pct)}th)"></span>`).join("")}
          </span>
          ${vals.map((v) =>
            `<span class="mv ${v.colour}${v.pct === best ? " lead" : ""}">${fmtMetric(m, v.val)}</span>`
          ).join("")}</div>`;
      }).join("")}
    </div>`).join("");
}

/* Where the numbers came from, and where the player is now. Those are often
   different places — Cancelo's figures are Barcelona's, but he plays in Saudi
   Arabia — so pairing a current club with an old league invents a fact. */
function whereLine(p) {
  const base = `${esc(p.position)} · ${esc(p.club)} · ${esc(p.league)}`;
  const moved = p.current_club && p.current_club !== p.club;
  return base + (moved ? ` <em class="nowat">now at ${esc(p.current_club)}</em>` : "");
}

function shortName(name) {
  const parts = String(name).split(" ");
  return parts.length === 1 ? name : `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

function renderTrend(series) {
  const S = state.meta.history_schema, col = (r, k) => r[S.indexOf(k)];
  const seasons = state.meta.seasons;
  const bench = (state.meta.positions[state.selected.position] || {}).benchmark;

  const lines = series.map((s) => {
    const h = state.detail[s.p.uid].history || [];
    const map = new Map(h.filter((r) => col(r, "minutes") >= MIN_SEASON_MINUTES)
      .map((r) => [col(r, "season"),
        { v: (col(r, "npxG_90") || 0) + (col(r, "xA_90") || 0),
          mins: col(r, "minutes"), team: col(r, "team") }]));
    return { ...s, points: seasons.map((x) => map.get(x) || null) };
  });
  const top = Math.max(bench?.best || 0,
    ...lines.flatMap((l) => l.points.filter(Boolean).map((x) => x.v)), 0.2);

  $("cmp-trend-sub").innerHTML =
    `Non-penalty xG plus expected assists per 90 in each season, as recorded. ` +
    `A gap means no big-five minutes that season, or too few to form a rate.`;

  const W = 700, H = 250, padL = 62, padR = 22, padT = 18, padB = 46;
  const x = (i) => padL + (i * (W - padL - padR)) / Math.max(1, seasons.length - 1);
  const y = (v) => H - padB - (v / top) * (H - padT - padB);

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    `<line class="tgrid" x1="${padL}" x2="${W - padR}" y1="${y(top * f).toFixed(1)}"
      y2="${y(top * f).toFixed(1)}"/>
     <text class="taxis" x="${padL - 8}" y="${(y(top * f) + 3.5).toFixed(1)}"
      text-anchor="end">${(top * f).toFixed(2)}</text>`).join("");
  const medLine = bench ? `<line class="tmed" x1="${padL}" x2="${W - padR}"
    y1="${y(bench.median).toFixed(1)}" y2="${y(bench.median).toFixed(1)}"/>` : "";

  const paths = lines.map((l) => {
    const chunks = []; let cur = [];
    l.points.forEach((d, i) => {
      if (d) cur.push(`${x(i).toFixed(1)},${y(d.v).toFixed(1)}`);
      else { if (cur.length) chunks.push(cur); cur = []; }
    });
    if (cur.length) chunks.push(cur);
    const dots = l.points.map((d, i) => d
      ? `<circle class="tdot ${l.colour}" cx="${x(i).toFixed(1)}" cy="${y(d.v).toFixed(1)}" r="3.6">
          <title>${esc(l.p.name)} — ${esc(seasons[i])}: ${d.v.toFixed(2)} per 90,
          ${d.mins.toLocaleString()} minutes, ${esc(d.team)}</title></circle>` : "").join("");
    return `<g class="tline ${l.colour}">${
      chunks.map((c) => `<polyline points="${c.join(" ")}"/>`).join("")}</g>${dots}`;
  }).join("");

  const xlabels = seasons.map((s, i) => {
    const anchor = i === 0 ? "start" : i === seasons.length - 1 ? "end" : "middle";
    return `<text class="taxis" x="${x(i).toFixed(1)}" y="${H - padB + 18}"
      text-anchor="${anchor}">${esc(s)}</text>`;
  }).join("");

  $("cmp-trend").innerHTML = `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Output by season">
    ${grid}${medLine}${paths}${xlabels}
    <text class="taxis title" transform="translate(13,${((H - padB + padT) / 2).toFixed(1)}) rotate(-90)"
      text-anchor="middle">Output per 90</text>
    <text class="taxis title" x="${(W + padL - padR) / 2}" y="${H - 6}" text-anchor="middle">Season</text>
    ${bench ? `<text class="taxis med" x="${W - padR}" y="${(y(bench.median) - 5).toFixed(1)}"
      text-anchor="end">position median ${bench.median.toFixed(2)}</text>` : ""}
  </svg>
  <div class="tlegend">${series.map((s) =>
    `<span class="lg"><i class="sw ${s.colour}"></i>${esc(s.p.name)}</span>`).join("")}</div>`;
}

/* ---------- method ---------- */

function renderMethod() {
  const m = state.meta;
  const shown = (state.selected && m.positions[state.selected.position]?.scored)
    ? state.selected.position
    : Object.entries(m.positions).filter(([, v]) => v.scored)
        .sort((a, b) => b[1].players - a[1].players)[0][0];
  const pm = m.positions[shown];
  const role = shown.toLowerCase() + "s";
  const kept = Math.round(pm.variance * 100);
  const short = m.metric_short || {};

  const compRows = (pm.loadings || []).map((c) => `
    <tr><td class="ax">${c.component}</td>
      <td class="sh"><span class="pcbar"><span style="width:${
        (c.variance / (pm.loadings[0].variance || 1) * 100).toFixed(1)}%"></span></span>
        <b>${Math.round(c.variance * 100)}%</b></td>
      <td class="dr">${c.drivers.slice(0, 3)
        .map((x) => esc(short[x.metric] || x.metric)).join(", ")}</td></tr>`).join("");

  const eff = m.league_effects["npxG_90"] || {};
  const span = Math.max(...m.leagues.map((l) => Math.abs((eff[l] ?? 1) - 1)), 0.02);
  const leagueBars = m.leagues.map((l) => ({ l, v: eff[l] ?? 1 }))
    .sort((a, b) => b.v - a.v).map(({ l, v }) => `
      <div class="dvrow"><span class="dvlabel">${esc(l)}</span>
        <span class="dvtrack"><span class="dvmid"></span>
          <span class="dvbar ${v >= 1 ? "right" : "left"}"
            style="width:${((Math.abs(v - 1) / span) * 46).toFixed(1)}%"></span></span>
        <b class="dvval">${v.toFixed(3)}</b></div>`).join("");

  const valRows = (m.validation || []).filter((v) => v.players > 100)
    .sort((a, b) => (a.median_rank / a.players) - (b.median_rank / b.players))
    .map((v) => `
      <tr><td class="vpos">${esc(v.position)}</td>
        <td class="vbar"><span class="vtrack"><span style="width:${
          Math.max(2, (1 - v.median_rank / v.chance_median_rank) * 100).toFixed(1)}%"></span></span></td>
        <td class="vnum"><b>${v.median_rank}</b></td>
        <td class="vof">of ${v.players}</td></tr>`).join("");

  $("method").innerHTML = `
    <section class="mcol"><h3>From ${m.similarity_metrics.length} metrics to ${pm.components} numbers</h3>
      <p>Several metrics measure the same thing twice: anyone who shoots often
        also has high non-penalty xG. Comparing all ${m.similarity_metrics.length}
        at once would count that trait repeatedly.</p>
      <p>Principal component analysis finds a smaller set of axes, each a blend of
        metrics that move together. A ${esc(shown.toLowerCase())} is then
        described by ${pm.components} numbers instead of
        ${m.similarity_metrics.length}, and similarity is the distance between
        two players across them.</p>
      <table class="pctable">
        <thead><tr><th class="ax">Axis</th><th class="sh">Explains</th>
          <th class="dr">Blend of</th></tr></thead>
        <tbody>${compRows}</tbody>
        <tfoot><tr><td class="ax">All</td><td class="sh"><b>${kept}%</b></td>
          <td class="dr">of what separates ${esc(role)}</td></tr></tfoot>
      </table>
      <p class="fine">The other ${100 - kept}% sits on axes explaining under 3%
        each — mostly season-to-season noise, so it is left out rather than
        pushing similar players apart at random.</p>
    </section>

    <section class="mcol"><h3>Same player, different league</h3>
      <p>A goal is not equally hard to come by everywhere. To compare across the
        big five, every rate is divided by a coefficient for the league it was
        produced in.</p>
      <p>Those coefficients come from the <b>${m.league_movers}</b> players who
        appear in more than one league, measuring the same person before and
        after a move. Comparing whole leagues instead would only reveal which
        has the better players.</p>
      <div class="dvhead"><span>Harder</span><span>Easier</span></div>
      <div class="dvchart">${leagueBars}</div>
      <p class="fine">Non-penalty xG. <b>1.112</b> in Ligue 1 means the same
        player generates about 11% more there than in an average big-five league,
        so his figure is adjusted down to match.</p>
    </section>

    <section class="mcol"><h3>Can a player find himself?</h3>
      <p>The honest test of a similarity model: split a player's seasons into two
        halves, build a profile from each, then ask where his own second-half
        profile ranks among every candidate given his first.</p>
      <p>A model reading noise would not find him. Numbers below are the median
        rank a player achieves — lower is better, and longer bars mean further
        ahead of chance.</p>
      <table class="vtable">
        <thead><tr><th>Position</th><th></th><th colspan="2">Median rank</th></tr></thead>
        <tbody>${valRows}</tbody>
      </table>
      <p class="fine">Landing 19th of 161 when chance is 81st is real signal, and
        well short of proof. Treat the results as a shortlist to watch, not a
        verdict.</p>
    </section>

    <section class="mcol"><h3>What this cannot see</h3>
      <div class="have"><b>${m.similarity_metrics.length}</b>
        <span>attacking metrics — every number here comes from one of them</span></div>
      <ul class="gaps">
        <li>Tackles, interceptions, duels, clearances</li>
        <li>Saves, claims, sweeping</li>
        <li>Passing volume and progression</li>
      </ul>
      <p>The source publishes shots and possession only. Defenders are therefore
        ranked on what they offer going forward, and goalkeepers are not ranked
        at all rather than ranked badly.</p>
      <p class="fine">${m.pool.toLocaleString()} players with
        ${m.min_minutes.toLocaleString()}+ minutes across
        ${m.seasons[0]}–${m.seasons[m.seasons.length - 1]}.
        Nothing here is modelled from anything except those metrics.</p>
    </section>`;
  syncMethodPanels();
}

/* Four dense columns side by side work on a laptop and not on a phone, where
   they become a swipeable strip: one section at a time, with tabs above.
   Scrolling and tapping stay in step either way. */
function syncMethodPanels() {
  const nav = $("method-nav");
  const cols = [...document.querySelectorAll(".method .mcol")];
  if (!nav || !cols.length) return;
  nav.innerHTML = cols.map((c, i) => {
    const label = c.querySelector("h3")?.textContent || `Part ${i + 1}`;
    return `<button role="tab" data-step="${i}" aria-selected="${i === 0}">
      <i>${i + 1}</i>${esc(shortMethodLabel(label))}</button>`;
  }).join("");
  nav.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      const el = cols[Number(b.dataset.step)];
      $("method").scrollTo({ left: el.offsetLeft - $("method").offsetLeft, behavior: "smooth" });
      markMethodStep(Number(b.dataset.step));
    }));
  if (!$("method").dataset.wired) {
    $("method").dataset.wired = "1";
    let tick;
    $("method").addEventListener("scroll", () => {
      clearTimeout(tick);
      tick = setTimeout(() => {
        const box = $("method");
        const i = Math.round(box.scrollLeft / Math.max(1, box.clientWidth));
        markMethodStep(Math.min(i, cols.length - 1));
      }, 90);
    }, { passive: true });
  }
  markMethodStep(0);
}

function markMethodStep(i) {
  document.querySelectorAll("#method-nav button").forEach((b, k) =>
    b.setAttribute("aria-selected", String(k === i)));
}

const METHOD_SHORT = ["The model", "Leagues", "Validation", "Limits"];
function shortMethodLabel(full) {
  const i = ["metrics to", "different league", "find himself", "cannot see"]
    .findIndex((k) => full.includes(k));
  return i >= 0 ? METHOD_SHORT[i] : full;
}

/* ---------- wiring ---------- */

function wire() {
  const box = $("search");
  box.addEventListener("input", () => {
    state.highlight = -1;
    $("clear").hidden = !box.value;
    renderSuggestions(search(box.value));
  });
  box.addEventListener("keydown", (e) => {
    const items = [...$("suggestions").children];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      state.highlight = (state.highlight + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.setAttribute("aria-selected", String(i === state.highlight)));
      items[state.highlight].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && items.length) {
      e.preventDefault();
      select(items[Math.max(0, state.highlight)].dataset.uid);
    } else if (e.key === "Escape") $("suggestions").hidden = true;
  });
  $("clear").addEventListener("click", clearSelection);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".finder")) $("suggestions").hidden = true;
  });

  document.querySelector(".brand").addEventListener("click", clearSelection);
  document.querySelector(".brand").setAttribute("role", "button");
  document.querySelector(".brand").setAttribute("tabindex", "0");
  document.querySelector(".brand").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); clearSelection(); }
  });

  let wasNarrow = isNarrow();
  window.addEventListener("resize", () => {
    const now = isNarrow();
    if (now === wasNarrow) return;
    wasNarrow = now;
    syncMethodPanels();
    if (state.selected) { renderProfileTab(); renderCompare(); }
  });

  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[role=tab]");
    if (b) setTab(b.dataset.tab);
  });

  $("filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-scope],button[data-age],button[data-contract]");
    if (!b) return;
    const key = b.dataset.scope ? "scope" : b.dataset.age ? "age" : "contract";
    state.filters[key] = b.dataset[key];
    b.parentElement.querySelectorAll("button").forEach((x) =>
      x.setAttribute("aria-pressed", String(x === b)));
    renderResults();
  });
  $("active-only").addEventListener("change", (e) => {
    state.filters.activeOnly = e.target.checked;
    renderResults();
  });
}

boot();
