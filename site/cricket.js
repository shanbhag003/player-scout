/* Cricket. A separate page from football on purpose: the two share the shell,
   the stylesheet and the switcher, but not a code path. app.js is sixty-eight
   kilobytes of working, validated football logic and a second sport has no
   business reaching into it.

   The look is not re-invented here. This page loads football's style.css and
   cricket.css only adds what is genuinely new, so the two sports cannot drift
   apart by accident. */
(async function(){
const $ = id => document.getElementById(id);
const BASE = "data/cricket";
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

let D, FLAGS = {}, DETAIL = null;

/* Loaded in two passes. index.json is 1.5 MB and holds everything the landing
   and the search need; detail.json is 3.6 MB and is only wanted once a player is
   opened. Waiting for both left the page blank for the whole download, which is
   what made switching sports feel like a stall. */
function shapePlayer(e, d){
  d = d || {};
  return {u:e.uid, p:e.player_id, n:e.name, f:e.full_name, d:e.discipline,
    c:e.cell, r:e.role, x:e.coords, b:e.balls, eb:e.effective_balls, m:e.matches,
    a:e.age, nat:e.nationality, e:e.exposure, tb:e.tier_balls||{},
    cb:e.competition_balls||{}, kp:!!e.keeper, playing:e.active,
    partial:!!e.partial_record, thin:!!e.thin,
    ls:e.last_seen, fs:e.first_seen,
    pc:d.percentile||{}, ad:d.adjusted||{}, sea:d.seasons||[],
    car:null, ci:null};
}

try {
  const [index, meta, flags] = await Promise.all([
    fetch(`${BASE}/index.json`).then(r => { if (!r.ok) throw new Error(`index.json ${r.status}`); return r.json(); }),
    fetch(`${BASE}/meta.json`).then(r => { if (!r.ok) throw new Error(`meta.json ${r.status}`); return r.json(); }),
    fetch("assets/cricket-countries.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
  ]);
  FLAGS = flags || {};
  D = {
    players: index.map(e => shapePlayer(e, null)),
    spaces: Object.fromEntries(Object.entries(meta.spaces).map(([k,v]) =>
      [k, Object.fromEntries(Object.entries(v).map(([c,s]) =>
        [c, {md:s.median_distance, n:s.players, mt:s.metrics}]))])),
    minSeasonBalls: (meta.thresholds || {}).min_season_balls || 60,
    thinBalls: (meta.thresholds || {}).thin_balls || 300,
    withheld: meta.withheld, comps: meta.competitions,
    compNames: meta.competition_names || {},
    compNotes: meta.competition_notes || {}, matches: meta.matches,
    built: meta.built_at, ready: false,
  };
  // The detail arrives behind the first paint and is merged in place.
  fetch(`${BASE}/detail.json`).then(r => r.ok ? r.json() : null).then(det => {
    if (!det) return;
    DETAIL = det;
    D.players.forEach(x => {
      const rec = det[x.p] || {};
      const d = rec[x.d] || {};
      x.pc = d.percentile || {}; x.ad = d.adjusted || {}; x.act = d.actual || {};
      x.sea = d.seasons || [];
      x.car = (rec.career || {})[x.d] || null; x.ci = rec.cricinfo || null;
    });
    D.ready = true;
    document.body.classList.remove("loading-detail");
    if (state.sel || state.shape) draw();
  }).catch(() => {});
} catch (err) {
  $("pane").innerHTML = `<div class="empty">Cricket data could not be loaded ` +
    `(${esc(err.message)}). If this is staging, the daily job may not have run yet.</div>`;
  return;
}
document.body.classList.add("loading-detail");

/* A flag where there is one, a lettered badge where there is not. West Indies
   and an ICC XI are teams rather than countries and have no ISO code. */
function flag(nat){
  if (!nat) return '<span class="lmark letters"></span>';
  const code = FLAGS[nat];
  if (code) return `<img class="lmark flag" src="assets/flags/${code}.svg" alt="" loading="lazy">`;
  const letters = String(nat).split(/\s+/).map(w => w[0]).join("").slice(0,2).toUpperCase();
  return `<span class="lmark letters">${letters}</span>`;
}


const LABEL = {
  sr:"Strike rate", bpd:"Balls per out", bdry:"Boundary %", six_share:"Six share",
  dot_pct:"Dot %", sr_pp:"SR powerplay", sr_mid:"SR middle", sr_death:"SR death",
  sh_pp:"Balls in PP %", sh_death:"Balls at death %", sr_pace:"SR v pace",
  sr_spin:"SR v spin", spin_bias:"Spin bias", sr_first10:"SR first 10",
  accel:"Acceleration", bdry_spin:"Boundary % v spin",
  econ:"Economy", wkt_rate:"Wickets/100", dot_rate:"Dot %", bdry_conc:"Boundary % conceded",
  six_share_conc:"Six share conceded", econ_pp:"Econ powerplay", econ_mid:"Econ middle",
  econ_death:"Econ death", wide_rate:"Wides/100"};
const LOWER_BETTER = new Set(["dot_pct","econ","econ_pp","econ_mid","econ_death",
  "bdry_conc","six_share_conc","wide_rate"]);
const EXPOSURE = {domestic:"Uncapped", franchise:"Franchise",
  international_minor:"Associate Int'l", international_established:"Associate Int'l",
  international_full:"International"};
/* Roles are derived lowercase in the pipeline; they are proper labels on screen. */
const titled = s => String(s||"").replace(/\b[a-z]/g, c => c.toUpperCase());
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
/* "2019-02" is not a date anyone reads. */
function whenSeen(iso){
  if (!iso) return "—";
  const [y,m] = String(iso).split("-");
  return m ? `${MON[+m - 1]} ${y}` : y;
}
const BLANK = () => ({active:true, exposure:"any", age:"any", minBalls:0,
  country:[], comp:[], keeper:false});
const state = {mode:"explore", tab:"profile", sel:null, disc:"batting", sugg:-1,
  compare:[], showMore:false, career:"total", f:BLANK(),
  shape:null, limit:25, metricView:"actual", tz:"IST",
  wiz:{disc:null, cell:null, age:"any", exposure:"any", comps:[], countries:[], active:true}};

const norm = s => (s||"").toLowerCase().replace(/[^a-z ]/g,"");
// Search across the scorecard name, the full name and every spelling the
// archive knows. "Sachin" is not in "SR Tendulkar", and nobody types initials.
D.players.forEach(p => p._s = norm(p.n) + " " + norm(p.f) + " " + norm(p.aka));
const byPlayer = {}, byUid = {};
D.players.forEach(p => { (byPlayer[p.p] = byPlayer[p.p]||[]).push(p); byUid[p.u]=p; });
const COUNTRIES = [...new Set(D.players.map(p=>p.nat).filter(Boolean))].sort();
const CLUBCOMPS = D.comps.filter(c => !c.startsWith("international"));

function found(term){
  const t=norm(term); if(t.length<2) return [];
  const seen=new Set(), out=[];
  for(const p of D.players){ if(seen.has(p.p)||!p._s.includes(t)) continue;
    seen.add(p.p); out.push(p); if(out.length>50) break; }
  return out.sort((a,b)=>b.m-a.m).slice(0,8);
}
function renderSugg(term){
  const list = found(term), box = $("suggestions");
  if (!list.length){
    box.hidden = true; $("search").setAttribute("aria-expanded","false"); return;
  }
  box.hidden = false; $("search").setAttribute("aria-expanded","true");
  // Football's exact row: a list item, never a button. A bare <button> here
  // keeps its browser-default styling and renders as a white bar, which is what
  // the search looked like for three rounds.
  box.innerHTML = list.map((p,i) => `<li role="option" data-pid="${p.p}"
      aria-selected="${i === state.sugg}">${flag(p.nat)}<span class="sug-name">${
      esc(p.f || p.n)}</span><span class="sug-meta">${
      esc(titled(p.r || p.c))}${p.a ? " · " + Math.floor(p.a) : ""}</span></li>`).join("");
  box.querySelectorAll("li").forEach(li => li.onclick = () => select(li.dataset.pid));
}


/* ── match log modal ─────────────────────────────────────
   Fetches one player's innings on demand from matches/<id>.json — a small file
   per player, so nothing pool-sized is ever loaded. Columns follow the player's
   role: a batter's bowling columns do not appear if he never bowled, and vice
   versa. Anything a player did not do in a match reads "—", never "0". */
let matchLogCache = {};
let mlogScrollY = 0;

async function openMatchLog(pid){
  const p = (byPlayer[pid] || [])[0];
  if (!p) return;
  const back = document.getElementById("mlog") || (() => {
    const d = document.createElement("div");
    d.id = "mlog"; d.className = "mlog-back";
    document.body.appendChild(d);
    d.addEventListener("click", e => { if (e.target === d) closeMatchLog(); });
    return d;
  })();
  // iOS Safari ignores overflow:hidden on body, so the page scrolls behind the
  // modal. Freezing the body at its current offset is the only thing that holds.
  mlogScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.style.top = `-${mlogScrollY}px`;
  document.body.classList.add("mlog-open");
  back.innerHTML = `<div class="mlog" role="dialog" aria-modal="true" aria-label="Match log">
    <div class="mlog-body"><p class="mlog-loading">Loading ${esc(p.f||p.n)}'s matches…</p></div>
  </div>`;

  let data = matchLogCache[pid];
  if (!data){
    try {
      const r = await fetch(`${BASE}/matches/${pid}.json`);
      data = r.ok ? await r.json() : {matches: []};
    } catch { data = {matches: []}; }
    matchLogCache[pid] = data;
  }
  if (document.getElementById("mlog")) drawMatchLog(p, data.matches || []);
}
function closeMatchLog(){
  document.body.classList.remove("mlog-open");
  document.body.style.top = "";
  if (typeof window.scrollTo === "function") window.scrollTo(0, mlogScrollY || 0);
  const d = document.getElementById("mlog");
  if (d) d.remove();
}

function drawMatchLog(p, rows){
  // Which stat columns to show is the player's role, narrowed to what the rows
  // actually contain — a "batter" who never bowled shows no bowling columns.
  const anyBat = rows.some(r => r.bat), anyBowl = rows.some(r => r.bowl);
  const role = String(p.r || "").toLowerCase();
  const showBat = anyBat && !role.includes("bowler") || anyBat;   // batters + allrounders + anyone who batted
  const showBowl = anyBowl;                                       // only if they bowled at all
  const dash = '<span class="mdash">—</span>';

  const head = `<tr>
    <th>Date</th><th>Format</th><th class="l">Match</th><th>Result</th>
    ${showBat ? '<th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th><th class="l">Out</th>' : ''}
    ${showBowl ? '<th>O</th><th>R</th><th>W</th><th>Econ</th>' : ''}
  </tr>`;

  const body = rows.map(m => {
    const b = m.bat, w = m.bowl;
    const won = m.result && m.team && m.result === m.team;
    const resCls = !m.result ? "" : won ? "res-w" : (m.result === "tie" || m.result === "draw"
                     || m.result === "no result") ? "res-d" : "res-l";
    const resText = !m.result ? dash
      : m.result === m.team ? "Won"
      : (m.result === "tie") ? "Tie"
      : (m.result === "draw") ? "Draw"
      : (m.result === "no result") ? "No result" : "Lost";
    const fifty = b && b.r >= 50, hundred = b && b.r >= 100;
    const fifer = w && w.w >= 5;
    const runCell = !b ? dash
      : `<b class="${hundred ? "mile-100" : fifty ? "mile-50" : ""}">${b.r}${b.no ? "*" : ""}</b>`;
    // The asterisk on the runs already marks a not-out, so the dismissal column
    // just shows how they got out — a dash when they didn't.
    const outCell = !b ? dash : b.no ? dash : esc(dismissalText(b));
    return `<tr>
      <td class="nowrap">${fmtDate(m.date)}</td>
      <td><span class="fmt-pill">${esc(m.fmt || "")}</span></td>
      <td class="l match-cell" title="${esc(m.team || "")} v ${esc(m.opp || "")}">
        <span class="side">${flag(natFor(m.team))}<b>${esc(short(m.team))}</b></span>
        <span class="vs">v</span>
        <span class="side">${flag(natFor(m.opp))}<b>${esc(short(m.opp))}</b></span></td>
      <td><span class="res ${resCls}">${resText}</span></td>
      ${showBat ? (b
        ? `<td>${runCell}</td><td>${b.b}</td><td>${b["4"]}</td><td>${b["6"]}</td>
           <td>${b.sr ?? dash}</td><td class="l">${outCell}</td>`
        : `<td>${dash}</td><td>${dash}</td><td>${dash}</td><td>${dash}</td><td>${dash}</td><td class="l">${dash}</td>`) : ''}
      ${showBowl ? (w
        ? `<td>${w.o}</td><td>${w.r}</td><td><b class="${fifer ? "mile-5w" : ""}">${w.w}</b></td><td>${w.econ ?? dash}</td>`
        : `<td>${dash}</td><td>${dash}</td><td>${dash}</td><td>${dash}</td>`) : ''}
    </tr>`;
  }).join("");

  // Career totals for the strip, straight from the same object the profile card
  // reads, so the numbers cannot disagree. Batting or bowling to match the role,
  // both for an all-rounder.
  const t = (p.car || {}).total || {};
  const isBat = anyBat || String(p.r||"").toLowerCase().indexOf("bowler") < 0;
  const statFig = [];
  if (anyBat || t.runs){
    statFig.push(["Matches", rows.length]);
    statFig.push(["Runs", (t.runs||0).toLocaleString()]);
    statFig.push(["SR", t.balls_raw ? (t.runs/t.balls_raw*100).toFixed(1) : "—"]);
    statFig.push(["Avg", t.outs ? (t.runs/t.outs).toFixed(1) : "—"]);
  }
  if (anyBowl || t.wkts){
    if (!anyBat && !t.runs) statFig.push(["Matches", rows.length]);
    statFig.push(["Wickets", t.wkts ?? "—"]);
    statFig.push(["Econ", t.balls_raw ? (t.runs/t.balls_raw*6).toFixed(2) : "—"]);
  }
  const header = `<div class="mlog-head">
    <button class="mlog-x" aria-label="Close">&times;</button>
    <div class="mlog-top">
      <div class="mlog-id">${flag(p.nat)}
        <div><h2>${esc(p.f||p.n)}</h2>
          <p>${esc(titled(p.r||p.c))}${p.nat ? ` · ${esc(p.nat)}` : ""}</p></div>
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
    : header + `<p class="mlog-loading">No match-by-match record yet. This needs a
        full re-parse of the archive — run Cricket rebuild.</p>`;
  const pb = document.querySelector("#mlog .mlog-profile");
  if (pb) pb.onclick = () => { closeMatchLog(); select(p.p); };
  const xb = document.querySelector("#mlog .mlog-x");
  if (xb) xb.onclick = closeMatchLog;
}

// helpers the modal leans on
function fmtDate(iso){
  if (!iso) return "—";
  const [y,m,d] = String(iso).split("-");
  return d ? `${+d} ${MON[+m-1]} ${y}` : (y || "—");
}
const TEAM_ABBR = {"India":"IND","Australia":"AUS","England":"ENG","Pakistan":"PAK",
  "South Africa":"RSA","New Zealand":"NZ","Sri Lanka":"SL","Bangladesh":"BAN",
  "West Indies":"WI","Afghanistan":"AFG","Zimbabwe":"ZIM","Ireland":"IRE",
  "Netherlands":"NED","Scotland":"SCO","United Arab Emirates":"UAE","Nepal":"NEP",
  "Papua New Guinea":"PNG","Cook Islands":"COK","Hong Kong":"HK","Kenya":"KEN",
  "Namibia":"NAM","Oman":"OMA","United States of America":"USA","Canada":"CAN",
  "Uganda":"UGA","Jersey":"JEY","Guernsey":"GGY","Italy":"ITA","Germany":"GER",
  "Denmark":"DEN","Malaysia":"MAS","Singapore":"SGP","Bahrain":"BHR","Qatar":"QAT",
  "Kuwait":"KUW","Saudi Arabia":"KSA","Nigeria":"NGA","Ghana":"GHA","Rwanda":"RWA",
  "Tanzania":"TAN","Botswana":"BOT","Malawi":"MWI","Mozambique":"MOZ","Japan":"JPN",
  "Indonesia":"INA","Thailand":"THA","Philippines":"PHI","Vanuatu":"VAN","Samoa":"SAM",
  "Fiji":"FIJ","Bhutan":"BHU","Maldives":"MDV","Bermuda":"BER","Cayman Islands":"CAY",
  "Argentina":"ARG","Portugal":"POR","Spain":"ESP","France":"FRA","Belgium":"BEL",
  "Austria":"AUT","Czech Republic":"CZE","Romania":"ROU","Bulgaria":"BUL","Serbia":"SRB",
  "Isle of Man":"IOM","Gibraltar":"GIB","Sweden":"SWE","Norway":"NOR","Finland":"FIN",
  "Estonia":"EST","Hungary":"HUN","Mexico":"MEX","Panama":"PAN","Bahamas":"BAH",
  "Turkey":"TUR","Greece":"GRE","Cyprus":"CYP","Malta":"MLT","Luxembourg":"LUX",
  "Switzerland":"SUI","Croatia":"CRO","Slovenia":"SVN","Seychelles":"SEY"};
function short(team){
  if (!team) return "—";
  if (TEAM_ABBR[team]) return TEAM_ABBR[team];
  // Fall back to a code rather than the full name, or the row wraps. Drop the
  // small words, take the initials of what's left, cap at four.
  const words = team.split(/\s+/).filter(w => !/^(and|of|the)$/i.test(w));
  if (words.length > 1) return words.map(w => w[0]).join("").slice(0,4).toUpperCase();
  return team.slice(0,3).toUpperCase();
}
function natFor(team){ return FLAGS[team] ? team : (team || null); }
function dismissalText(b){
  const map = {bowled:"b", lbw:"lbw", caught:"c", "caught and bowled":"c&b",
    stumped:"st", "run out":"run out", "hit wicket":"hit wkt"};
  return map[b.out] || (b.out ? b.out : "out");
}


function select(pid){
  state.sel=pid; state.compare=[];
  const e=byPlayer[pid];
  // Open on whichever discipline the player actually is. Rajat Bhatia is a
  // bowler: defaulting to batting gave him a card of zeroes and dashes.
  const bestBy = (a,b) => (b?.b || 0) - (a?.b || 0);
  const bat = e.find(x => x.d === "batting"), bowl = e.find(x => x.d === "bowling");
  const role = String((bat||bowl).r || "").toLowerCase();
  state.disc = role.includes("bowler") && bowl ? "bowling"
             : !bat ? "bowling"
             : !bowl ? "batting"
             : [bat, bowl].sort(bestBy)[0].d;
  $("suggestions").hidden=true; $("search").value=e[0].f||e[0].n;
  $("hero").hidden=true; $("workspace").hidden=false; $("clear").hidden=false;
  state.tab = "profile";          // a new player opens on his profile, as football does
  draw();
  if (typeof window.scrollTo === "function") window.scrollTo(0,0);
}

function toLanding(){
  state.sel=null; state.compare=[]; state.shape=null;
  $("search").value=""; $("clear").hidden=true; $("suggestions").hidden=true;
  $("hero").hidden=false; $("workspace").hidden=true;
}
const entry = () => (byPlayer[state.sel]||[]).find(e=>e.d===state.disc);

function passes(c){
  const f=state.f;
  if(f.active&&!c.playing) return false;
  if(f.exposure==="uncapped" && !(c.e==="domestic"||c.e==="franchise")) return false;
  if(f.exposure==="domestic" && c.e!=="domestic") return false;
  if(f.country.length && !f.country.includes(c.nat)) return false;
  if(f.comp.length && !f.comp.some(k => (c.cb||{})[k])) return false;
  if(f.keeper&&!c.kp) return false;
  if(!ageOk(c)) return false;
  if(c.b<f.minBalls) return false;
  if(f.debutSince&&(!c.fs||c.fs.slice(0,4)<f.debutSince)) return false;
  return true;
}
function ranked(){
  const p = entry();
  // Shape search: no reference player, so there is no distance to measure. It
  // sorts on a metric instead, and says so — pretending a leaderboard is a
  // similarity ranking would be the dishonest option.
  if (!p && state.shape){
    const {disc, cell, sort} = state.shape;
    const low = LOWER_BETTER.has(sort);
    // Sort on whatever is being displayed. Ranking by the levelled number while
    // showing the real one would put the list in an order the page contradicts.
    const val = c => (state.metricView === "actual" ? c.act : c.ad)[sort];
    const out = D.players.filter(c => c.d === disc && c.c === cell && passes(c)
                                   && val(c) != null);
    out.sort((a,b) => low ? val(a) - val(b) : val(b) - val(a));
    return out.slice(0, state.limit || 25).map(c => [val(c), c]);
  }
  if(!p) return [];
  const sp=D.spaces[p.d][p.c]; if(!sp) return [];
  const out=[];
  for(const c of D.players){
    if(c.u===p.u||c.d!==p.d||c.c!==p.c||!passes(c)) continue;
    let d=0; for(let i=0;i<p.x.length;i++){const v=p.x[i]-c.x[i]; d+=v*v;}
    out.push([100*Math.exp(-Math.LN2*Math.sqrt(d)/sp.md), c]);
  }
  return out.sort((a,b)=>b[0]-a[0]).slice(0,10);
}
function why(a,b){
  const mt=D.spaces[a.d][a.c].mt, shared=[], diff=[];
  for(const m of mt){
    const x=a.pc[m], y=b.pc[m]; if(x==null||y==null) continue;
    const gap=Math.abs(x-y);
    if(gap<=12&&(x>=70||x<=30)) shared.push([Math.min(x,100-x),m,x]);
    diff.push([gap,m]);
  }
  shared.sort((p,q)=>p[0]-q[0]); diff.sort((p,q)=>q[0]-p[0]);
  const s=shared[0]?`Both ${shared[0][2]>=50?"high":"low"} for ${LABEL[shared[0][1]].toLowerCase()}`
                   :"Similar overall shape";
  return `${s} · differs on ${diff.slice(0,2).map(x=>LABEL[x[1]].toLowerCase()).join(" and ")}`;
}
function filterBar(){
  const f=state.f, more=state.showMore||state.mode==="scout";
  return `<div class="filters">
    <label class="chk"><input type="checkbox" data-f="active"> Currently playing</label>
    <div class="f"><label>Exposure</label><select data-f="exposure">
      <option value="any">Any</option><option value="unfranchised">No internationals</option>
      <option value="uncapped">Uncapped only</option></select></div>
    <div class="f"><label>Age</label><span style="display:flex;gap:.3rem">
      <input type="number" data-f="minAge" min="15" max="45" placeholder="min">
      <input type="number" data-f="maxAge" min="15" max="45" placeholder="max"></span></div>
    ${more?`<div class="f"><label>Represents</label><select data-f="country">
      <option value="any">Any country</option>
      ${COUNTRIES.map(c=>`<option value="${c}">${c}</option>`).join("")}</select></div>
    <div class="f"><label>Has played in</label><select data-f="comp">
      <option value="any">Any competition</option>
      ${CLUBCOMPS.map(c=>`<option value="${c}">${D.compNames[c]||c}</option>`).join("")}</select></div>
    <div class="f"><label>Min balls</label><input type="number" data-f="minBalls" min="0" step="100"></div>
    <div class="f"><label>Debut since</label>
      <input type="number" data-f="debutSince" min="2005" max="2026" placeholder="any"></div>
    <label class="chk"><input type="checkbox" data-f="keeper"> Keepers only</label>`
    :`<button class="more" data-more>More filters</button>`}
    <button class="more reset" data-reset>Reset</button></div>`;
}

/* ── career numbers ──────────────────────────────────────
   Rates say how a player compares; totals say what he has actually done. A tab
   only appears where there is something in it, so a player who has never gone
   near an international does not get an empty one. */
const GRP_LABEL = {total:"Total", international:"International",
                   franchise:"Franchise", domestic:"Domestic"};

function careerCard(p){
  const car = p.car; if (!car) return "";
  const groups = ["total","international","franchise","domestic"]
    .filter(g => car[g] && (car[g].balls_raw || 0) > 0);
  if (groups.length < 2) return "";
  const g = groups.includes(state.career) ? state.career : "total";
  const c = car[g] || {};
  const balls = c.balls_raw || 0, runs = c.runs || 0, outs = c.outs || 0, wk = c.wkts || 0;
  const matches = g === "total"
    ? Object.values(car.matches || {}).reduce((a,b)=>a+b,0)
    : (car.matches || {})[g] || 0;
  const rows = p.d === "batting"
    ? [["Matches", matches], ["Runs", runs.toLocaleString()],
       ["Balls faced", balls.toLocaleString()],
       ["Strike rate", balls ? (runs/balls*100).toFixed(1) : "—"],
       ["Average", outs ? (runs/outs).toFixed(1) : "—"],
       ["Fours", c.fours ?? 0], ["Sixes", c.sixes ?? 0],
       ["Dot %", balls ? (c.dots/balls*100).toFixed(1) : "—"]]
    : [["Matches", matches], ["Wickets", wk],
       ["Balls bowled", balls.toLocaleString()],
       ["Runs conceded", runs.toLocaleString()],
       ["Economy", balls ? (runs/balls*6).toFixed(2) : "—"],
       ["Average", wk ? (runs/wk).toFixed(1) : "—"],
       ["Strike rate", wk ? (balls/wk).toFixed(1) : "—"],
       ["Dot %", balls ? (c.dots/balls*100).toFixed(1) : "—"]];
  return `<article class="panel">
    <header class="panel-head"><h2>Career ${p.d === "batting" ? "batting" : "bowling"}</h2>
      <p class="panel-sub">Raw totals, unadjusted — what actually happened.</p></header>
    <div class="ctabs" role="tablist">${groups.map(x =>
      `<button role="tab" data-career="${x}" aria-selected="${x===g}">${GRP_LABEL[x]}</button>`
      ).join("")}</div>
    <div class="cstats">${rows.map(([k,v]) =>
      `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</div>
  </article>`;
}

function playerbar(){
  const p = entry();
  if (!p && state.shape){
    const {disc, cell} = state.shape;
    const w = state.wiz, bits = [];
    if (w.age !== "any") bits.push((AGE_BANDS.find(b => b[0] === w.age)||[,""])[1]);
    if (w.exposure !== "any") bits.push(w.exposure === "uncapped" ? "Uncapped" : "Domestic only");
    if (w.comps.length) bits.push(w.comps.map(k => D.compNames[k]||k).join(", "));
    if (w.countries.length) bits.push(w.countries.join(", "));
    $("playerbar").innerHTML = `<div class="pb-id">
        <div><h1>${esc(titled(cell))} ${disc === "batting" ? "batters" : "bowlers"}</h1>
          <p class="pb-role">${bits.length ? esc(bits.join(" · ")) : "no further conditions"}</p></div>
      </div>
      <div class="pb-actions">
        <button class="ghost accent" id="clear-player">
          <svg viewBox="0 0 24 24" aria-hidden="true" class="btn-icon">
            <circle cx="10.5" cy="10.5" r="6.4" fill="none" stroke="currentColor" stroke-width="2"/>
            <path d="M15.4 15.4L20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>Change what I am looking for</button>
      </div>`;
    $("clear-player").onclick = toLanding;
    return;
  }
  if(!p){ $("playerbar").innerHTML=""; return; }
  const both = byPlayer[p.p].length > 1;
  const saved = slRead().includes(p.u);
  // A player whose role says bowler but who has no bowling profile is being
  // shown his batting, and saying nothing about that is misleading.
  const role = String(p.r || "").toLowerCase();
  const mismatch = !both && (
    (role.includes("bowler") && p.d === "batting") ||
    (!role.includes("bowler") && p.d === "bowling"));
  const t = (p.car||{}).total || {};
  const bat = p.d === "batting";
  const runs = t.runs || 0, ballsC = t.balls_raw || 0, outs = t.outs || 0, wk = t.wkts || 0;
  const facts = bat ? [
    ["Age", p.a ? Math.floor(p.a) : "—", p.nat || ""],
    ["Runs", runs.toLocaleString(), `${(t.fours||0)} fours · ${(t.sixes||0)} sixes`],
    ["Strike rate", ballsC ? (runs/ballsC*100).toFixed(1) : "—",
      `${ballsC.toLocaleString()} balls`],
    ["Average", outs ? (runs/outs).toFixed(1) : "—", `${outs} dismissals`],
    ["Exposure", EXPOSURE[p.e] || titled(p.e), `${p.m} matches`],
  ] : [
    ["Age", p.a ? Math.floor(p.a) : "—", p.nat || ""],
    ["Wickets", wk.toLocaleString(), `${p.m} matches`],
    ["Economy", ballsC ? (runs/ballsC*6).toFixed(2) : "—",
      `${ballsC.toLocaleString()} balls`],
    ["Strike rate", wk ? (ballsC/wk).toFixed(1) : "—", "balls per wicket"],
    ["Exposure", EXPOSURE[p.e] || titled(p.e), `debut ${(p.fs||"—").slice(0,4)}`],
  ];
  $("playerbar").innerHTML = `
    <div class="pb-id">
      ${flag(p.nat)}
      <div><h1>${esc(p.f||p.n)}</h1>
        <p class="pb-role">${esc(titled(p.r || p.c))}${p.kp ? " · Wicketkeeper" : ""}</p></div>
      <span class="availability ${p.playing?"active":"gone"}">${
        p.playing ? "Currently playing" : `Last seen ${whenSeen(p.ls)}`}</span>
      ${p.partial ? `<span class="pb-note warn-inline">Afghanistan's matches are
        withheld from this archive. What is shown is franchise cricket only —
        this player's international record is missing, not zero.</span>` : ""}
      ${mismatch ? `<span class="pb-note">Showing ${p.d}. No ${
        p.d === "batting" ? "bowling" : "batting"} profile — too few balls, or the
        bowling type could not be established.</span>` : ""}
    </div>
    <dl class="pb-facts">${facts.map(([k,v,sub]) =>
      `<div><dt>${esc(k)}</dt><dd>${esc(v)}${sub?`<small>${esc(sub)}</small>`:""}</dd></div>`
      ).join("")}</dl>
    <div class="pb-actions">
      ${p.ci?`<a class="srclink" href="https://www.espncricinfo.com/ci/content/player/${p.ci}.html"
         target="_blank" rel="noopener noreferrer"><span class="monogram">CI</span>ESPNcricinfo</a>`:""}
      ${both?`<div class="segmented" role="group" aria-label="Discipline">
        <button data-disc="batting" aria-pressed="${p.d==="batting"}">Batting</button>
        <button data-disc="bowling" aria-pressed="${p.d==="bowling"}">Bowling</button></div>`:""}
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
  const gm = $("go-matches"); if (gm) gm.onclick = () => openMatchLog(p.p);
  $("clear-player").onclick = toLanding;
}

function paneProfile(){
  const p = entry();
  if(!p) return `<div class="empty">Search a player to begin.</div>`;
  if(!D.ready) return `<div class="empty">Loading the detail for ${esc(p.f||p.n)}…</div>`;
  const mt = D.spaces[p.d][p.c].mt;
  // Eight axes on the radar; a sixteen-spoke chart is unreadable. The rest are
  // in the table beside it, which is where football puts the detail too.
  const radarMetrics = mt.slice(0, 8);
  const shrink = Math.round(100 * p.eb / Math.max(1, p.b));
  const comps = Object.entries(p.cb).sort((a,b)=>b[1]-a[1]).slice(0,6)
    .map(([k,v])=>`<div><b>${esc(D.compNames[k]||k)}</b><span>${v.toLocaleString()}</span></div>`).join("");
  const pool = D.spaces[p.d][p.c].n;

  return `<div class="profile-grid">
    <div class="profile-left">
      <article class="panel radar-panel">
        <header class="panel-head">
          <h2>Profile against role</h2>
          <p class="panel-sub">Percentile among all ${pool} ${esc(titled(p.c))}
            ${p.d==="batting"?"batters":"bowlers"} in the pool, after adjusting for
            competition.</p>
        </header>
        <div class="radar-wrap">${radarSvg([{colour:"gold", pct:p.pc}], radarMetrics,
          LABEL, {label:`Profile for ${p.f||p.n}`})}</div>
        <p class="scale-help">Percentile = how many of those ${pool} this player beats.
          <b>50</b> is the role average, marked by the dotted ring. Higher is better on
          every axis shown.</p>
      </article>
      <article class="panel">
        <header class="panel-head"><h2>What this rests on</h2>
          <p class="panel-sub">Balls faced, and how much of it is recent enough to
            count.</p></header>
        <div class="prov"><b>${p.b.toLocaleString()}</b> balls,
          <b>${p.eb.toLocaleString()}</b> after recency weighting
          <div class="bar"><span style="width:${Math.min(100,shrink)}%"></span></div>
          ${p.thin
            ? `<b class="thin-line">Under ${D.thinBalls} balls.</b> Enough to place him, not
               enough to test: splitting a career this short leaves too little on either side.
               Treat what follows as a lead rather than a finding.`
            : shrink < 40
            ? "Thin or dated — heavily shrunk toward the role average, so treat the score with care."
            : "Enough recent cricket to judge on."}</div>
        <div class="hd" style="margin-top:1rem">Balls by competition</div>
        <div class="kv">${comps}</div>
      </article>
    </div>
    <div class="profile-main">
      ${careerCard(p)}
      <article class="panel">
        <header class="panel-head"><h2>Percentile detail</h2>
          <p class="panel-sub">Values are what the player actually did. The
            percentile is worked out after levelling for competition, and always
            answers how good rather than how large — so for economy and dot
            percentage a lower number still ranks high.</p></header>
        <div class="radar-key">
          <div class="keyhead"><span>Metric</span>
            <span class="mview"><button data-mview="adjusted" aria-pressed="${state.metricView!=="actual"}"
              title="Levelled so competitions compare">Adjusted</button><button data-mview="actual"
              aria-pressed="${state.metricView==="actual"}"
              title="What he actually did, before levelling">Actual</button></span>
            <span>Percentile</span></div>
          ${mt.map(m => {
            const v = p.pc[m];
            return `<div class="keyrow"><span class="k">${esc(LABEL[m]||m)}</span>
              <span class="v">${fmtMetric((state.metricView==="actual"?p.act:p.ad)[m])}</span>
              <span class="p"><span class="pbar"><span style="width:${v ?? 0}%"></span></span>
              <b>${v == null ? "—" : Math.round(v)}</b></span></div>`;
          }).join("")}
        </div>
      </article>
    </div>
  </div>`;
}


/* ── the scouting wizard ─────────────────────────────────
   Exploring starts with a name. Scouting starts with a need: nobody opens this
   thinking "find me someone like Ravi Bishnoi", they think "I need a young
   uncapped wrist-spinner who has bowled in the middle overs".

   Each answer narrows the pool and the count is live, so you can stop the moment
   it is small enough to read. Only the first two steps are required — a path
   that ends at one player has not scouted anything, it has described somebody. */
const WIZ_ROLES = {
  batting: [["opener","Opener"],["top middle","Top middle"],
            ["middle","Middle order"],["finisher","Finisher"]],
  bowling: [["pace","Pace"],["spin","Spin"]],
};
/* What to rank by when no reference player is given. Shape needs an anchor;
   without one this is a leaderboard, so it says which number it is sorting on. */
const SORT_DEFAULT = {opener:"sr", "top middle":"sr", middle:"sr",
                      finisher:"sr_death", pace:"econ", spin:"econ"};

function wizMatches(skip){
  const w = state.wiz;
  const on = k => k !== skip;
  return D.players.filter(c => {
    if (on("disc") && w.disc && c.d !== w.disc) return false;
    if (on("cell") && w.cell && c.c !== w.cell) return false;
    if (on("age") && w.age !== "any" && !ageOk({a:c.a}, w.age)) return false;
    if (on("exposure")){
      if (w.exposure === "uncapped" && !(c.e === "domestic" || c.e === "franchise")) return false;
      if (w.exposure === "domestic" && c.e !== "domestic") return false;
    }
    if (on("comps") && w.comps.length && !w.comps.some(k => (c.cb||{})[k])) return false;
    if (on("countries") && w.countries.length && !w.countries.includes(c.nat)) return false;
    if (w.active && !c.playing) return false;
    return true;
  });
}

function wizStep(key, label, opts, hint){
  const cur = state.wiz[key];
  // Count each answer against everything else already chosen. An option that
  // leads nowhere is a dead end you cannot see until you have clicked it.
  const base = wizMatches(key);
  const count = v => {
    if (v === "any" || v == null) return base.length;
    if (key === "disc") return base.filter(c => c.d === v).length;
    if (key === "cell") return base.filter(c => c.c === v).length;
    if (key === "age") return base.filter(c => ageOk({a:c.a}, v)).length;
    if (key === "exposure") return base.filter(c =>
      v === "uncapped" ? (c.e === "domestic" || c.e === "franchise") : c.e === "domestic").length;
    return base.length;
  };
  return `<div class="wiz-step"><span class="wiz-label">${esc(label)}${
      hint ? ` <button type="button" class="qmark" data-hint="${esc(hint)}"
        title="${esc(hint)}" aria-label="What this means">?</button>` : ""}</span>
    <div class="segmented" role="group" aria-label="${esc(label)}">${opts.map(([v,t]) => {
      // The count decides whether an answer is offered at all; it does not need
      // to be printed on every chip as well.
      const n = count(v);
      return `<button data-wiz="${key}" data-v="${v}" aria-pressed="${String(cur) === v}"
        ${n ? "" : "disabled"} title="${n.toLocaleString()} player${n===1?"":"s"}"
        >${esc(t)}</button>`;
    }).join("")}</div></div>`;
}

function wizMulti(key, label, options, anyText){
  const chosen = state.wiz[key];
  const summary = !chosen.length ? anyText
    : chosen.length === 1 ? (options.find(o => o[0] === chosen[0]) || [,chosen[0]])[1]
    : `${chosen.length} selected`;
  return `<div class="wiz-step multi" data-wmulti="${key}">
    <span class="wiz-label">${esc(label)}</span>
    <button class="multi-btn${chosen.length?" on":""}" aria-expanded="false"
      >${esc(summary)}<i class="caret"></i></button>
    <div class="multi-panel" hidden>
      <input class="multi-search" type="text" placeholder="Search…" aria-label="Search ${esc(label)}">
      <div class="multi-list">${options.map(([v,t]) =>
        `<label data-t="${esc(String(t).toLowerCase())}"><input type="checkbox" value="${esc(v)}"
          ${chosen.includes(v)?"checked":""}><span>${esc(t)}</span></label>`).join("")}</div>
      <div class="multi-foot"><button class="linkish" data-wclear>Clear</button>
        <button class="ghost small" data-wdone>Done</button></div>
    </div></div>`;
}

function renderWizard(){
  const w = state.wiz, n = wizMatches().length;
  // Only competitions and countries that actually hold someone matching the
  // rest of the answers, each with its count.
  const forComps = wizMatches("comps"), forCountries = wizMatches("countries");
  const compN = {}; forComps.forEach(c =>
    Object.keys(c.cb||{}).forEach(k => compN[k] = (compN[k]||0) + 1));
  const countryN = {}; forCountries.forEach(c =>
    { if (c.nat) countryN[c.nat] = (countryN[c.nat]||0) + 1; });
  const comps = CLUBCOMPS.filter(c => compN[c])
    .map(c => [c, `${D.compNames[c] || c} (${compN[c]})`])
    .sort((a,b) => a[1].localeCompare(b[1]));
  const countries = Object.keys(countryN).sort()
    .map(c => [c, `${c} (${countryN[c]})`]);

  let html = wizStep("disc", "Discipline", [["batting","Batter"],["bowling","Bowler"]],
    "An all-rounder appears under both. Pick the side of his game you are hiring.");
  if (w.disc) html += wizStep("cell", "Role", WIZ_ROLES[w.disc]);
  if (w.disc && w.cell){
    html += wizStep("age", "Age", AGE_BANDS);
    html += wizStep("exposure", "Exposure", [["any","Any"],["uncapped","Uncapped"],
      ["domestic","Domestic only"]],
      "Uncapped: has never played a T20 international, though he may be an IPL or "
      + "Big Bash regular. Domestic only: has never played an international AND has "
      + "never played a franchise league — purely state, county or provincial cricket.");
    html += wizMulti("comps", "Has played in", comps, "Any competition");
    html += wizMulti("countries", "Represents", countries, "Any country");
  }
  $("wiz-steps").innerHTML = html;

  $("wiz-count").innerHTML = !w.disc ? "Start with the side of the game."
    : !w.cell ? `${wizMatches().length.toLocaleString()} ${w.disc === "batting" ? "batters" : "bowlers"} — now the role.`
    : `<b>${n.toLocaleString()}</b> player${n === 1 ? "" : "s"} match so far.`
      + (n > 60 ? " Narrow further, or look now." : n ? " Small enough to read." : "");
  $("wiz-go").hidden = !(w.disc && w.cell) || !n;
  $("wiz-go").textContent = n ? `Show ${n.toLocaleString()} player${n === 1 ? "" : "s"}` : "";

  $("wiz-steps").querySelectorAll("[data-wiz]").forEach(b => b.onclick = () => {
    const k = b.dataset.wiz;
    state.wiz[k] = state.wiz[k] === b.dataset.v && k !== "disc" ? "any" : b.dataset.v;
    if (k === "disc") state.wiz.cell = null;
    renderWizard();
  });
  $("wiz-steps").querySelectorAll("[data-wmulti]").forEach(box => {
    const key = box.dataset.wmulti;
    const btn = box.querySelector(".multi-btn"), panel = box.querySelector(".multi-panel");
    const search = box.querySelector(".multi-search");
    btn.onclick = e => { e.stopPropagation();
      const open = panel.hidden;
      document.querySelectorAll(".multi-panel").forEach(p => p.hidden = true);
      panel.hidden = !open; btn.setAttribute("aria-expanded", String(open));
      if (open && search.focus) search.focus(); };
    search.oninput = () => { const t = search.value.toLowerCase();
      box.querySelectorAll(".multi-list label").forEach(l =>
        l.hidden = t && !l.dataset.t.includes(t)); };
    box.querySelectorAll(".multi-list input").forEach(cb => cb.onchange = () => {
      const set = new Set(state.wiz[key]);
      cb.checked ? set.add(cb.value) : set.delete(cb.value);
      state.wiz[key] = [...set];
      renderWizard();
      const again = $("wiz-steps").querySelector(`[data-wmulti="${key}"] .multi-panel`);
      if (again) again.hidden = false;
    });
    box.querySelector("[data-wclear]").onclick = () => { state.wiz[key] = []; renderWizard(); };
    box.querySelector("[data-wdone]").onclick = () => { panel.hidden = true; };
  });
}

/* Carry the wizard's answers into the filter bar, so the controls on the results
   page are the same state rather than a second copy of it. */
function wizGo(){
  const w = state.wiz;
  state.shape = {disc: w.disc, cell: w.cell, sort: SORT_DEFAULT[w.cell] || "sr"};
  state.limit = 25;
  state.sel = null; state.compare = [];
  state.f = BLANK();
  state.f.age = w.age; state.f.exposure = w.exposure;
  state.f.comp = [...w.comps]; state.f.country = [...w.countries];
  state.f.active = w.active; state.f.minBalls = 0;
  state.showMore = true;
  state.tab = "similar";
  $("hero").hidden = true; $("workspace").hidden = false; $("clear").hidden = false;
  draw();
  if (typeof window.scrollTo === "function") window.scrollTo(0,0);
}

/* ── similar players, in football's structure ────────────
   Header, filter chips, tag key, then rows: rank, score with its track, flag and
   name, meta cells, the three read chips, the reason, save and add. Same markup,
   so the same stylesheet dresses it. */
const SERIES = ["gold","blue","green","violet","coral","mint"];
const MAX_COMPARE = 6;
const AGE_BANDS = [["any","Any"],["u23","Under 23"],["u26","Under 26"],
                   ["26-30","26–30"],["30-32","30–32"],["32+","32+"]];

function ageOk(c, band){
  const a = c.a; const b = band || state.f.age;
  if (b === "any") return true;
  if (!a) return false;
  if (b === "u23") return a < 23;
  if (b === "u26") return a < 26;
  if (b === "26-30") return a >= 26 && a < 30;
  if (b === "30-32") return a >= 30 && a < 32;
  return a >= 32;
}

/* The three chips: the trait they share most closely, then the two biggest gaps.
   Straight from football's chipsFor. */
function chipsFor(a, b){
  const mt = D.spaces[a.d][a.c].mt;
  const rows = mt.map(m => {
    const x = a.pc[m] ?? 50, y = b.pc[m] ?? 50;
    return {m, gap:Math.abs(x-y), edge:Math.min(Math.abs(x-50), Math.abs(y-50)), x, y};
  });
  const same = rows.filter(r => r.edge > 15).sort((p,q) => p.gap - q.gap)[0]
            || [...rows].sort((p,q) => p.gap - q.gap)[0];
  const diff = [...rows].sort((p,q) => q.gap - p.gap).slice(0,2);
  // Short labels on the chip, the full metric name on hover. "More balls in
  // powerplay %" wrapped to three lines on one row and two on the next, which
  // is what made the list look ragged.
  const SHORT = {sr:"strike rate", bpd:"balls/out", bdry:"boundary %",
    six_share:"six share", dot_pct:"dot %", sr_pp:"SR powerplay",
    sr_mid:"SR middle", sr_death:"SR death", sh_pp:"PP share",
    sh_death:"death share", sr_pace:"v pace", sr_spin:"v spin",
    spin_bias:"spin bias", sr_first10:"SR first 10", accel:"acceleration",
    bdry_spin:"boundary v spin", econ:"economy", wkt_rate:"wickets",
    dot_rate:"dot %", bdry_conc:"boundary %", six_share_conc:"six share",
    econ_pp:"econ powerplay", econ_mid:"econ middle", econ_death:"econ death",
    wide_rate:"wides"};
  const nm = m => SHORT[m] || (LABEL[m] || m).toLowerCase();
  const full = m => (LABEL[m] || m);
  return [{cls:"same", text:`Similar ${nm(same.m)}`, full:`Similar ${full(same.m)}`},
    ...diff.map(r => ({cls: r.y > r.x ? "more" : "less",
      text:`${r.y > r.x ? "More" : "Less"} ${nm(r.m)}`,
      full:`${r.y > r.x ? "More" : "Less"} ${full(r.m)}`}))];
}

function seg(label, key, opts, hint){
  return `<div class="filter"><span class="filter-label">${esc(label)}${
      hint ? ` <button type="button" class="qmark" data-hint="${esc(hint)}"
        title="${esc(hint)}" aria-label="What this means">?</button>` : ""}</span>
    <div class="segmented" role="group" aria-label="${esc(label)}">${opts.map(([v,t,tip]) =>
      `<button data-f="${key}" data-v="${v}" aria-pressed="${String(state.f[key]) === v}"
        ${tip ? `title="${esc(tip)}" data-tip="${esc(tip)}"` : ""}>${esc(t)}</button>`).join("")}</div>
    ${opts.some(o => o[2]) ? `<p class="opt-tip" data-tipfor="${key}"></p>` : ""}</div>`;
}

/* A multi-select with its own search, because "Represents" has eighty options
   and "Has played in" forty-eight. A native select can hold one of those and
   cannot be searched, which is the wrong control for the job. */
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
      <div class="multi-foot">
        <button class="linkish" data-clear>Clear</button>
        <button class="ghost small" data-done>Done</button>
      </div>
    </div></div>`;
}

function wireMulti(){
  $("filters").querySelectorAll("[data-multi]").forEach(box => {
    const key = box.dataset.multi;
    const btn = box.querySelector(".multi-btn"), panel = box.querySelector(".multi-panel");
    const search = box.querySelector(".multi-search");
    btn.onclick = e => {
      e.stopPropagation();
      const open = panel.hidden;
      document.querySelectorAll(".multi-panel").forEach(p => p.hidden = true);
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      if (open && search.focus) search.focus();
    };
    search.oninput = () => {
      const t = search.value.toLowerCase();
      box.querySelectorAll(".multi-list label").forEach(l =>
        l.hidden = t && !l.dataset.t.includes(t));
    };
    box.querySelectorAll(".multi-list input").forEach(cb => cb.onchange = () => {
      const set = new Set(state.f[key]);
      cb.checked ? set.add(cb.value) : set.delete(cb.value);
      state.f[key] = [...set];
      draw();
      // Keep it open: picking three countries should not mean three reopenings.
      // Done closes it when the selection is finished.
      state.openMulti = key;
      const again = $("filters").querySelector(`[data-multi="${key}"] .multi-panel`);
      if (again) { again.hidden = false;
        const b = $("filters").querySelector(`[data-multi="${key}"] .multi-btn`);
        if (b) b.setAttribute("aria-expanded","true"); }
    });
    box.querySelector("[data-clear]").onclick = () => { state.f[key] = []; draw(); };
    box.querySelector("[data-done]").onclick = () => {
      panel.hidden = true; btn.setAttribute("aria-expanded","false");
    };
  });
}

function renderFilters(){
  const more = state.showMore;
  const countries = [...new Set(D.players.map(x => x.nat).filter(Boolean))].sort()
    .map(c => [c, c]);
  const comps = CLUBCOMPS.map(c => [c, D.compNames[c] || c])
    .sort((a,b) => a[1].localeCompare(b[1]));
  $("filters").innerHTML =
    seg("Age", "age", AGE_BANDS) +
    seg("Exposure", "exposure", [
      ["any", "Any", "Everyone in the pool."],
      ["uncapped", "Uncapped",
       "Has never played a T20 international, though he may be an IPL or Big Bash "
       + "regular. This is what an auction means by uncapped."],
      ["domestic", "Domestic only",
       "Has never played an international AND has never played a franchise league. "
       + "Purely state, county or provincial cricket."]],
      "Measured in T20 cricket only, and a level counts once a player has faced or "
      + "bowled 60 balls at it. So a Test great with one T20I appearance still reads "
      + "as uncapped here.") +
    seg("Balls faced", "minBalls", [["0","Any"],["300","300+"],["1000","1,000+"]]) +
    (more ? multi("country", "Represents", countries, "Any country")
          + multi("comp", "Has played in", comps, "Any competition") : "") +
    `<label class="switch"><input type="checkbox" data-chk="active" ${
      state.f.active?"checked":""}><span>Only players still playing</span></label>
     <label class="switch"><input type="checkbox" data-chk="keeper" ${
      state.f.keeper?"checked":""}><span>Keepers only</span></label>` +
    `<button class="linkish" data-more>${more ? "Fewer filters" : "More filters"}</button>` +
    `<button class="linkish reset" data-reset>Reset</button>`;

  $("filters").querySelectorAll("[data-f]").forEach(b => b.onclick = () => {
    state.f[b.dataset.f] = b.dataset.f === "minBalls" ? +b.dataset.v : b.dataset.v;
    draw();
  });
  // Show the chosen option's explanation under the row, where a phone can read
  // it. On desktop the same text is still the tooltip.
  $("filters").querySelectorAll("[data-tipfor]").forEach(p => {
    const key = p.dataset.tipfor;
    const on = $("filters").querySelector(`[data-f="${key}"][aria-pressed="true"]`);
    p.textContent = on && on.dataset.tip ? on.dataset.tip : "";
  });
  $("filters").querySelectorAll("[data-chk]").forEach(el =>
    el.onchange = e => { state.f[el.dataset.chk] = e.target.checked; draw(); });
  $("filters").querySelector("[data-more]").onclick = () => {
    state.showMore = !state.showMore;
    if (!state.showMore){ state.f.country = []; state.f.comp = []; }
    draw();
  };
  $("filters").querySelector("[data-reset]").onclick = () => {
    state.f = BLANK();
    if (state.mode === "scout") state.f.minBalls = 300;
    draw();
  };
  wireMulti();
}

function renderResults(){
  const p = entry();
  if (!p && state.shape) return renderShapeResults();
  if (!p) return;
  const sp = D.spaces[p.d][p.c];
  const all = D.players.filter(c => c.u !== p.u && c.d === p.d && c.c === p.c);
  const eligible = all.filter(passes).length;
  const rows = ranked();
  const full = state.compare.length >= MAX_COMPARE - 1;

  $("results-title").textContent = `Closest to ${p.f || p.n}`;
  $("results-note").textContent = p.d === "batting"
    ? "Scoring rate, shape and match-up — how and when runs come, not only how many."
    : "Economy, wickets and phase — where in an innings a bowler works and what it costs.";
  const thinCount = rows.filter(([,c]) => c.thin).length;
  const anyPartial = rows.some(([,c]) => c.partial) || p.partial;
  $("results-note").innerHTML = ($("results-note").textContent || "")
    + (anyPartial ? ` <em class="warn-inline">Afghanistan's matches are withheld
      from this archive, so Afghan players' records here are franchise cricket
      only — their international careers are missing, not zero.</em>` : "");
  $("results-count").innerHTML = rows.length
    ? `${rows.length} shown of <b>${eligible}</b> in the pool`
      + (thinCount ? `<br><em class="thin-count">${thinCount} marked thin</em>` : "")
    : "";
  renderFilters();

  if (!rows.length){
    $("matches").innerHTML = ""; $("tagkey").hidden = true;
    $("thin").hidden = false;
    $("thin").textContent = `No ${titled(p.c).toLowerCase()}s match these filters. `
      + `Widen the age band, or lower the balls faced.`;
    return;
  }
  $("tagkey").hidden = false;
  $("thin").hidden = rows.length >= 5;
  if (rows.length < 5)
    $("thin").textContent = `Only ${rows.length} match these filters. Loosen one.`;

  $("tagkey").innerHTML =
    (full ? `<span class="tagkey-full">Comparison is full. Remove a player to add another.</span> ` : "")
    + `Tags compare each player with <b>${esc(p.f||p.n)}</b>: `
    + `<em class="tag same">Similar</em> a shared trait, `
    + `<em class="tag more">More</em> and <em class="tag less">Less</em> the two biggest gaps. `
    + `<span class="tagkey-add">Use <b>+</b> to add a player to the comparison.</span>`;

  const saved = slRead();
  $("matches").innerHTML = rows.map(([score, c], i) => {
    const inCmp = state.compare.includes(c.u), isSaved = saved.includes(c.u);
    const chips = chipsFor(p, c);
    const bat = c.d === "batting", t = (c.car||{}).total || {};
    const cells = bat
      ? [["Age", c.a ? Math.floor(c.a) : "—"],
         ["Runs", (t.runs||0).toLocaleString()],
         ["Strike rate", t.balls_raw ? (t.runs/t.balls_raw*100).toFixed(1) : "—"],
         ["Last played", whenSeen(c.ls)]]
      : [["Age", c.a ? Math.floor(c.a) : "—"],
         ["Wickets", t.wkts ?? "—"],
         ["Economy", t.balls_raw ? (t.runs/t.balls_raw*6).toFixed(2) : "—"],
         ["Last played", whenSeen(c.ls)]];
    return `<li class="match${inCmp ? " is-open" : ""}">
      <button class="match-btn" data-uid="${c.u}">
        <span class="rank">${i + 1}</span>
        <span class="score"><span class="score-num">${score.toFixed(0)}</span>
          <span class="score-track"><span style="width:${Math.min(100,score).toFixed(1)}%"></span></span></span>
        <span class="who">
          <span class="who-top">${flag(c.nat)}<b>${esc(c.f||c.n)}</b>
            ${c.playing ? "" : '<em class="gone-tag">retired</em>'}
            ${c.thin ? `<em class="thin-tag" title="Only ${c.b.toLocaleString()} balls — `
              + `too little to test this profile against itself, so treat the score as a `
              + `lead rather than a finding">thin</em>` : ""}</span>
          <span class="who-sub">${esc(titled(c.r||c.c))} · <b class="clubnow">${
            esc(c.nat || "—")}</b> · ${esc(EXPOSURE[c.e] || titled(c.e))}</span>
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
          title="${inCmp?"Remove from comparison":full?"Comparison is full — remove someone first":"Add to comparison"}"
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
    if (!state.compare.includes(b.dataset.uid) && !full) state.compare.push(b.dataset.uid);
    setTab("compare");
  });
  $("matches").querySelectorAll(".addbtn").forEach(b => b.onclick = () => {
    const i = state.compare.indexOf(b.dataset.add);
    if (i >= 0) state.compare.splice(i,1);
    else if (state.compare.length < MAX_COMPARE - 1) state.compare.push(b.dataset.add);
    draw();
  });
  $("matches").querySelectorAll(".savebtn").forEach(b =>
    b.onclick = () => slToggle(b.dataset.save));
}

/* ── compare, in football's structure ────────────────────
   Tray of chips, one radar carrying everyone, a season trend, and every metric
   as a span with a dot per player. */
function compareSeries(){
  const p = entry();
  // A shape search has no reference player, but the players it found still
  // compare against each other — which is most of what a shortlist is for.
  if (!p) return state.compare
    .map((u,i) => ({p: byUid[u], colour: SERIES[i % SERIES.length]}))
    .filter(x => x.p);
  const out = [{p, colour: SERIES[0]}];
  state.compare.forEach((u,i) => {
    const c = byUid[u];
    if (c && c.u !== p.u) out.push({p:c, colour: SERIES[(i+1) % SERIES.length]});
  });
  return out;
}

function scoreAgainst(base, c){
  const sp = D.spaces[base.d][base.c];
  if (!sp || c.c !== base.c || c.d !== base.d) return null;
  let d = 0; for (let k=0;k<base.x.length;k++){const v=base.x[k]-c.x[k]; d+=v*v;}
  return 100 * Math.exp(-Math.LN2 * Math.sqrt(d) / sp.md);
}

function renderShapeResults(){
  if (!D.ready){ $("matches").innerHTML =
    `<li class="empty">Loading…</li>`; return; }
  const {disc, cell, sort} = state.shape;
  const rows = ranked();
  const pool = D.players.filter(c => c.d === disc && c.c === cell);
  const eligible = pool.filter(passes).length;
  const full = state.compare.length >= MAX_COMPARE - 1;
  const low = LOWER_BETTER.has(sort);
  const mt = D.spaces[disc][cell].mt;

  $("results-title").textContent =
    `${titled(cell)} ${disc === "batting" ? "batters" : "bowlers"}`;
  $("results-note").innerHTML =
    `No reference player, so there is no shape to measure against — this is
     sorted on one number. Open anyone to rank the rest by how closely they
     resemble him.
     <span class="sortpick">Showing
       <span class="mview"><button data-mview="actual" aria-pressed="${
         state.metricView === "actual"}" title="What the player actually did"
         >Actual</button><button data-mview="adjusted" aria-pressed="${
         state.metricView !== "actual"}"
         title="Levelled so an over in one competition means the same as an over in another"
         >Adjusted</button></span>
       sorted by
       <select id="shape-sort">${mt.map(m =>
         `<option value="${m}"${m===sort?" selected":""}>${esc(LABEL[m]||m)}</option>`).join("")}</select>
       <em>${low ? "lowest first" : "highest first"}</em></span>`;
  const thinCount = rows.filter(([,c]) => c.thin).length;
  $("results-count").innerHTML = `${rows.length} shown of <b>${eligible}</b> matching`
    + (thinCount ? `<br><em class="thin-count">${thinCount} marked thin</em>` : "");
  renderFilters();
  $("tagkey").hidden = false;
  $("tagkey").innerHTML = `<button class="ghost small" id="shape-export">Export these
    ${eligible.toLocaleString()} players to CSV</button>
    <span class="tagkey-add">Every column the tool holds, not just what is on screen.</span>`;
  const ex = $("shape-export");
  if (ex) ex.onclick = () => exportCsv(
    D.players.filter(c => c.d === disc && c.c === cell && passes(c)),
    `cricket-${cell.replace(/\s+/g,"-")}-${disc}`);
  $("thin").hidden = rows.length > 0;
  $("thin").textContent = "Nothing matches these filters. Loosen one.";

  const saved = slRead();
  $("matches").innerHTML = rows.map(([val, c], i) => {
    const t = (c.car||{}).total || {};
    const bat = c.d === "batting";
    const cells = bat
      ? [["Age", c.a ? Math.floor(c.a) : "—"], ["Runs", (t.runs||0).toLocaleString()],
         ["Balls", c.b.toLocaleString()], ["Last played", whenSeen(c.ls)]]
      : [["Age", c.a ? Math.floor(c.a) : "—"], ["Wickets", t.wkts ?? "—"],
         ["Balls", c.b.toLocaleString()], ["Last played", whenSeen(c.ls)]];
    const isSaved = saved.includes(c.u);
    const inCmp = state.compare.includes(c.u);
    return `<li class="match shape${inCmp ? " is-open" : ""}">
      <button class="match-btn" data-open="${c.p}">
        <span class="rank">${i + 1}</span>
        <span class="score"><span class="score-num">${fmtMetric(val)}</span></span>
        <span class="who">
          <span class="who-top">${flag(c.nat)}<b>${esc(c.f||c.n)}</b>
            ${c.playing ? "" : '<em class="gone-tag">retired</em>'}
            ${c.thin ? `<em class="thin-tag" title="Only ${c.b.toLocaleString()} balls">thin</em>` : ""}</span>
          <span class="who-sub">${esc(titled(c.r||c.c))} · <b class="clubnow">${
            esc(c.nat||"—")}</b> · ${esc(EXPOSURE[c.e]||titled(c.e))}</span>
        </span>
        <span class="facts">${cells.map(([k,v]) =>
          `<span class="meta-cell"><i>${esc(k)}</i>${esc(v)}</span>`).join("")}</span>
        <span class="why">Open to see his profile and who else looks like him.</span>
      </button>
      <span class="rowacts">
        <button class="savebtn${isSaved?" on":""}" data-save="${c.u}" aria-pressed="${isSaved}"
          title="${isSaved?"Remove from shortlist":"Save to shortlist"}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16l-5-4-5 4z"
            fill="${isSaved?"currentColor":"none"}" stroke="currentColor" stroke-width="1.8"
            stroke-linejoin="round"/></svg></button>
        <button class="addbtn${inCmp?" on":""}" data-add="${c.u}" aria-pressed="${inCmp}"
          ${!inCmp && full ? "disabled" : ""}
          title="${inCmp?"Remove from comparison":full?"Comparison is full":"Add to comparison"}"
          >${inCmp ? "&minus;" : "+"}</button></span>
    </li>`;
  }).join("");

  // 25 at a time, because a list of 639 is not a list.
  if (rows.length < eligible){
    const more = Math.min(25, eligible - rows.length);
    $("matches").insertAdjacentHTML("beforeend",
      `<li class="more-row"><button class="ghost" id="show-more"
        >Show ${more} more — ${(eligible - rows.length).toLocaleString()} left</button></li>`);
    const btn = $("show-more");
    if (btn) btn.onclick = () => { state.limit = (state.limit || 25) + 25; draw(); };
  }

  $("matches").querySelectorAll("[data-open]").forEach(b =>
    b.onclick = () => select(b.dataset.open));
  $("matches").querySelectorAll(".addbtn").forEach(b => b.onclick = () => {
    const i = state.compare.indexOf(b.dataset.add);
    if (i >= 0) state.compare.splice(i,1);
    else if (state.compare.length < MAX_COMPARE - 1) state.compare.push(b.dataset.add);
    draw();
  });
  $("matches").querySelectorAll(".savebtn").forEach(b =>
    b.onclick = () => slToggle(b.dataset.save));
  const sel = $("shape-sort");
  if (sel) sel.onchange = e => { state.shape.sort = e.target.value; state.limit = 25; draw(); };
}

function renderCompare(){
  const series = compareSeries(), saved = slRead();
  const base = entry() || (series[0] || {}).p;
  if (!base) return;
  $("tray").innerHTML = series.map((s,i) => {
    const on = saved.includes(s.p.u);
    const sv = `<button class="traysave${on?" on":""}" data-tsave="${s.p.u}"
      aria-pressed="${on}" title="${on?"Remove from shortlist":"Save to shortlist"}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16l-5-4-5 4z"
        fill="${on?"currentColor":"none"}" stroke="currentColor" stroke-width="1.8"
        stroke-linejoin="round"/></svg></button>`;
    const sc = i === 0 ? null : scoreAgainst(base, s.p);
    return `<span class="trayitem ${s.colour}">
      <i class="swatch"></i>${flag(s.p.nat)}<b>${esc(s.p.f||s.p.n)}</b>
      ${i===0 && entry() ? '<span class="base-tag">searched</span>' + sv
        : `<span class="tray-score${sc==null?" na":""}" title="${sc==null
             ? `Different role (${esc(titled(s.p.c))} against ${esc(titled(base.c))}) — the two are scored in separate spaces, so there is no distance between them`
             : `Match score against ${esc(base.f||base.n)}`}">${
             sc==null?"—":sc.toFixed(0)}</span>
           <button class="traybtn" data-scout="${s.p.p}">Scout instead</button>${sv}
           <button class="dropbtn" data-drop="${s.p.u}" aria-label="Remove">&times;</button>`}
    </span>`;
  }).join("") + (state.compare.length < MAX_COMPARE-1
    ? `<span class="trayhint">or pick from <button class="linkish"
       data-goto="similar">Similar players</button></span>` : "");
  $("tray").querySelectorAll("[data-drop]").forEach(b => b.onclick = () => {
    state.compare = state.compare.filter(u => u !== b.dataset.drop); draw(); });
  $("tray").querySelectorAll("[data-scout]").forEach(b => b.onclick = () => select(b.dataset.scout));
  $("tray").querySelectorAll("[data-tsave]").forEach(b => b.onclick = () => slToggle(b.dataset.tsave));
  $("tray").querySelectorAll("[data-goto]").forEach(b => b.onclick = () => setTab("similar"));

  const room = MAX_COMPARE - 1 - state.compare.length;
  $("cmp-add-note").textContent = room > 0
    ? `Room for ${room} more. Anyone in the pool can be added — they do not have to appear in the similar list.`
    : "The comparison is full. Remove someone to add another.";
  $("cmp-search").disabled = room <= 0;

  if (series.length < 2){
    $("compare-body").hidden = true; $("compare-empty").hidden = false;
    $("compare-empty").innerHTML = `Nothing to compare yet. Open <button class="linkish"
      data-goto2="similar">Similar players</button> and press <b>+</b> on up to
      ${MAX_COMPARE-1} of them.`;
    $("compare-empty").querySelectorAll("[data-goto2]").forEach(b =>
      b.onclick = () => setTab("similar"));
    return;
  }
  $("compare-body").hidden = false; $("compare-empty").hidden = true;

  const mt = D.spaces[base.d][base.c].mt;
  const mixed = series.some(s => s.p.c !== base.c || s.p.d !== base.d);
  $("cmp-radar-sub").textContent = mixed
    ? "Percentiles are against each player's own role, so the shapes compare roles rather than raw output."
    : `Percentile among ${D.spaces[base.d][base.c].n} ${titled(base.c).toLowerCase()}s.`;
  $("cmp-radar").innerHTML = radarSvg(series.map(s => ({colour:s.colour, pct:s.p.pc})),
    mt.slice(0,8), LABEL, {label:`Comparison of ${series.map(s=>s.p.f||s.p.n).join(", ")}`});
  renderCompareMetrics(series, mt);
  renderTrend(series);
}
function renderCompareMetrics(series, mt){
  const el = $("cmp-metrics");
  // Adjusted is what the model compares on; actual is what the player did. Both
  // are worth seeing, and which one you are looking at should never be a guess.
  const useActual = state.metricView === "actual";
  const valOf = (p, m) => (useActual ? p.act : p.ad)[m];
  if (el.style && el.style.setProperty) el.style.setProperty("--cols", series.length);
  el.innerHTML = `<div class="mlegend">${series.map(s =>
      `<span class="lg"><i class="sw ${s.colour}"></i>${esc(s.p.f||s.p.n)}</span>`).join("")}
      <span class="mview"><button data-mview="adjusted" aria-pressed="${!useActual}"
        title="Levelled so competitions compare — what this would be worth against a common standard"
        >Adjusted</button><button data-mview="actual" aria-pressed="${useActual}"
        title="What the player actually did, before any levelling">Actual</button></span></div>`
    + mt.map(m => {
    const vals = series.map(s => ({...s, pct:s.p.pc[m] ?? 50, val:valOf(s.p, m)}));
    const best = Math.max(...vals.map(v=>v.pct));
    const lo = Math.min(...vals.map(v=>v.pct)), hi = Math.max(...vals.map(v=>v.pct));
    return `<div class="mrow"><span class="mlabel">${esc(LABEL[m]||m)}</span>
      <span class="mtrack"><span class="mmid"></span>
        <span class="mspan" style="left:${lo}%;width:${(hi-lo).toFixed(1)}%"></span>
        ${vals.map(v => `<span class="mdot ${v.colour}" style="left:${v.pct}%"
          title="${esc(v.p.f||v.p.n)}: ${fmtMetric(v.val)} — ${Math.round(v.pct)}th percentile among ${
            esc(titled(v.p.c))}s"></span>`).join("")}
      </span>${vals.map(v => `<span class="mv ${v.colour}${v.pct===best?" lead":""}"
        >${fmtMetric(v.val)}</span>`).join("")}</div>`;
  }).join("");
}
function renderTrend(series){
  const bat = series[0].p.d === "batting", key = bat ? "sr" : "econ";
  // The pipeline already keys history by the calendar year the cricket was
  // played in, read from match dates rather than from the season label — the
  // label said 2020/21 for an IPL played entirely inside 2020.
  const years = [...new Set(series.flatMap(s =>
    (s.p.sea||[]).filter(r => r[key] != null).map(r => +r.season)))]
    .filter(Number.isFinite).sort((a,b) => a-b);
  const seasons = years.map(String);
  const lines = series.map(s => {
    const map = new Map((s.p.sea||[]).filter(r => r[key] != null)
      .map(r => [String(r.season), r]));
    return {...s, points: seasons.map(x => map.get(x) || null)};
  });
  const vals = lines.flatMap(l => l.points.filter(Boolean).map(r => r[key]));
  if (!seasons.length || !vals.length){
    $("cmp-trend").innerHTML = `<p class="cmp-add-note">No season-by-season record.</p>`;
    $("cmp-trend-sub").textContent = ""; return;
  }
  // Name the gaps rather than leaving a hole for the reader to interpret.
  const gaps = lines.flatMap(l => {
    const idx = l.points.map((d,i) => d ? i : -1).filter(i => i >= 0);
    if (idx.length < 2) return [];
    const missing = [];
    for (let i = idx[0]; i <= idx[idx.length-1]; i++)
      if (!l.points[i]) missing.push(seasons[i]);
    return missing.length ? [`${l.p.f || l.p.n} (${missing.join(", ")})`] : [];
  });
  // "No qualifying cricket" read as though the player had not played at all.
  // Bumrah bowled 48 balls of T20 in 2023 — one short series, no IPL, back
  // surgery. Say the threshold instead of implying absence.
  const floor = D.minSeasonBalls;
  $("cmp-trend-sub").textContent =
    (bat ? `Strike rate by calendar year, pooling every competition played that year. `
         : `Economy by calendar year, pooling every competition played that year. `)
    + `A year needs ${floor} balls to form a rate.`
    + (gaps.length ? ` Under that here: ${gaps.join("; ")}.` : "");
  const top = Math.max(...vals) * 1.1, bottom = bat ? 0 : Math.max(0, Math.min(...vals) - 1.5);
  const W=700,H=250,padL=62,padR=22,padT=18,padB=46;
  const x = i => padL + (i*(W-padL-padR))/Math.max(1, seasons.length-1);
  const y = v => H-padB - ((v-bottom)/(top-bottom||1))*(H-padT-padB);
  const grid = [0,.25,.5,.75,1].map(f => {
    const v = bottom + (top-bottom)*f;
    return `<line class="tgrid" x1="${padL}" x2="${W-padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
      <text class="taxis" x="${padL-8}" y="${(y(v)+3.5).toFixed(1)}" text-anchor="end">${v.toFixed(bat?0:1)}</text>`;
  }).join("");
  const paths = lines.map(l => {
    const chunks=[]; let cur=[];
    l.points.forEach((d,i)=>{ if(d) cur.push(`${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`);
      else { if(cur.length) chunks.push(cur); cur=[]; } });
    if (cur.length) chunks.push(cur);
    const dots = l.points.map((d,i)=> d
      ? `<circle class="tdot ${l.colour}" cx="${x(i).toFixed(1)}" cy="${y(d[key]).toFixed(1)}" r="3.6">
          <title>${esc(l.p.f||l.p.n)} — ${esc(seasons[i])}: ${d[key].toFixed(bat?1:2)} from ${
            d.balls} balls${d.from ? ` (${esc(d.from)})` : ""}</title></circle>` : "").join("");
    return `<g class="tline ${l.colour}">${chunks.map(c=>`<polyline points="${c.join(" ")}"/>`).join("")}</g>${dots}`;
  }).join("");
  const xl = seasons.map((sn,i) => `<text class="taxis" x="${x(i).toFixed(1)}" y="${H-padB+18}"
    text-anchor="${i===0?"start":i===seasons.length-1?"end":"middle"}">${esc(sn)}</text>`).join("");
  $("cmp-trend").innerHTML = `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Form by season">${grid}${paths}${xl}
    <text class="taxis title" transform="translate(13,${((H-padB+padT)/2).toFixed(1)}) rotate(-90)"
      text-anchor="middle">${bat?"Strike rate":"Economy"}</text>
    <text class="taxis title" x="${(W+padL-padR)/2}" y="${H-6}" text-anchor="middle">Season</text>
  </svg><div class="tlegend">${series.map(s =>
    `<span class="lg"><i class="sw ${s.colour}"></i>${esc(s.p.f||s.p.n)}</span>`).join("")}</div>`;
}

function setTab(t){ state.tab = t; draw(); }

function draw(){
  const shapeOnly = !entry() && !!state.shape;
  // Compare stays open in a shape search as soon as two players are picked;
  // only the profile needs someone opened.
  const canCompare = !shapeOnly || state.compare.length >= 2;
  if (shapeOnly && state.tab === "profile") state.tab = "similar";
  if (state.tab === "compare" && !canCompare) state.tab = "similar";
  document.querySelectorAll('#tabs [data-tab="profile"]').forEach(b => b.disabled = shapeOnly);
  document.querySelectorAll('#tabs [data-tab="compare"]').forEach(b => b.disabled = !canCompare);
  $("ccount").textContent = state.compare.length
    ? ` (${state.compare.length + (entry() ? 1 : 0)})` : "";
  ["profile","similar","compare"].forEach(t => {
    $("panel-" + t).hidden = state.tab !== t;
    document.querySelectorAll(`#tabs [data-tab="${t}"]`).forEach(b =>
      b.setAttribute("aria-selected", String(state.tab === t)));
  });
  playerbar();
  if (state.tab === "profile") $("pane").innerHTML = paneProfile();
  else if (state.tab === "similar") renderResults();
  else renderCompare();
  document.querySelectorAll("[data-career]").forEach(b =>
    b.onclick = () => { state.career = b.dataset.career; draw(); });
  // Wired here rather than inside each renderer, because the toggle appears in
  // two panels and an unwired control is worse than no control.
  document.querySelectorAll("[data-mview]").forEach(b =>
    b.onclick = () => { state.metricView = b.dataset.mview; draw(); });
  document.querySelectorAll("[data-disc]").forEach(b =>
    b.onclick = () => { state.disc = b.dataset.disc; state.compare = []; draw(); });
}

