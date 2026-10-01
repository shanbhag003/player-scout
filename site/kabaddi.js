/* Kabaddi — Pro Kabaddi League. A separate page from football and cricket, on
   purpose: the three share the shell, the stylesheet and the switcher, but not a
   code path. The data is shaped like cricket's (index / detail / meta / per-player
   match logs), so this reuses cricket's radar, modal, shortlist and switcher and
   only the parts that are genuinely kabaddi differ. Similar-search only — no
   scouting mode. */
(async function(){
const $ = id => document.getElementById(id);
const BASE = "data/kabaddi";
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

let D, FLAGS = {}, DETAIL = null;

const CELL_LABEL = {raider:"Raider", "defender-corner":"Corner defender",
  "defender-cover":"Cover defender", "all-rounder":"All-rounder"};
const CELL_SHORT = {raider:"Raider", "defender-corner":"Corner",
  "defender-cover":"Cover", "all-rounder":"All-rounder"};
const cellNoun = c => (CELL_LABEL[c] || c) + "s";
const isRaider = c => c === "raider" || c === "all-rounder";

function shapePlayer(e){
  return {u:e.uid, p:e.player_id, n:e.name, f:e.name, d:"k", c:e.cell,
    r:CELL_LABEL[e.cell] || e.cell, pos:e.position, sub:e.subrole,
    x:e.coords, m:e.matches, raids:e.raids, tackles:e.tackles,
    a:e.age, nat:e.nationality, team:e.team, ly:e.last_year, fy:e.first_year,
    playing:e.active, thin:e.thin,
    pc:{}, act:{}, sea:[], car:null};
}

try {
  const [index, meta, flags] = await Promise.all([
    fetch(`${BASE}/index.json`).then(r => { if (!r.ok) throw new Error(`index.json ${r.status}`); return r.json(); }),
    fetch(`${BASE}/meta.json`).then(r => { if (!r.ok) throw new Error(`meta.json ${r.status}`); return r.json(); }),
    fetch("assets/cricket-countries.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
  ]);
  // The shared country map is cricket's, which does not cover every kabaddi
  // nation. Fill the gaps so Iranian, Korean, Taipei and Polish players get a
  // flag rather than a lettered badge.
  FLAGS = {...(flags || {}), "Iran":"ir", "Korea":"kr", "Chinese Taipei":"tw",
           "Poland":"pl"};
  D = {
    players: index.map(shapePlayer),
    // One pseudo-discipline "k" so the cricket-derived helpers, which index
    // spaces by [discipline][cell], work unchanged.
    spaces: {k: Object.fromEntries(Object.entries(meta.spaces || {}).map(([c,s]) =>
      [c, {md:s.median_distance, n:s.players, mt:s.metrics}]))},
    labels: meta.labels || {}, cells: meta.cells || [],
    thinMatches: (meta.thresholds || {}).thin_matches || 12,
    halfLife: (meta.thresholds || {}).half_life_years,
    seasons: meta.seasons || [], matches: meta.matches || 0,
    validation: meta.validation || [], lowerBetter: new Set(meta.lower_is_better || []),
    source: meta.source || "", built: meta.built_at, ready: false,
  };
  renderMethod(D);
  fetch(`${BASE}/detail.json`).then(r => r.ok ? r.json() : null).then(det => {
    if (!det) return;
    DETAIL = det;
    D.players.forEach(x => {
      const rec = det[x.p] || {};
      x.pc = rec.percentile || {}; x.act = rec.actual || {};
      x.sea = rec.seasons || []; x.car = rec.career || null;
    });
    D.ready = true;
    document.body.classList.remove("loading-detail");
    if (state.sel) draw();
  }).catch(() => {});
} catch (err) {
  $("pane").innerHTML = `<div class="empty">Kabaddi data could not be loaded ` +
    `(${esc(err.message)}). If this is staging, the data job may not have run yet.</div>`;
  return;
}
document.body.classList.add("loading-detail");

const LABEL = D.labels;
const titled = s => String(s||"").replace(/\b[a-z]/g, c => c.toUpperCase());

/* A flag where there is one, a lettered badge where there is not. */
function flag(nat){
  if (!nat) return '<span class="lmark letters"></span>';
  const code = FLAGS[nat];
  if (code) return `<img class="lmark flag" src="assets/flags/${code}.svg" alt="" loading="lazy">`;
  const letters = String(nat).split(/\s+/).map(w => w[0]).join("").slice(0,2).toUpperCase();
  return `<span class="lmark letters">${letters}</span>`;
}
const norm = s => (s||"").toLowerCase().replace(/[^a-z ]/g,"");
D.players.forEach(p => p._s = norm(p.n));
const byUid = {}; D.players.forEach(p => byUid[p.u] = p);
const byId = {}; D.players.forEach(p => byId[p.p] = p);

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDate(iso){
  if (!iso) return "—";
  const [y,m,d] = String(iso).split("-");
  return d ? `${+d} ${MON[+m-1]} ${y}` : (y || "—");
}
function fmtMetric(v){
  if (v == null) return "—";
  return Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(Math.abs(v) < 10 ? 1 : 1);
}

const SERIES = ["gold","blue","green","violet","coral","mint"];
const MAX_COMPARE = 6;
const AGE_BANDS = [["any","Any"],["u23","Under 23"],["u26","Under 26"],
                   ["26-30","26–30"],["30-32","30–32"],["32+","32+"]];
const BLANK = () => ({active:false, age:"any", country:[]});
const state = {tab:"profile", sel:null, sugg:-1, compare:[], f:BLANK(),
               tz:"IST", showMore:false};

function entry(){ return state.sel ? byId[state.sel] : null; }
function ageOk(c, band){
  const a = c.a, b = band || state.f.age;
  if (b === "any") return true;
  if (!a) return false;
  if (b === "u23") return a < 23;
  if (b === "u26") return a < 26;
  if (b === "26-30") return a >= 26 && a < 30;
  if (b === "30-32") return a >= 30 && a < 32;
  return a >= 32;
}
function passes(c){
  const f = state.f;
  if (f.active && !c.playing) return false;
  if (f.country.length && !f.country.includes(c.nat)) return false;
  if (!ageOk(c)) return false;
  return true;
}

/* ── search ─────────────────────────────────────────────── */
function found(term){
  const t = norm(term); if (t.length < 2) return [];
  const out = [];
  for (const p of D.players){ if (p._s.includes(t)) out.push(p); if (out.length > 60) break; }
  return out.sort((a,b) => b.m - a.m).slice(0,8);
}
function renderSugg(term){
  const list = found(term), box = $("suggestions");
  if (!list.length){ box.hidden = true; $("search").setAttribute("aria-expanded","false"); return; }
  box.hidden = false; $("search").setAttribute("aria-expanded","true");
  box.innerHTML = list.map((p,i) => `<li role="option" data-pid="${p.p}"
      aria-selected="${i === state.sugg}">${flag(p.nat)}<span class="sug-name">${
      esc(p.n)}</span><span class="sug-meta">${esc(CELL_SHORT[p.c]||p.c)}${
      p.a ? " · " + Math.floor(p.a) : ""}</span></li>`).join("");
  box.querySelectorAll("li").forEach(li => li.onclick = () => select(li.dataset.pid));
}

function select(pid){
  state.sel = pid; state.tab = "profile"; state.compare = [];
  $("hero").hidden = true; $("workspace").hidden = false; $("clear").hidden = false;
  $("search").value = ""; $("suggestions").hidden = true;
  draw();
  if (typeof window.scrollTo === "function") window.scrollTo(0,0);
}
function toLanding(){
  state.sel = null; state.compare = []; state.tab = "profile"; state.f = BLANK();
  $("hero").hidden = false; $("workspace").hidden = true; $("clear").hidden = true;
  $("search").value = "";
  if (typeof window.scrollTo === "function") window.scrollTo(0,0);
}

/* ── player bar ─────────────────────────────────────────── */
function slRead(){ try { return JSON.parse(localStorage.getItem(SL_KEY) || "[]"); } catch { return []; } }

function playerbar(){
  const p = entry();
  if (!p){ $("playerbar").innerHTML = ""; return; }
  const saved = slRead().includes(p.u);
  const car = p.car || {};
  const facts = [
    ["Age", p.a ? Math.floor(p.a) : "—", p.nat || ""],
    ["Matches", (car.matches ?? p.m ?? 0).toLocaleString(), `since ${p.fy || "—"}`],
    ["Total points", (car.total_pts ?? 0).toLocaleString(), "raid + tackle"],
    ["Raid points", (car.raid_pts ?? 0).toLocaleString(),
      car.raids ? `${car.raids} raids` : ""],
    ["Tackle points", (car.tackle_pts ?? 0).toLocaleString(),
      car.tackles ? `${car.tackles} tackles` : ""],
  ];
  $("playerbar").innerHTML = `
    <div class="pb-id">
      ${flag(p.nat)}
      <div><h1>${esc(p.n)}</h1>
        <p class="pb-role">${esc(CELL_LABEL[p.c] || p.c)}${
          p.team ? ` · ${esc(p.team)}` : ""}</p></div>
      <span class="availability ${p.playing?"active":"gone"}">${
        p.playing ? "Currently playing" : `Last seen ${p.ly || "—"}`}</span>
    </div>
    <dl class="pb-facts">${facts.map(([k,v,sub]) =>
      `<div><dt>${esc(k)}</dt><dd>${esc(v)}${sub?`<small>${esc(sub)}</small>`:""}</dd></div>`
      ).join("")}</dl>
    <div class="pb-actions">
      <button class="ghost save${saved?" on":""}" id="save-player" aria-pressed="${saved}">
        <svg viewBox="0 0 24 24" class="btn-icon" aria-hidden="true">
          <path d="M7 4h10v16l-5-4-5 4z" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linejoin="round"/></svg><span> ${saved?"Saved":"Save to shortlist"}</span></button>
      <button class="ghost" id="go-matches">Recent matches</button>
      <button class="ghost cta" id="go-compare" ${state.compare.length ? "" : "hidden"}
        >Compare ${state.compare.length + 1} players</button>
      <button class="ghost accent" id="clear-player">
        <svg viewBox="0 0 24 24" aria-hidden="true" class="btn-icon">
          <circle cx="10.5" cy="10.5" r="6.4" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M15.4 15.4L20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>Search another player</button>
    </div>`;
  $("save-player").onclick = () => slToggle(p.u);
  const go = $("go-compare"); if (go) go.onclick = () => setTab("compare");
  $("go-matches").onclick = () => openMatchLog(p.p);
  $("clear-player").onclick = toLanding;
}

/* ── career totals ──────────────────────────────────────── */
function careerCard(p){
  const c = p.car; if (!c) return "";
  const raid = [
    ["Matches", (c.matches||0).toLocaleString()],
    ["Raid points", (c.raid_pts||0).toLocaleString()],
    ["Raids", (c.raids||0).toLocaleString()],
    ["Pts / match", c.matches ? (c.raid_pts/c.matches).toFixed(1) : "—"],
    ["Super raids", (c.super_raids||0).toLocaleString()],
    ["Super-10s", (c.super_ten||0).toLocaleString()],
    ["Do-or-die pts", (c.dod_succ||0).toLocaleString()],
  ];
  const def = [
    ["Matches", (c.matches||0).toLocaleString()],
    ["Tackle points", (c.tackle_pts||0).toLocaleString()],
    ["Tackles", (c.tackles||0).toLocaleString()],
    ["Super tackles", (c.super_tackles||0).toLocaleString()],
    ["High-5s", (c.high_five||0).toLocaleString()],
    ["Total points", (c.total_pts||0).toLocaleString()],
  ];
  const all = [
    ["Matches", (c.matches||0).toLocaleString()],
    ["Total points", (c.total_pts||0).toLocaleString()],
    ["Raid points", (c.raid_pts||0).toLocaleString()],
    ["Tackle points", (c.tackle_pts||0).toLocaleString()],
    ["Super raids", (c.super_raids||0).toLocaleString()],
    ["Super tackles", (c.super_tackles||0).toLocaleString()],
  ];
  const rows = p.c === "all-rounder" ? all : isRaider(p.c) ? raid : def;
  return `<article class="panel">
    <header class="panel-head"><h2>Career totals</h2>
      <p class="panel-sub">Every Pro Kabaddi League match — what actually happened.</p></header>
    <div class="cstats">${rows.map(([k,v]) =>
      `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</div>
  </article>`;
}

/* ── profile ────────────────────────────────────────────── */
function paneProfile(){
  const p = entry();
  if (!p) return `<div class="empty">Search a player to begin.</div>`;
  if (!D.ready) return `<div class="empty">Loading the detail for ${esc(p.n)}…</div>`;
  const sp = D.spaces.k[p.c];
  const mt = sp ? sp.mt : [];
  const radarMetrics = mt.slice(0, 8);
  const pool = sp ? sp.n : 0;
  return `<div class="profile-grid">
    <div class="profile-left">
      <article class="panel radar-panel">
        <header class="panel-head">
          <h2>Profile against role</h2>
          <p class="panel-sub">Percentile among all ${pool} ${esc(cellNoun(p.c).toLowerCase())}
            in the pool.</p>
        </header>
        <div class="radar-wrap">${radarSvg([{colour:"gold", pct:p.pc}], radarMetrics,
          LABEL, {label:`Profile for ${p.n}`})}</div>
        <p class="scale-help">Percentile = how many of those ${pool} this player beats.
          <b>50</b> is the role average, marked by the dotted ring. Higher is better on
          every axis shown.</p>
      </article>
      <article class="panel">
        <header class="panel-head"><h2>What this rests on</h2>
          <p class="panel-sub">How much kabaddi there is to judge on.</p></header>
        <div class="prov"><b>${(p.car ? p.car.matches : p.m || 0).toLocaleString()}</b> matches,
          across ${(p.ly && p.fy) ? (p.ly - p.fy + 1) : "—"} seasons
          ${p.thin
            ? `<div style="margin-top:.6rem"><b class="thin-line">Under ${D.thinMatches} matches.</b>
               Enough to place him, not enough to test against himself. Treat the score
               as a lead rather than a finding.</div>`
            : `<div style="margin-top:.6rem">Enough recent kabaddi to judge on.</div>`}</div>
      </article>
    </div>
    <div class="profile-main">
      ${careerCard(p)}
      <article class="panel">
        <header class="panel-head"><h2>Percentile detail</h2>
          <p class="panel-sub">The value is what the player actually did. The percentile
            answers how good against his own role — so for empty-raid %, where lower is
            better, a low number still ranks high.</p></header>
        <div class="radar-key">
          <div class="keyhead"><span>Metric</span><span>Value</span><span>Percentile</span></div>
          ${mt.map(m => {
            const v = p.pc[m];
            return `<div class="keyrow"><span class="k">${esc(LABEL[m]||m)}</span>
              <span class="v">${fmtMetric(p.act[m])}</span>
              <span class="p"><span class="pbar"><span style="width:${v ?? 0}%"></span></span>
              <b>${v == null ? "—" : Math.round(v)}</b></span></div>`;
          }).join("")}
        </div>
      </article>
    </div>
  </div>`;
}

/* ── similar players ────────────────────────────────────── */
function scoreAgainst(base, c){
  const sp = D.spaces.k[base.c];
  if (!sp || c.c !== base.c) return null;
  let d = 0; for (let k=0;k<base.x.length;k++){ const v=base.x[k]-c.x[k]; d+=v*v; }
  return 100 * Math.exp(-Math.LN2 * Math.sqrt(d) / sp.md);
}
function ranked(){
  const p = entry(); if (!p) return [];
  const sp = D.spaces.k[p.c]; if (!sp) return [];
  const out = [];
  for (const c of D.players){
    if (c.u === p.u || c.c !== p.c || !passes(c)) continue;
    out.push([scoreAgainst(p, c), c]);
  }
  return out.sort((a,b) => b[0]-a[0]).slice(0,12);
}
function chipsFor(a, b){
  const mt = D.spaces.k[a.c].mt;
  const rows = mt.map(m => {
    const x = a.pc[m] ?? 50, y = b.pc[m] ?? 50;
    return {m, gap:Math.abs(x-y), edge:Math.min(Math.abs(x-50), Math.abs(y-50)), x, y};
  });
  const same = rows.filter(r => r.edge > 15).sort((p,q) => p.gap - q.gap)[0]
            || [...rows].sort((p,q) => p.gap - q.gap)[0];
  const diff = [...rows].sort((p,q) => q.gap - p.gap).slice(0,2);
  const nm = m => (LABEL[m] || m).toLowerCase();
  return [{cls:"same", text:`Similar ${nm(same.m)}`, full:`Similar ${LABEL[same.m]||same.m}`},
    ...diff.map(r => ({cls: r.y > r.x ? "more" : "less",
      text:`${r.y > r.x ? "More" : "Less"} ${nm(r.m)}`,
      full:`${r.y > r.x ? "More" : "Less"} ${LABEL[r.m]||r.m}`}))];
}
function why(a, b){
  const mt = D.spaces.k[a.c].mt, shared = [], diff = [];
  for (const m of mt){
    const x = a.pc[m], y = b.pc[m]; if (x==null||y==null) continue;
    if (Math.abs(x-y) <= 12 && (x>=70||x<=30)) shared.push([Math.min(x,100-x),m,x]);
    diff.push([Math.abs(x-y), m]);
  }
  shared.sort((p,q)=>p[0]-q[0]); diff.sort((p,q)=>q[0]-p[0]);
  const s = shared[0] ? `Both ${shared[0][2]>=50?"high":"low"} for ${(LABEL[shared[0][1]]||"").toLowerCase()}`
                      : "Similar overall shape";
  return `${s} · differs on ${diff.slice(0,2).map(x=>(LABEL[x[1]]||"").toLowerCase()).join(" and ")}`;
}

function seg(label, key, opts){
  return `<div class="filter"><span class="filter-label">${esc(label)}</span>
    <div class="segmented" role="group" aria-label="${esc(label)}">${opts.map(([v,t]) =>
      `<button data-f="${key}" data-v="${v}" aria-pressed="${String(state.f[key]) === v}"
        >${esc(t)}</button>`).join("")}</div></div>`;
}
function multi(key, label, options, anyText){
  const chosen = state.f[key];
  const summary = !chosen.length ? anyText
    : chosen.length === 1 ? (options.find(o => o[0] === chosen[0]) || [,chosen[0]])[1]
    : `${chosen.length} selected`;
  return `<div class="filter multi" data-multi="${key}">
    <span class="filter-label">${esc(label)}</span>
    <button class="multi-btn${chosen.length?" on":""}" aria-expanded="false"
      >${esc(summary)}<i class="caret"></i></button>
    <div class="multi-panel" hidden>
      <input class="multi-search" type="text" placeholder="Search…" aria-label="Search ${esc(label)}">
      <div class="multi-list">${options.map(([v,t]) =>
        `<label data-t="${esc(String(t).toLowerCase())}"><input type="checkbox" value="${esc(v)}"
          ${chosen.includes(v)?"checked":""}><span>${esc(t)}</span></label>`).join("")}</div>
      <div class="multi-foot"><button class="linkish" data-clear>Clear</button>
        <button class="ghost small" data-done>Done</button></div>
    </div></div>`;
}
function wireMulti(){
  $("filters").querySelectorAll("[data-multi]").forEach(box => {
    const key = box.dataset.multi;
    const btn = box.querySelector(".multi-btn"), panel = box.querySelector(".multi-panel");
    const search = box.querySelector(".multi-search");
    btn.onclick = e => { e.stopPropagation();
      const open = panel.hidden;
      document.querySelectorAll(".multi-panel").forEach(p => p.hidden = true);
      panel.hidden = !open; btn.setAttribute("aria-expanded", String(open));
      if (open && search.focus) search.focus(); };
    search.oninput = () => { const t = search.value.toLowerCase();
      box.querySelectorAll(".multi-list label").forEach(l => l.hidden = t && !l.dataset.t.includes(t)); };
    box.querySelectorAll(".multi-list input").forEach(cb => cb.onchange = () => {
      const set = new Set(state.f[key]);
      cb.checked ? set.add(cb.value) : set.delete(cb.value);
      state.f[key] = [...set]; draw();
      const again = $("filters").querySelector(`[data-multi="${key}"] .multi-panel`);
      if (again) again.hidden = false;
    });
    box.querySelector("[data-clear]").onclick = () => { state.f[key] = []; draw(); };
    box.querySelector("[data-done]").onclick = () => { panel.hidden = true; };
  });
}
function renderFilters(){
  const countries = [...new Set(D.players.map(x => x.nat).filter(Boolean))].sort().map(c => [c,c]);
  $("filters").innerHTML =
    seg("Age", "age", AGE_BANDS) +
    multi("country", "Represents", countries, "Any country") +
    `<label class="switch"><input type="checkbox" data-chk="active" ${
      state.f.active?"checked":""}><span>Only players still playing</span></label>` +
    `<button class="linkish reset" data-reset>Reset</button>`;
  $("filters").querySelectorAll("[data-f]").forEach(b => b.onclick = () => {
    state.f[b.dataset.f] = b.dataset.v; draw(); });
  $("filters").querySelectorAll("[data-chk]").forEach(el =>
    el.onchange = e => { state.f[el.dataset.chk] = e.target.checked; draw(); });
  $("filters").querySelector("[data-reset]").onclick = () => { state.f = BLANK(); draw(); };
  wireMulti();
}
function renderResults(){
  const p = entry(); if (!p) return;
  const sp = D.spaces.k[p.c];
  const eligible = D.players.filter(c => c.u !== p.u && c.c === p.c && passes(c)).length;
  const rows = ranked();
  const full = state.compare.length >= MAX_COMPARE - 1;

  $("results-title").textContent = `Closest to ${p.n}`;
  $("results-note").textContent = isRaider(p.c)
    ? "Raid volume, success and do-or-die — how and when points come, not only how many."
    : "Tackle success, super tackles and where he holds the corner or cover.";
  $("results-count").innerHTML = rows.length
    ? `${rows.length} shown of <b>${eligible}</b> in the pool` : "";
  renderFilters();

  if (!rows.length){
    $("matches").innerHTML = ""; $("tagkey").hidden = true; $("thin").hidden = false;
    $("thin").textContent = `No ${CELL_SHORT[p.c].toLowerCase()}s match these filters. Widen the age band.`;
    return;
  }
  $("tagkey").hidden = false;
  $("thin").hidden = rows.length >= 5;
  if (rows.length < 5) $("thin").textContent = `Only ${rows.length} match these filters. Loosen one.`;
  $("tagkey").innerHTML =
    (full ? `<span class="tagkey-full">Comparison is full. Remove a player to add another.</span> ` : "")
    + `Tags compare each player with <b>${esc(p.n)}</b>: `
    + `<em class="tag same">Similar</em> a shared trait, `
    + `<em class="tag more">More</em> and <em class="tag less">Less</em> the two biggest gaps. `
    + `<span class="tagkey-add">Use <b>+</b> to add a player to the comparison.</span>`;

  const saved = slRead();
  $("matches").innerHTML = rows.map(([score, c], i) => {
    const inCmp = state.compare.includes(c.u), isSaved = saved.includes(c.u);
    const chips = chipsFor(p, c);
    const key = isRaider(c.c) ? ["Raids", (c.raids||0).toLocaleString()]
                              : ["Tackles", (c.tackles||0).toLocaleString()];
    const cells = [["Age", c.a ? Math.floor(c.a) : "—"], key,
      ["Matches", (c.m||0).toLocaleString()], ["Last season", c.ly || "—"]];
    return `<li class="match${inCmp ? " is-open" : ""}">
      <button class="match-btn" data-uid="${c.u}">
        <span class="rank">${i + 1}</span>
        <span class="score"><span class="score-num">${score.toFixed(0)}</span>
          <span class="score-track"><span style="width:${Math.min(100,score).toFixed(1)}%"></span></span></span>
        <span class="who">
          <span class="who-top">${flag(c.nat)}<b>${esc(c.n)}</b>
            ${c.playing ? "" : '<em class="gone-tag">retired</em>'}
            ${c.thin ? '<em class="thin-tag" title="Short record — treat as a lead">thin</em>' : ""}</span>
          <span class="who-sub">${esc(CELL_SHORT[c.c]||c.c)} · <b class="clubnow">${
            esc(c.nat || "—")}</b>${c.team ? ` · ${esc(c.team)}` : ""}</span>
        </span>
        <span class="facts">${cells.map(([k,v]) =>
          `<span class="meta-cell"><i>${esc(k)}</i>${esc(v)}</span>`).join("")}</span>
        <span class="why">${esc(why(p, c))}</span>
      </button>
      <span class="reads">${chips.map(x =>
        `<em class="tag ${x.cls}" title="${esc(x.full)}">${esc(x.text)}</em>`).join("")}</span>
      <span class="rowacts">
        <button class="savebtn${isSaved?" on":""}" data-save="${c.u}" aria-pressed="${isSaved}"
          title="${isSaved?"Remove from shortlist":"Save to shortlist"}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16l-5-4-5 4z"
            fill="${isSaved?"currentColor":"none"}" stroke="currentColor" stroke-width="1.8"
            stroke-linejoin="round"/></svg></button>
        <button class="addbtn${inCmp?" on":""}" data-add="${c.u}" aria-pressed="${inCmp}"
          ${!inCmp && full ? "disabled" : ""}
          title="${inCmp?"Remove from comparison":full?"Comparison is full":"Add to comparison"}"
          >${inCmp ? "&minus;" : "+"}</button>
        <button class="logbtn" data-log="${c.p}" aria-label="Recent matches" title="Recent matches">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 12h16M4 19h10"
            fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button></span>
    </li>`;
  }).join("");
  $("matches").querySelectorAll("[data-log]").forEach(b =>
    b.onclick = e => { e.stopPropagation(); openMatchLog(b.dataset.log); });
  $("matches").querySelectorAll(".match-btn").forEach(b => b.onclick = () => {
    if (!state.compare.includes(b.dataset.uid) && state.compare.length < MAX_COMPARE-1)
      state.compare.push(b.dataset.uid);
    setTab("compare");
  });
  $("matches").querySelectorAll(".addbtn").forEach(b => b.onclick = () => {
    const i = state.compare.indexOf(b.dataset.add);
    if (i >= 0) state.compare.splice(i,1);
    else if (state.compare.length < MAX_COMPARE - 1) state.compare.push(b.dataset.add);
    draw();
  });
  $("matches").querySelectorAll(".savebtn").forEach(b => b.onclick = () => slToggle(b.dataset.save));
}

/* ── compare ────────────────────────────────────────────── */
function compareSeries(){
  const p = entry();
  const out = p ? [{p, colour: SERIES[0]}] : [];
  state.compare.forEach((u,i) => {
    const c = byUid[u];
    if (c && (!p || c.u !== p.u)) out.push({p:c, colour: SERIES[(out.length) % SERIES.length]});
  });
  return out;
}
function renderCompare(){
  const series = compareSeries(), saved = slRead();
  const base = entry() || (series[0] || {}).p;
  if (!base){ $("tray").innerHTML = ""; return; }
  $("tray").innerHTML = series.map((s,i) => {
    const on = saved.includes(s.p.u);
    const sv = `<button class="traysave${on?" on":""}" data-tsave="${s.p.u}" aria-pressed="${on}"
      title="${on?"Remove from shortlist":"Save to shortlist"}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16l-5-4-5 4z"
        fill="${on?"currentColor":"none"}" stroke="currentColor" stroke-width="1.8"
        stroke-linejoin="round"/></svg></button>`;
    const sc = i === 0 ? null : scoreAgainst(base, s.p);
    return `<span class="trayitem ${s.colour}">
      <i class="swatch"></i>${flag(s.p.nat)}<b>${esc(s.p.n)}</b>
      ${i===0 && entry() ? '<span class="base-tag">searched</span>' + sv
        : `<span class="tray-score${sc==null?" na":""}" title="${sc==null
             ? `Different role (${esc(CELL_SHORT[s.p.c])} vs ${esc(CELL_SHORT[base.c])}) — scored in separate spaces`
             : `Match score against ${esc(base.n)}`}">${sc==null?"—":sc.toFixed(0)}</span>
           <button class="traybtn" data-scout="${s.p.p}">Open</button>${sv}
           <button class="dropbtn" data-drop="${s.p.u}" aria-label="Remove">&times;</button>`}
    </span>`;
  }).join("") + (state.compare.length < MAX_COMPARE-1
    ? `<span class="trayhint">or pick from <button class="linkish" data-goto="similar">Similar players</button></span>` : "");
  $("tray").querySelectorAll("[data-drop]").forEach(b => b.onclick = () => {
    state.compare = state.compare.filter(u => u !== b.dataset.drop); draw(); });
  $("tray").querySelectorAll("[data-scout]").forEach(b => b.onclick = () => select(b.dataset.scout));
  $("tray").querySelectorAll("[data-tsave]").forEach(b => b.onclick = () => slToggle(b.dataset.tsave));
  $("tray").querySelectorAll("[data-goto]").forEach(b => b.onclick = () => setTab("similar"));

  const room = MAX_COMPARE - 1 - state.compare.length;
  $("cmp-add-note").textContent = room > 0
    ? `Room for ${room} more. Anyone in the pool can be added.`
    : "The comparison is full. Remove someone to add another.";
  $("cmp-search").disabled = room <= 0;

  if (series.length < 2){
    $("compare-body").hidden = true; $("compare-empty").hidden = false;
    $("compare-empty").innerHTML = `Nothing to compare yet. Open <button class="linkish"
      data-goto2="similar">Similar players</button> and press <b>+</b> on up to ${MAX_COMPARE-1}.`;
    $("compare-empty").querySelectorAll("[data-goto2]").forEach(b => b.onclick = () => setTab("similar"));
    return;
  }
  $("compare-body").hidden = false; $("compare-empty").hidden = true;
  const mt = D.spaces.k[base.c].mt;
  const mixed = series.some(s => s.p.c !== base.c);
  $("cmp-radar-sub").textContent = mixed
    ? "Percentiles are against each player's own role, so the shapes compare roles rather than raw output."
    : `Percentile among ${D.spaces.k[base.c].n} ${cellNoun(base.c).toLowerCase()}.`;
  $("cmp-radar").innerHTML = radarSvg(series.map(s => ({colour:s.colour, pct:s.p.pc})),
    mt.slice(0,8), LABEL, {label:`Comparison of ${series.map(s=>s.p.n).join(", ")}`});
  renderCompareMetrics(series, mt);
  renderTrend(series);
}
function renderCompareMetrics(series, mt){
  const el = $("cmp-metrics");
  if (el.style && el.style.setProperty) el.style.setProperty("--cols", series.length);
  el.innerHTML = `<div class="mlegend">${series.map(s =>
      `<span class="lg"><i class="sw ${s.colour}"></i>${esc(s.p.n)}</span>`).join("")}</div>`
    + mt.map(m => {
    const vals = series.map(s => ({...s, pct:s.p.pc[m] ?? 50, val:s.p.act[m]}));
    const best = Math.max(...vals.map(v=>v.pct));
    const lo = Math.min(...vals.map(v=>v.pct)), hi = Math.max(...vals.map(v=>v.pct));
    return `<div class="mrow"><span class="mlabel">${esc(LABEL[m]||m)}</span>
      <span class="mtrack"><span class="mmid"></span>
        <span class="mspan" style="left:${lo}%;width:${(hi-lo).toFixed(1)}%"></span>
        ${vals.map(v => `<span class="mdot ${v.colour}" style="left:${v.pct}%"
          title="${esc(v.p.n)}: ${fmtMetric(v.val)} — ${Math.round(v.pct)}th percentile"></span>`).join("")}
      </span>${vals.map(v => `<span class="mv ${v.colour}${v.pct===best?" lead":""}"
        >${fmtMetric(v.val)}</span>`).join("")}</div>`;
  }).join("");
}
function renderTrend(series){
  // Points per match by season, so a long season does not just look bigger.
  const ppm = r => r.matches ? r.total_pts / r.matches : null;
  const years = [...new Set(series.flatMap(s => (s.p.sea||[])
    .filter(r => r.year != null).map(r => r.year)))].sort((a,b)=>a-b);
  const lines = series.map(s => {
    const map = new Map((s.p.sea||[]).filter(r => r.year != null).map(r => [r.year, r]));
    return {...s, points: years.map(y => map.get(y) || null)};
  });
  const vals = lines.flatMap(l => l.points.filter(Boolean).map(ppm)).filter(v => v != null);
  if (!years.length || !vals.length){
    $("cmp-trend").innerHTML = `<p class="cmp-add-note">No season-by-season record.</p>`;
    $("cmp-trend-sub").textContent = ""; return;
  }
  $("cmp-trend-sub").textContent = "Total points per match, by season.";
  const top = Math.max(...vals) * 1.1, bottom = 0;
  const W=700,H=250,padL=52,padR=22,padT=18,padB=46;
  const x = i => padL + (i*(W-padL-padR))/Math.max(1, years.length-1);
  const y = v => H-padB - ((v-bottom)/(top-bottom||1))*(H-padT-padB);
  const grid = [0,.25,.5,.75,1].map(f => {
    const v = bottom + (top-bottom)*f;
    return `<line class="tgrid" x1="${padL}" x2="${W-padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
      <text class="taxis" x="${padL-8}" y="${(y(v)+3.5).toFixed(1)}" text-anchor="end">${v.toFixed(0)}</text>`;
  }).join("");
  const paths = lines.map(l => {
    const chunks=[]; let cur=[];
    l.points.forEach((d,i)=>{ const v = d?ppm(d):null;
      if(v!=null) cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      else { if(cur.length) chunks.push(cur); cur=[]; } });
    if (cur.length) chunks.push(cur);
    const dots = l.points.map((d,i)=> { const v = d?ppm(d):null; return v==null ? "" :
      `<circle class="tdot ${l.colour}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.6">
        <title>${esc(l.p.n)} — ${years[i]}: ${v.toFixed(1)} pts/match from ${d.matches} matches</title></circle>`; }).join("");
    return `<g class="tline ${l.colour}">${chunks.map(c=>`<polyline points="${c.join(" ")}"/>`).join("")}</g>${dots}`;
  }).join("");
  const xl = years.map((sn,i) => `<text class="taxis" x="${x(i).toFixed(1)}" y="${H-padB+18}"
    text-anchor="${i===0?"start":i===years.length-1?"end":"middle"}">${esc(sn)}</text>`).join("");
  $("cmp-trend").innerHTML = `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Form by season">
    ${grid}${paths}${xl}
    <text class="taxis title" transform="translate(13,${((H-padB+padT)/2).toFixed(1)}) rotate(-90)"
      text-anchor="middle">Pts / match</text>
    <text class="taxis title" x="${(W+padL-padR)/2}" y="${H-6}" text-anchor="middle">Season</text>
  </svg><div class="tlegend">${series.map(s =>
    `<span class="lg"><i class="sw ${s.colour}"></i>${esc(s.p.n)}</span>`).join("")}</div>`;
}

/* ── match log modal ────────────────────────────────────── */
let matchLogCache = {}, mlogScrollY = 0;
async function openMatchLog(pid){
  const p = byId[pid]; if (!p) return;
  const back = document.getElementById("mlog") || (() => {
    const d = document.createElement("div"); d.id = "mlog"; d.className = "mlog-back";
    document.body.appendChild(d);
    d.addEventListener("click", e => { if (e.target === d) closeMatchLog(); });
    return d;
  })();
  mlogScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.style.top = `-${mlogScrollY}px`;
  document.body.classList.add("mlog-open");
  back.innerHTML = `<div class="mlog" role="dialog" aria-modal="true" aria-label="Match log">
    <div class="mlog-body"><p class="mlog-loading">Loading ${esc(p.n)}'s matches…</p></div></div>`;
  let data = matchLogCache[pid];
  if (!data){
    try { const r = await fetch(`${BASE}/matches/${pid}.json`); data = r.ok ? await r.json() : {matches:[]}; }
    catch { data = {matches:[]}; }
    matchLogCache[pid] = data;
  }
  if (document.getElementById("mlog")) drawMatchLog(p, data.matches || []);
}
function closeMatchLog(){
  document.body.classList.remove("mlog-open"); document.body.style.top = "";
  if (typeof window.scrollTo === "function") window.scrollTo(0, mlogScrollY || 0);
  const d = document.getElementById("mlog"); if (d) d.remove();
}
function drawMatchLog(p, rows){
  const dash = '<span class="mdash">—</span>';
  const car = p.car || {};
  const statFig = [
    ["Matches", rows.length],
    ["Total pts", (car.total_pts ?? 0).toLocaleString()],
    ["Raid pts", (car.raid_pts ?? 0).toLocaleString()],
    ["Tackle pts", (car.tackle_pts ?? 0).toLocaleString()],
  ];
  const head = `<tr><th>Date</th><th>Season</th><th class="l">Match</th>
    <th>Raid pts</th><th>R</th><th>Succ</th><th>Tackle pts</th><th>T</th><th>Succ</th><th>Total</th></tr>`;
  const body = rows.map(m => {
    const big = m.total_pts >= 10, super10 = m.super10, high5 = m.high5;
    return `<tr>
      <td class="nowrap">${fmtDate(m.date)}</td>
      <td><span class="fmt-pill">S${esc(m.season)}</span></td>
      <td class="l match-cell">
        <span class="fx-for">${flag(natFor(m.team))}<b>${esc(m.team || "—")}</b></span>
        <span class="fx-opp">${flag(natFor(m.opp))}<span>${esc(m.opp || "—")}</span></span></td>
      <td><b class="${super10?"mile-5w":""}">${m.raid_pts || 0}</b></td>
      <td>${m.raids || 0}</td><td>${m.raids_succ || 0}</td>
      <td><b class="${high5?"mile-5w":""}">${m.tackle_pts || 0}</b></td>
      <td>${m.tackles || 0}</td><td>${m.tackles_succ || 0}</td>
      <td><b class="${big?"mile-50":""}">${m.total_pts || 0}</b></td>
    </tr>`;
  }).join("");
  const header = `<div class="mlog-head">
    <button class="mlog-x" aria-label="Close">&times;</button>
    <div class="mlog-top">
      <div class="mlog-id">${flag(p.nat)}
        <div><h2>${esc(p.n)}</h2>
          <p>${esc(CELL_LABEL[p.c]||p.c)}${p.nat ? ` · ${esc(p.nat)}` : ""}</p></div>
      </div>
      <button class="ghost accent mlog-profile">Open full profile</button>
    </div>
    <dl class="mlog-stats">${statFig.map(([k,v]) =>
      `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
  </div>`;
  const el = document.querySelector("#mlog .mlog-body");
  el.innerHTML = rows.length
    ? header + `<div class="mlog-scroll"><table class="mlog-table">
        <thead>${head}</thead><tbody>${body}</tbody></table></div>`
    : header + `<p class="mlog-loading">No match-by-match record yet.</p>`;
  const pb = document.querySelector("#mlog .mlog-profile");
  if (pb) pb.onclick = () => { closeMatchLog(); select(p.p); };
  const xb = document.querySelector("#mlog .mlog-x");
  if (xb) xb.onclick = closeMatchLog;
}
function natFor(team){ return FLAGS[team] ? team : (team || null); }

/* ── radar, lifted from cricket/football ─────────────────── */
const isNarrow = () => (typeof window.matchMedia === "function"
  ? window.matchMedia("(max-width: 680px)").matches : window.innerWidth <= 680);
function wrapLabel(text){
  const words = String(text).split(" ");
  if (words.length < 3) return [text];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}
function radarSvg(series, metrics, labels, opts = {}){
  const compact = isNarrow();
  const pad = compact ? 96 : 62;
  const size = 300, cx = 150, cy = 150, r = compact ? 88 : 100, n = metrics.length;
  const angle = i => (Math.PI * 2 * i) / n - Math.PI / 2;
  const at = (i,f) => [cx + Math.cos(angle(i)) * r * f, cy + Math.sin(angle(i)) * r * f];
  const pts = get => metrics.map((m,i) =>
    at(i, Math.max(0.04, (get(m) ?? 0) / 100)).map(v => v.toFixed(1)).join(",")).join(" ");
  const rings = [0.25,0.5,0.75,1].map(f => {
    const cls = f === 1 ? " outer" : f === 0.5 ? " median" : "";
    return `<polygon class="radar-ring${cls}" points="${
      metrics.map((_,i) => at(i,f).map(v => v.toFixed(1)).join(",")).join(" ")}"/>`;
  }).join("") + [[1,"100"],[0.5,"50"]].map(([f,t]) =>
    `<text class="radar-tick" x="${cx+3}" y="${(cy-r*f+3).toFixed(1)}">${t}</text>`).join("");
  const spokes = metrics.map((_,i) => {
    const [x,y] = at(i,1);
    return `<line class="radar-spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
  }).join("");
  const shapes = series.map((s,k) =>
    `<polygon class="radar-area ${s.colour}${series.length>1&&k>0?" line":""}"
      points="${pts(m => s.pct[m])}"/>`).join("");
  const text = metrics.map((m,i) => {
    const ang = angle(i);
    const [lx,ly] = [cx + Math.cos(ang)*(r+(compact?24:30)), cy + Math.sin(ang)*(r+(compact?24:30))];
    const anchor = Math.abs(Math.cos(ang)) < .25 ? "middle" : Math.cos(ang) > 0 ? "start" : "end";
    const words = wrapLabel(labels[m] || m);
    const lines = words.map((w,k) =>
      `<tspan x="${lx.toFixed(1)}" dy="${k===0?0:10}">${esc(w)}</tspan>`).join("");
    const vals = series.map(s => `<tspan class="p-${s.colour}">${Math.round(s.pct[m] ?? 0)}</tspan>`)
      .join('<tspan class="ps">/</tspan>');
    return `<text class="radar-label" x="${lx.toFixed(1)}" y="${(ly-5).toFixed(1)}"
      text-anchor="${anchor}">${lines}</text>
      <text class="radar-pair" x="${lx.toFixed(1)}"
      y="${(ly+8+(words.length-1)*10).toFixed(1)}" text-anchor="${anchor}">${vals}</text>`;
  }).join("");
  return `<svg viewBox="${-pad} -26 ${size+pad*2} ${size+52}" role="img"
    aria-label="${esc(opts.label || "Percentile profile")}">${rings}${spokes}${shapes}${text}</svg>`;
}

/* ── tabs & draw ────────────────────────────────────────── */
function setTab(t){ state.tab = t; draw(); }
function draw(){
  const canCompare = state.compare.length >= 1 && entry() || state.compare.length >= 2;
  if (state.tab === "compare" && !canCompare) state.tab = "profile";
  $("ccount").textContent = state.compare.length
    ? ` (${state.compare.length + (entry() ? 1 : 0)})` : "";
  document.querySelectorAll('#tabs [data-tab="compare"]').forEach(b => b.disabled = !canCompare);
  ["profile","similar","compare"].forEach(t => {
    $("panel-" + t).hidden = state.tab !== t;
    document.querySelectorAll(`#tabs [data-tab="${t}"]`).forEach(b =>
      b.setAttribute("aria-selected", String(state.tab === t)));
  });
  playerbar();
  if (state.tab === "profile") $("pane").innerHTML = paneProfile();
  else if (state.tab === "similar") renderResults();
  else renderCompare();
}