$("search").addEventListener("input",e=>{state.sugg=-1;renderSugg(e.target.value);});
$("search").addEventListener("keydown",e=>{
  const box=$("suggestions"); if(box.hidden) return;
  const n=box.querySelectorAll("li").length;
  if(e.key==="ArrowDown"){state.sugg=Math.min(n-1,state.sugg+1);e.preventDefault();}
  else if(e.key==="ArrowUp"){state.sugg=Math.max(0,state.sugg-1);e.preventDefault();}
  else if(e.key==="Enter"){const b=box.querySelectorAll("li")[Math.max(0,state.sugg)];if(b)b.click();return;}
  else if(e.key==="Escape"){box.hidden=true;return;} else return;
  renderSugg($("search").value);
});
document.addEventListener("click",e=>{
  if(!e.target.closest(".finder")) $("suggestions").hidden=true;
  if(!e.target.closest(".multi")) document.querySelectorAll(".multi-panel").forEach(p=>p.hidden=true);
});
document.querySelectorAll("#tabs button").forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
document.querySelectorAll("[data-mode]").forEach(b=>b.onclick=()=>setMode(b.dataset.mode));

/* ── sport switcher, from the channel ────────────────────
   Rendered rather than hard-coded so a sport that is not live here shows
   disabled, exactly as it does on the football page. */
const SPORTS = (window.PS_CHANNEL && window.PS_CHANNEL.sports) || [
  {id:"football", name:"Football", status:"live"},
  {id:"cricket",  name:"Cricket",  status:"live"},
  {id:"kabaddi",  name:"Kabaddi",  status:"soon"},
];
$("sports").innerHTML = SPORTS.map(s => {
  if (s.id === "cricket")
    return `<button class="sport" type="button" aria-current="true">${esc(s.name)}</button>`;
  if (s.status !== "live")
    return `<button class="sport" type="button" disabled aria-current="false">${esc(s.name)}</button>`;
  return `<a class="sport" href="${esc(s.id === "football" ? "index" : s.id)}.html"
     aria-current="false">${esc(s.name)}</a>`;
}).join("");

/* ── radar, lifted from football's app.js ────────────────
   Same drawing, same classes, so it inherits style.css and the two sports read
   as one tool. */
const isNarrow = () => (typeof window.matchMedia === "function"
  ? window.matchMedia("(max-width: 680px)").matches : window.innerWidth <= 680);

function wrapLabel(text){
  const words = String(text).split(" ");
  if (words.length < 3) return [text];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}
function fmtMetric(v){
  if (v == null) return "—";
  return Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(Math.abs(v) < 10 ? 2 : 1);
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

/* ── shortlist ───────────────────────────────────────────
   Scoped per channel and per sport: this origin is shared with every other
   project on the account, and football's list must not be touched. */
const SL_KEY = `ps.${(window.PS_CHANNEL||{}).channel || "prod"}.cricket.shortlist`;
function slRead(){
  try { return JSON.parse(localStorage.getItem(SL_KEY) || "[]"); } catch { return []; }
}
function slWrite(v){ try { localStorage.setItem(SL_KEY, JSON.stringify(v)); } catch {} }
function slToggle(uid){
  const l = slRead(), i = l.indexOf(uid);
  if (i >= 0) l.splice(i,1); else l.push(uid);
  slWrite(l); renderShortlist(); draw();
}
function renderShortlist(){
  const l = slRead().map(u => byUid[u]).filter(Boolean);
  const btn = $("short-btn");
  btn.disabled = false;
  btn.classList.toggle("has", l.length > 0);
  btn.querySelector("span").textContent = l.length ? `Shortlist ${l.length}` : "Shortlist";
  $("short-list").innerHTML = l.length
    ? l.map(x => `<li>
        <button class="short-open" data-open="${x.p}">${flag(x.nat)}
          <span><b>${esc(x.f||x.n)}</b>
          <em>${esc(titled(x.r||x.c))}${x.nat?` · ${esc(x.nat)}`:""}${
            x.a?` · ${Math.floor(x.a)}`:""}</em></span></button>
        <button class="dropbtn" data-unsave="${x.u}" aria-label="Remove">&times;</button>
      </li>`).join("")
    : `<li class="short-empty">Nothing saved yet. Open a player and use
        <b>Save to shortlist</b>, or the bookmark on any result row.</li>`;
  $("short-panel").querySelectorAll("[data-open]").forEach(b =>
    b.onclick = () => { $("short-panel").hidden = true; select(b.dataset.open); });
  $("sl-clear").hidden = !l.length;
  $("sl-clear").onclick = () => { slWrite([]); renderShortlist(); draw(); };
  $("short-panel").querySelectorAll("[data-unsave]").forEach(b =>
    b.onclick = () => slToggle(b.dataset.unsave));
  $("short-btn").onclick = () => {
    const panel = $("short-panel"), open = panel.hidden;
    panel.hidden = !open;
    $("short-btn").setAttribute("aria-expanded", String(open));
    $("fresh-panel").hidden = true;
  };
  $("sl-export").hidden = !l.length;
  $("sl-export").onclick = async () => {
    exportCsv(l, "cricket-shortlist");
    await exportMatchesCsv(l, "cricket-shortlist-matches");
  };
}

/* Every column the tool holds, for a list of players. A shortlist leaves here
   and is worked on elsewhere, so the export is the handover, not a summary. */
async function exportMatchesCsv(list, stem){
  // A second table — every innings of every shortlisted player — so the export
  // carries the match log, not only the summary. Fetched per player, the same
  // files the modal uses; a player with no match file is simply skipped.
  const head = ["player","country","date","format","team","opponent","result",
    "runs","not_out","balls","fours","sixes","strike_rate",
    "overs","runs_conceded","wickets","economy","dismissal"];
  const rows = [];
  for (const p of list){
    let data = matchLogCache[p.p];
    if (!data){
      try {
        const r = await fetch(`${BASE}/matches/${p.p}.json`);
        data = r.ok ? await r.json() : {matches: []};
      } catch { data = {matches: []}; }
      matchLogCache[p.p] = data;
    }
    for (const m of (data.matches || [])){
      const b = m.bat, w = m.bowl;
      rows.push([
        p.f || p.n, p.nat || "", m.date || "", m.fmt || "",
        m.team || "", m.opp || "", m.result || "",
        b ? b.r : "", b ? (b.no ? "yes" : "no") : "", b ? b.b : "",
        b ? b["4"] : "", b ? b["6"] : "", b && b.sr != null ? b.sr : "",
        w ? w.o : "", w ? w.r : "", w ? w.w : "", w && w.econ != null ? w.econ : "",
        b ? (b.no ? "not out" : (b.out || "")) : ""]);
    }
  }
  if (!rows.length) return;
  const csv = "\uFEFF" + [head, ...rows].map(r =>
    r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv;charset=utf-8"}));
  a.download = `${stem}-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

function exportCsv(list, stem){
  if (!list.length) return;
  const mt = u => (D.spaces[u.d] && D.spaces[u.d][u.c] ? D.spaces[u.d][u.c].mt : []);
  const metrics = [...new Set(list.flatMap(mt))];
  const head = ["name","short_name","country","discipline","role","cell","age",
    "exposure","keeper","thin","matches","balls","effective_balls","debut",
    "last_played","still_playing","cricinfo",
    ...["runs","balls_faced","outs","fours","sixes","dots","wickets"].map(c => "career_" + c),
    ...["international","franchise","domestic"].map(g => "balls_" + g),
    ...Object.keys(D.compNames).map(c => "balls_" + c),
    ...metrics.map(m => "actual_" + m),
    ...metrics.map(m => "adjusted_" + m),
    ...metrics.map(m => "percentile_" + m)];
  const rows = list.map(x => {
    const t = (x.car || {}).total || {};
    const grp = g => Object.entries(x.tb || {}).filter(([k]) =>
      (k.startsWith("international") ? "international"
       : k === "franchise" ? "franchise" : "domestic") === g)
      .reduce((a,[,v]) => a + v, 0) || "";
    return [x.f || x.n, x.n, x.nat || "", x.d, titled(x.r || x.c), x.c,
      x.a ? Math.floor(x.a) : "", EXPOSURE[x.e] || x.e, x.kp ? "yes" : "no",
      x.thin ? "yes" : "no", x.m, x.b, x.eb,
      (x.fs||"").slice(0,10), (x.ls||"").slice(0,10), x.playing ? "yes" : "no",
      x.ci || "",
      t.runs ?? "", t.balls_raw ?? "", t.outs ?? "", t.fours ?? "", t.sixes ?? "",
      t.dots ?? "", t.wkts ?? "",
      ...["international","franchise","domestic"].map(grp),
      ...Object.keys(D.compNames).map(c => (x.cb||{})[c] ?? ""),
      ...metrics.map(m => (x.act||{})[m] ?? ""),
      ...metrics.map(m => (x.ad||{})[m] ?? ""),
      ...metrics.map(m => (x.pc||{})[m] ?? "")];
  });
  // UTF-8 BOM so Excel reads the names properly rather than mangling them.
  const csv = "\uFEFF" + [head, ...rows].map(r =>
    r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv;charset=utf-8"}));
  a.download = `${stem}-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

/* ── mode, chosen from the landing routes ───────────────
   Mode used to live in the tab row, which only exists after a search — so the
   choice was unreachable exactly when it was wanted. The two routes on the
   landing are the chooser, and picking one sets the filters that go with it. */
function setMode(mode, quiet){
  state.mode = mode;
  document.querySelectorAll("[data-mode]").forEach(x =>
    x.setAttribute("aria-pressed", String(x.dataset.mode === mode)));
  document.querySelectorAll(".route").forEach(r =>
    r.setAttribute("aria-pressed", String(r.dataset.route === mode)));
  if (mode === "scout"){ state.f.minBalls = 300; state.f.active = true; state.showMore = true; }
  else { state.f.minBalls = 0; state.f.exposure = "any"; state.showMore = false; }
  const hint = $("route-hint");
  if (hint) hint.textContent = mode === "scout"
    ? "Scouting: describe the player you want. 300 balls minimum, all filters open."
    : "Exploring: the whole pool, no minimum.";
  const wiz = $("wizard");
  if (wiz) wiz.hidden = mode !== "scout";
  if (mode === "scout") renderWizard();
  if (!quiet) draw();
}
document.querySelectorAll(".route").forEach(r => {
  r.onclick = () => setMode(r.dataset.route);
  r.onkeydown = e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); r.click(); } };
});
$("wiz-go").onclick = wizGo;
$("wiz-reset").onclick = () => {
  state.wiz = {disc:null, cell:null, age:"any", exposure:"any",
               comps:[], countries:[], active:true};
  renderWizard();
};
setMode("explore", true);