$("search").addEventListener("input", e => { state.sugg = -1; renderSugg(e.target.value); });
$("search").addEventListener("keydown", e => {
  const box = $("suggestions"); if (box.hidden) return;
  const n = box.querySelectorAll("li").length;
  if (e.key === "ArrowDown"){ state.sugg = Math.min(n-1, state.sugg+1); e.preventDefault(); }
  else if (e.key === "ArrowUp"){ state.sugg = Math.max(0, state.sugg-1); e.preventDefault(); }
  else if (e.key === "Enter"){ const b = box.querySelectorAll("li")[Math.max(0,state.sugg)]; if (b) b.click(); return; }
  else if (e.key === "Escape"){ box.hidden = true; return; } else return;
  renderSugg($("search").value);
});
document.addEventListener("click", e => {
  if (!e.target.closest(".finder")) $("suggestions").hidden = true;
  if (!e.target.closest(".multi")) document.querySelectorAll(".multi-panel").forEach(p => p.hidden = true);
  if (!e.target.closest(".cmp-add")) $("cmp-suggestions").hidden = true;
});
document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => setTab(b.dataset.tab));
$("clear").onclick = toLanding;
$("brand").onclick = e => { e.preventDefault(); toLanding(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") closeMatchLog(); });

let cmpSel = -1;
$("cmp-search").addEventListener("input", e => {
  const box = $("cmp-suggestions"), base = entry();
  const list = found(e.target.value).filter(x => x.p !== (base && base.p));
  if (!list.length){ box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = list.map((x,i) => `<li role="option" data-uid="${x.u}"
    aria-selected="${i===cmpSel}">${flag(x.nat)}<span class="sug-name">${esc(x.n)}</span>
    <span class="sug-meta">${esc(CELL_SHORT[x.c]||x.c)}${x.a?" · "+Math.floor(x.a):""}</span></li>`).join("");
  box.querySelectorAll("li").forEach(li => li.onclick = () => {
    const u = li.dataset.uid;
    if (!state.compare.includes(u) && state.compare.length < MAX_COMPARE - 1) state.compare.push(u);
    $("cmp-search").value = ""; box.hidden = true; draw();
  });
});

/* ── sport switcher ─────────────────────────────────────── */
const SPORTS = (window.PS_CHANNEL && window.PS_CHANNEL.sports) || [
  {id:"football", name:"Football", status:"live"},
  {id:"cricket",  name:"Cricket",  status:"live"},
  {id:"kabaddi",  name:"Kabaddi",  status:"live"},
];
$("sports").innerHTML = SPORTS.map(s => {
  if (s.id === "kabaddi")
    return `<button class="sport" type="button" aria-current="true">${esc(s.name)}</button>`;
  if (s.status !== "live")
    return `<button class="sport" type="button" disabled aria-current="false">${esc(s.name)}</button>`;
  return `<a class="sport" href="${esc(s.id === "football" ? "index" : s.id)}.html"
     aria-current="false">${esc(s.name)}</a>`;
}).join("");

/* ── shortlist ──────────────────────────────────────────── */
const SL_KEY = `ps.${(window.PS_CHANNEL||{}).channel || "prod"}.kabaddi.shortlist`;
function slWrite(v){ try { localStorage.setItem(SL_KEY, JSON.stringify(v)); } catch {} }
function slToggle(uid){
  const l = slRead(), i = l.indexOf(uid);
  if (i >= 0) l.splice(i,1); else l.push(uid);
  slWrite(l); renderShortlist(); draw();
}
function renderShortlist(){
  const l = slRead().map(u => byUid[u]).filter(Boolean);
  const btn = $("short-btn"); btn.disabled = false; btn.classList.toggle("has", l.length > 0);
  btn.querySelector("span").textContent = l.length ? `Shortlist ${l.length}` : "Shortlist";
  $("short-list").innerHTML = l.length
    ? l.map(x => `<li>
        <button class="short-open" data-open="${x.p}">${flag(x.nat)}
          <span><b>${esc(x.n)}</b><em>${esc(CELL_SHORT[x.c]||x.c)}${x.nat?` · ${esc(x.nat)}`:""}${
            x.a?` · ${Math.floor(x.a)}`:""}</em></span></button>
        <button class="dropbtn" data-unsave="${x.u}" aria-label="Remove">&times;</button></li>`).join("")
    : `<li class="short-empty">Nothing saved yet. Open a player and use <b>Save to shortlist</b>.</li>`;
  $("short-panel").querySelectorAll("[data-open]").forEach(b =>
    b.onclick = () => { $("short-panel").hidden = true; select(b.dataset.open); });
  $("sl-clear").hidden = !l.length;
  $("sl-clear").onclick = () => { slWrite([]); renderShortlist(); draw(); };
  $("short-panel").querySelectorAll("[data-unsave]").forEach(b => b.onclick = () => slToggle(b.dataset.unsave));
  $("short-btn").onclick = () => {
    const panel = $("short-panel"), open = panel.hidden;
    panel.hidden = !open; $("short-btn").setAttribute("aria-expanded", String(open));
    $("fresh-panel").hidden = true;
  };
  $("sl-export").hidden = !l.length;
  $("sl-export").onclick = () => exportCsv(l, "kabaddi-shortlist");
}
function exportCsv(list, stem){
  if (!list.length) return;
  const head = ["name","country","cell","position","subrole","age","matches","raids","tackles",
    "total_points","raid_points","tackle_points","first_season","last_season","still_playing"];
  const rows = list.map(x => { const c = x.car || {};
    return [x.n, x.nat||"", x.c, x.pos||"", x.sub||"", x.a?Math.floor(x.a):"", c.matches??x.m??"",
      c.raids??x.raids??"", c.tackles??x.tackles??"", c.total_pts??"", c.raid_pts??"", c.tackle_pts??"",
      x.fy||"", x.ly||"", x.playing?"yes":"no"]; });
  const csv = "﻿" + [head, ...rows].map(r =>
    r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv;charset=utf-8"}));
  a.download = `${stem}-${new Date().toISOString().slice(0,10)}.csv`; a.click();
}

/* ── landing ────────────────────────────────────────────── */
const PICKS = ["Pardeep Narwal","Fazel Atrachali","Pawan Kumar Sehrawat",
               "Deepak Niwas Hooda","Maninder Singh"];
$("examples").innerHTML = PICKS.map(n => {
  const p = D.players.find(x => x.n === n) || D.players.find(x => (x.n||"").includes(n.split(" ")[0]));
  return p ? `<button class="pick" data-pid="${p.p}">${flag(p.nat)}${esc(p.n)}</button>` : "";
}).join("");
document.querySelectorAll(".pick").forEach(b => b.onclick = () => select(b.dataset.pid));

$("bigstats").innerHTML = [
  [D.players.length.toLocaleString(), "players"],
  [D.players.filter(p => p.playing).length.toLocaleString(), "still playing"],
  [D.seasons.length, "seasons"],
].map(([v,k]) => `<div><b>${v}</b><span>${esc(k)}</span></div>`).join("");

const cellCount = {};
D.players.forEach(p => cellCount[p.c] = (cellCount[p.c]||0) + 1);
const CELLS = Object.keys(cellCount).sort((a,b) => cellCount[b]-cellCount[a]);
const topCell = Math.max(1, ...CELLS.map(c => cellCount[c]));
$("rolebars").innerHTML = `<h3>Players by role</h3>` + CELLS.map(c =>
  `<div class="posrow"><span>${esc(CELL_LABEL[c]||c)}</span>
    <span class="postrack"><span style="width:${(cellCount[c]/topCell*100).toFixed(1)}%"></span></span>
    <b>${cellCount[c]}</b></div>`).join("");

/* ── freshness ──────────────────────────────────────────── */
const TZ_KEY = `ps.${(window.PS_CHANNEL||{}).channel || "prod"}.tz`;
try { state.tz = localStorage.getItem(TZ_KEY) || "IST"; } catch { state.tz = "IST"; }
function fmtStamp(iso, tz){
  if (!iso) return null;
  const d = new Date(iso); if (isNaN(d)) return null;
  return d.toLocaleString("en-GB", { timeZone: tz === "UTC" ? "UTC" : "Asia/Kolkata",
    day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit", hour12:false })
    .replace(",", "") + ` ${tz}`;
}
function sinceText(iso, tz){
  const zone = tz === "UTC" ? "UTC" : "Asia/Kolkata";
  const dayIn = d => { const p = new Intl.DateTimeFormat("en-CA", {timeZone: zone,
      year:"numeric", month:"2-digit", day:"numeric"}).format(d);
    return Date.UTC(+p.slice(0,4), +p.slice(5,7)-1, +p.slice(8,10)); };
  const days = Math.round((dayIn(new Date()) - dayIn(new Date(iso))) / 864e5);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}
function renderFreshness(){
  if (!D.built) return;
  const tz = state.tz;
  $("fresh-label").textContent = `Updated ${sinceText(D.built, tz)}`;
  $("fresh-btn").title = fmtStamp(D.built, tz) || "";
  const metrics = new Set(Object.values(D.spaces.k).flatMap(s => s.mt)).size;
  const rows = [
    ["Model run", fmtStamp(D.built, tz), sinceText(D.built, tz),
     `${D.players.length.toLocaleString()} players scored across ${metrics} metrics`],
    ["Coverage", `${D.seasons.length} seasons`, "",
     `${D.matches.toLocaleString()} Pro Kabaddi League matches`],
  ];
  $("fresh-list").innerHTML = rows.map(([k, when, ago, note]) => `<li>
    <span class="fl-title">${esc(k)}</span><span class="fl-when">${esc(when || "—")}</span>
    ${ago ? `<span class="fl-since">${esc(ago)}</span>` : "<span></span>"}
    <span class="fl-note">${esc(note)}</span></li>`).join("");
  $("fresh-foot").textContent = "Rebuilt from Pro Kabaddi League Official Data.";
  document.querySelectorAll("[data-tz]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tz === tz)));
}
renderFreshness();
$("fresh-btn").onclick = () => {
  const panel = $("fresh-panel"), open = panel.hidden;
  panel.hidden = !open; $("fresh-btn").setAttribute("aria-expanded", String(open));
  $("short-panel").hidden = true;
};
document.querySelectorAll("[data-tz]").forEach(b => b.onclick = () => {
  state.tz = b.dataset.tz; try { localStorage.setItem(TZ_KEY, state.tz); } catch {}
  renderFreshness();
});
document.addEventListener("click", e => {
  if (!e.target.closest(".freshness")) $("fresh-panel").hidden = true;
  if (!e.target.closest(".shortlist-wrap")) $("short-panel").hidden = true;
});

$("attrib").innerHTML = `Data from <b>Pro Kabaddi League Official Data</b>.
  ${D.matches.toLocaleString()} matches across ${D.seasons.length} seasons.`;

/* ── method strip: fill the four columns from the loaded meta ───────────────
   These were static numbers in the HTML and had already drifted — the match
   count read 1,258 when the pool had grown past 1,300, and the role column left
   out all-rounders entirely. Everything here now comes from meta, so the strip
   stays true as seasons are added, the way football's and cricket's do. */
function ord(n){ const s = ["th", "st", "nd", "rd"], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0]; }

function renderMethod(D){
  const cols = document.querySelectorAll(".method .mcol");
  if (cols.length < 4) return;
  const num = x => (x == null ? "—" : Number(x).toLocaleString());
  const K = (D.spaces || {}).k || {};

  cols[0].innerHTML = `<h3>Where it comes from</h3>
    <div class="mfig"><b>${num(D.matches)}</b><span>Pro Kabaddi League matches</span></div>
    <div class="mfig"><b>${(D.seasons || []).length}</b><span>seasons, every raid and tackle</span></div>
    <p>Pro Kabaddi League Official Data — the scorecard and the raid-by-raid event
    stream of every match, joined on the league's own player ids. No name matching
    anywhere.</p>`;

  const mx = Math.max(0, ...Object.values(K).map(s => (s.mt || []).length)) || 8;
  const hl = D.halfLife ? ((+D.halfLife % 1)
      ? (+D.halfLife).toFixed(1) : (+D.halfLife | 0)) + " yrs" : "3 yrs";
  cols[1].innerHTML = `<h3>What a player is measured on</h3>
    <div class="mfig"><b>${mx}</b><span>metrics per role</span></div>
    <div class="mfig"><b>${hl}</b><span>before form counts half</span></div>
    <p>Not just points, but how they come — success rate, super raids, and the
    do-or-die raid a raider must convert or is out. Recent seasons count for more,
    and a player with a short record is treated cautiously rather than taken at
    face value.</p>`;

  const roles = Object.entries(K).map(([c, s]) => [c, s.n || 0]).sort((a, b) => b[1] - a[1]);
  const max = roles.length ? roles[0][1] : 1;
  const bars = roles.map(([c, n]) => `<div class="mfact"><span>${esc(CELL_SHORT[c] || c)}</span>
    <span class="mbar"><i style="width:${Math.max(10, Math.round(n / max * 100))}%"></i></span><b>${n}</b></div>`).join("");
  cols[2].innerHTML = `<h3>Compared within a role</h3>${bars}
    <p>A raider and a cover defender play different games, so each role is a
    separate space. A player is only ever ranked against their own.</p>`;

  const V = (D.validation || []).filter(v => v.players && v.median_rank && v.chance_median_rank);
  if (V.length){
    const v = V.slice().sort((a, b) => b.players - a.players)[0];
    const med = Math.round(v.median_rank), ch = Math.round(v.chance_median_rank);
    const role = (CELL_LABEL[v.cell] || v.cell).toLowerCase();
    cols[3].innerHTML = `<h3>Does it work</h3>
      <div class="mfig"><b>${(v.chance_median_rank / v.median_rank).toFixed(1)}&times;</b><span>better than guessing</span></div>
      <div class="mfact"><span>This tool</span><span class="mbar"><i class="good" style="width:${Math.max(10, Math.round(100 - med / ch * 50))}%"></i></span><b>${med}${ord(med)}</b></div>
      <div class="mfact"><span>Guessing</span><span class="mbar"><i class="dim" style="width:50%"></i></span><b>${ch}${ord(ch)}</b></div>
      <p>Take one ${esc(role)}, split their matches in half, and hide from the tool
      that the halves are the same player. Asked to rank everyone against the first
      half, it puts their own second half around ${med}${ord(med)} of ${v.players} —
      random would be ${ch}${ord(ch)}.</p>`;
  }
}

/* ── method strip ───────────────────────────────────────
   Below 980px the four columns become a swipeable strip with a pill nav, as
   football and cricket do. */
(function methodNav(){
  const nav = $("method-nav");
  const cols = [...document.querySelectorAll(".method .mcol")];
  const strip = document.querySelector(".method");
  if (!nav || !cols.length || !strip) return;
  const SHORT = ["Sources", "Measured on", "By role", "Does it work"];
  nav.innerHTML = cols.map((c, i) =>
    `<button role="tab" data-step="${i}" aria-selected="${i === 0}">
      <i>${i + 1}</i>${esc(SHORT[i] || ((c.querySelector("h3") || {}).textContent || ""))}</button>`
    ).join("");
  const mark = i => nav.querySelectorAll("button").forEach((b, k) =>
    b.setAttribute("aria-selected", String(k === i)));
  nav.querySelectorAll("button").forEach(b => b.onclick = () => {
    const i = +b.dataset.step;
    const left = cols[i].offsetLeft - strip.offsetLeft;
    if (typeof strip.scrollTo === "function"){
      try { strip.scrollTo({left, behavior: "smooth"}); } catch { strip.scrollLeft = left; }
    } else strip.scrollLeft = left;
    mark(i);
  });
  let tick;
  strip.addEventListener("scroll", () => {
    clearTimeout(tick);
    tick = setTimeout(() => {
      const i = Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth));
      mark(Math.min(Math.max(i, 0), cols.length - 1));
    }, 90);
  }, {passive: true});
  mark(0);
})();

renderShortlist();
})();