/* ── landing, in football's markup ──────────────────────── */
const PICKS = ["V Kohli","JJ Bumrah","SA Yadav","Rashid Khan","RA Jadeja"];
$("examples").innerHTML = PICKS.map(n => {
  const p = D.players.find(x => x.n === n);
  return p ? `<button class="pick" data-pid="${p.p}">${flag(p.nat)}${esc(p.f||p.n)}</button>` : "";
}).join("");
document.querySelectorAll(".pick").forEach(b => b.onclick = () => select(b.dataset.pid));

const people = new Set(D.players.map(p => p.p));
const playing = new Set(D.players.filter(p => p.playing).map(p => p.p));
$("bigstats").innerHTML = [
  [people.size.toLocaleString(), "players"],
  [playing.size.toLocaleString(), "still playing"],
  [D.comps.length, "competitions"],
].map(([v,k]) => `<div><b>${v}</b><span>${esc(k)}</span></div>`).join("");

const COMP_COUNTRY = {ipl:"India", sma:"India", ntb:"England", hnd:"England",
  bbl:"Australia", psl:"Pakistan", cpl:"West Indies", sat:"South Africa",
  ctc:"South Africa", msl:"South Africa", bpl:"Bangladesh", lpl:"Sri Lanka",
  ssm:"New Zealand", mlc:"United States", ilt:"UAE", npl:"Nepal",
  etpl:"Europe", mct:"Nepal", t20i_full:"", t20i_estab:"", t20i_minor:""};
const seen = {};
D.players.forEach(p => Object.keys(p.cb||{}).forEach(c =>
  (seen[c] = seen[c] || new Set()).add(p.p)));
$("complist").innerHTML = Object.entries(seen)
  .sort((a,b) => b[1].size - a[1].size).slice(0,10)
  .map(([c,set]) => {
    const name = D.compNames[c] || c;
    const short = name.split(/\s+/).map(w => w[0]).join("").slice(0,3).toUpperCase();
    const note = D.compNotes[c];
    return `<li${note ? ` title="${esc(note)}"` : ""}>
      <span class="lmark letters">${short}</span>
      <span class="lname">${esc(name)}${note ? ` <button type="button" class="qmark"
        data-hint="${esc(note)}" aria-label="What this competition is">?</button>` : ""}</span>
      <span class="lcountry">${set.size.toLocaleString()}</span></li>`;
  }).join("");

const roleCount = {};
D.players.forEach(p => roleCount[p.c] = (roleCount[p.c]||0) + 1);
const ROLES = ["opener","top middle","middle","finisher","pace","spin"]
  .filter(r => roleCount[r]).sort((a,b) => roleCount[b]-roleCount[a]);
const topRole = Math.max(...ROLES.map(r => roleCount[r]));
$("rolebars").innerHTML = `<h3>Players by role</h3>` + ROLES.map(r =>
  `<div class="posrow"><span>${titled(r)}</span>
    <span class="postrack"><span style="width:${(roleCount[r]/topRole*100).toFixed(1)}%"></span></span>
    <b>${roleCount[r]}</b></div>`).join("");

/* ── freshness ──────────────────────────────────────────
   Same panel football has, including the time zone switch. The choice is
   remembered, because someone who reads in UTC reads in UTC every time. */
const TZ_KEY = `ps.${(window.PS_CHANNEL||{}).channel || "prod"}.tz`;
try { state.tz = localStorage.getItem(TZ_KEY) || "IST"; } catch { state.tz = "IST"; }

function fmtStamp(iso, tz){
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleString("en-GB", {
    timeZone: tz === "UTC" ? "UTC" : "Asia/Kolkata",
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).replace(",", "") + ` ${tz}`;
}
function sinceText(iso, tz){
  // Calendar days in the zone on screen, not elapsed hours. A run at 08:50 on
  // the 22nd read "today" all through the 23rd, because 23 hours floors to nought.
  const zone = tz === "UTC" ? "UTC" : "Asia/Kolkata";
  const dayIn = d => {
    const p = new Intl.DateTimeFormat("en-CA", {timeZone: zone,
      year: "numeric", month: "2-digit", day: "numeric"}).format(d);
    return Date.UTC(+p.slice(0,4), +p.slice(5,7) - 1, +p.slice(8,10));
  };
  const days = Math.round((dayIn(new Date()) - dayIn(new Date(iso))) / 864e5);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function renderFreshness(){
  if (!D.built) return;
  const tz = state.tz;
  $("fresh-label").textContent = `Updated ${sinceText(D.built, tz)}`;
  $("fresh-btn").title = fmtStamp(D.built, tz) || "";

  // Three things get called "updated" and people conflate them: when the model
  // last ran, how far the cricket goes, and how much of it there is.
  const latest = D.players.reduce((a,p) => p.ls && p.ls > a ? p.ls : a, "");
  const scored = new Set(D.players.map(p => p.p)).size;
  const metrics = new Set(Object.values(D.spaces)
    .flatMap(v => Object.values(v).flatMap(s => s.mt))).size;
  const rows = [
    ["Model run", fmtStamp(D.built, tz), sinceText(D.built, tz),
     `${scored.toLocaleString()} players scored across ${metrics} metrics`],
    ["Latest match included", latest ? fmtDate(latest) : "—", "",
     `${D.matches.toLocaleString()} matches, ${D.comps.length} competitions`],
  ];
  $("fresh-list").innerHTML = rows.map(([k, when, ago, note]) => `<li>
    <span class="fl-title">${esc(k)}</span>
    <span class="fl-when">${esc(when || "—")}</span>
    ${ago ? `<span class="fl-since">${esc(ago)}</span>` : "<span></span>"}
    <span class="fl-note">${esc(note)}</span></li>`).join("");
  $("fresh-foot").textContent =
    "Cricsheet's rolling window is pulled nightly. A full re-parse of the archive "
    + "runs monthly, which is when revised scorecards are picked up.";
  document.querySelectorAll("[data-tz]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.tz === tz)));
}

renderFreshness();
$("fresh-btn").onclick = () => {
  const panel = $("fresh-panel"), open = panel.hidden;
  panel.hidden = !open;
  $("fresh-btn").setAttribute("aria-expanded", String(open));
  $("short-panel").hidden = true;
};
document.querySelectorAll("[data-tz]").forEach(b => b.onclick = () => {
  state.tz = b.dataset.tz;
  try { localStorage.setItem(TZ_KEY, state.tz); } catch {}
  renderFreshness();
});
document.addEventListener("click", e => {
  if (!e.target.closest(".freshness")) $("fresh-panel").hidden = true;
  if (!e.target.closest(".shortlist-wrap")) $("short-panel").hidden = true;
});


/* ── hints you can actually reach ────────────────────────
   A title attribute is a hover, and a phone has no hover, so every "?" on the
   page was decoration on mobile. They are buttons now, and tapping one opens the
   text beside it. */
const hintPop = (() => {
  let box = null;
  function close(){ if (box) box.hidden = true; }
  function open(el, text){
    if (!box){
      box = document.createElement("div");
      box.className = "hintpop";
      box.setAttribute("role", "status");
      document.body.appendChild(box);
    }
    box.textContent = text;
    box.hidden = false;
    if (el.getBoundingClientRect && box.style){
      const r = el.getBoundingClientRect();
      const w = Math.min(280, (window.innerWidth || 360) - 24);
      box.style.width = w + "px";
      box.style.left = Math.max(12, Math.min(r.left, (window.innerWidth || 360) - w - 12)) + "px";
      box.style.top = (r.bottom + 8) + "px";
    }
  }
  return {open, close, last: null, isOpen: () => !!(box && !box.hidden)};
})();

document.addEventListener("click", e => {
  const mark = e.target.closest && e.target.closest("[data-hint]");
  if (mark){
    e.preventDefault(); e.stopPropagation();
    if (hintPop.isOpen() && mark === hintPop.last){ hintPop.close(); hintPop.last = null; }
    else { hintPop.open(mark, mark.dataset.hint); hintPop.last = mark; }
    return;
  }
  hintPop.close();
});
document.addEventListener("keydown", e => { if (e.key === "Escape"){ hintPop.close(); closeMatchLog(); } });

/* ── method strip ───────────────────────────────────────
   Below 980px the four columns become a swipeable strip with a pill nav, as
   football's does. The pill follows a swipe as well as a tap, or it points at
   the wrong panel the moment someone scrolls by hand. */
(function methodNav(){
  const nav = $("method-nav");
  const cols = [...document.querySelectorAll(".method .mcol")];
  const strip = document.querySelector(".method");
  if (!nav || !cols.length || !strip) return;
  const SHORT = ["Sources", "Measured on", "Levelling", "Does it work"];
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

$("clear").onclick = toLanding;
$("brand").onclick = e => { e.preventDefault(); toLanding(); };

/* ── add anyone to the comparison ───────────────────────── */
let cmpSel = -1;
$("cmp-search").addEventListener("input", e => {
  const box = $("cmp-suggestions"), base = entry();
  // Only people with a profile in the discipline on screen. Adding a batter to a
   // bowling comparison gives a blank line and no score, which looks broken.
  const list = found(e.target.value).filter(x => x.p !== (base && base.p))
    .filter(x => byPlayer[x.p].some(z => z.d === (base && base.d)));
  if (!list.length){ box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = list.map((x,i) => `<li role="option" data-pid="${x.p}"
    aria-selected="${i===cmpSel}">${flag(x.nat)}<span class="sug-name">${esc(x.f||x.n)}</span>
    <span class="sug-meta">${esc(titled(x.r||x.c))}${x.a?" · "+Math.floor(x.a):""}</span></li>`).join("");
  box.querySelectorAll("li").forEach(li => li.onclick = () => {
    const cand = byPlayer[li.dataset.pid].find(z => z.d === (entry()||{}).d);
    if (!cand) return;
    if (cand && !state.compare.includes(cand.u) && state.compare.length < MAX_COMPARE - 1)
      state.compare.push(cand.u);
    $("cmp-search").value = ""; box.hidden = true; draw();
  });
});
document.addEventListener("click", e => {
  if (!e.target.closest(".cmp-add")) $("cmp-suggestions").hidden = true; });

$("attrib").innerHTML = `Match data from <a href="https://cricsheet.org" target="_blank" rel="noopener noreferrer">Cricsheet</a>,
  under the Open Data Commons Attribution Licence. Biography from Wikidata.
  ${D.matches.toLocaleString()} matches.`;
$("withheld").innerHTML = `<b>${D.withheld.matches} matches are missing by design.</b>
  ${esc(D.withheld.summary)} ${esc(D.withheld.reason)}
  <a href="${D.withheld.link}" target="_blank" rel="noopener noreferrer">His explanation</a>.`;

renderShortlist();
draw();
})();
