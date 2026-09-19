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

let D, FLAGS = {};

try {
  const [index, detail, meta, flags] = await Promise.all([
    ...["index","detail","meta"].map(n =>
      fetch(`${BASE}/${n}.json`).then(r => {
        if (!r.ok) throw new Error(`${n}.json ${r.status}`);
        return r.json();
      })),
    fetch("assets/cricket-countries.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
  ]);
  FLAGS = flags || {};
  D = {
    players: index.map(e => {
      const d = (detail[e.player_id] || {})[e.discipline] || {};
      return {u:e.uid, p:e.player_id, n:e.name, f:e.full_name, d:e.discipline,
        c:e.cell, r:e.role, x:e.coords, b:e.balls, eb:e.effective_balls, m:e.matches,
        a:e.age, nat:e.nationality, e:e.exposure, tb:e.tier_balls||{},
        cb:e.competition_balls||{}, kp:!!e.keeper, act:e.active,
        ls:e.last_seen, fs:e.first_seen, pc:d.percentile||{}, ad:d.adjusted||{}};
    }),
    spaces: Object.fromEntries(Object.entries(meta.spaces).map(([k,v]) =>
      [k, Object.fromEntries(Object.entries(v).map(([c,s]) =>
        [c, {md:s.median_distance, n:s.players, mt:s.metrics}]))])),
    withheld: meta.withheld, comps: meta.competitions,
    compNames: meta.competition_names || {}, matches: meta.matches,
    built: meta.built_at
  };
} catch (err) {
  $("pane").innerHTML = `<div class="empty">Cricket data could not be loaded ` +
    `(${esc(err.message)}). If this is staging, the daily job may not have run yet.</div>`;
  return;
}

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
const EXPOSURE = {domestic:"uncapped", franchise:"franchise",
  international_minor:"assoc. int'l", international_established:"assoc. int'l",
  international_full:"international"};
const BLANK = () => ({active:true,exposure:"any",country:"any",comp:"any",keeper:false,
  minAge:"",maxAge:"",minBalls:0,debutSince:""});
const state = {mode:"explore", tab:"profile", sel:null, disc:"batting", sugg:-1,
  compare:[], showMore:false, f:BLANK()};

const norm = s => (s||"").toLowerCase().replace(/[^a-z ]/g,"");
D.players.forEach(p => p._s = norm(p.n)+" "+norm(p.f));
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
  const list=found(term), box=$("sugg");
  if(!list.length){ box.hidden=true; return; }
  box.hidden=false;
  box.innerHTML=list.map((p,i)=>`<button data-pid="${p.p}" class="${i===state.sugg?"on":""}">
    <span>${p.f||p.n}${p.f&&p.f!==p.n?` <span class="meta">${p.n}</span>`:""}</span>
    <span class="meta">${p.nat?p.nat+" · ":""}${p.r||""}${p.a?" · "+Math.floor(p.a):""}</span></button>`).join("");
  box.querySelectorAll("button").forEach(b=>b.onclick=()=>select(b.dataset.pid));
}
function select(pid){
  state.sel=pid; state.compare=[];
  const e=byPlayer[pid];
  state.disc=e.some(x=>x.d==="batting")?"batting":"bowling";
  $("sugg").hidden=true; $("search").value=e[0].f||e[0].n;
  $("hero").hidden=true; $("workspace").hidden=false; $("clear").hidden=false;
  draw();
}

function toLanding(){
  state.sel=null; state.compare=[];
  $("search").value=""; $("clear").hidden=true; $("sugg").hidden=true;
  $("hero").hidden=false; $("workspace").hidden=true;
}
const entry = () => (byPlayer[state.sel]||[]).find(e=>e.d===state.disc);

function passes(c){
  const f=state.f;
  if(f.active&&!c.act) return false;
  if(f.exposure==="uncapped"&&c.e!=="domestic") return false;
  if(f.exposure==="unfranchised"&&!(c.e==="domestic"||c.e==="franchise")) return false;
  if(f.country!=="any"&&c.nat!==f.country) return false;
  if(f.comp!=="any"&&!(c.cb&&c.cb[f.comp])) return false;
  if(f.keeper&&!c.kp) return false;
  if(f.minAge&&(!c.a||c.a<+f.minAge)) return false;
  if(f.maxAge&&(!c.a||c.a>+f.maxAge)) return false;
  if(c.b<f.minBalls) return false;
  if(f.debutSince&&(!c.fs||c.fs.slice(0,4)<f.debutSince)) return false;
  return true;
}
function ranked(){
  const p=entry(); if(!p) return [];
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
function paneProfile(){
  const p=entry();
  if(!p) return `<div class="empty">Search a player to begin.<br>
    ${D.players.length.toLocaleString()} profiles from ${D.matches.toLocaleString()} matches.</div>`;
  const both=byPlayer[p.p].length>1, shrink=Math.round(100*p.eb/Math.max(1,p.b));
  const mt=D.spaces[p.d][p.c].mt;
  const comps=Object.entries(p.cb).sort((a,b)=>b[1]-a[1])
    .map(([k,v])=>`<div><b>${D.compNames[k]||k}</b><span>${v.toLocaleString()}</span></div>`).join("");
  const tiers=Object.entries(p.tb).sort((a,b)=>b[1]-a[1])
    .map(([k,v])=>`<div><b>${EXPOSURE[k]||k}</b><span>${v.toLocaleString()}</span></div>`).join("");
  const bars=mt.map(m=>{
    const v=p.pc[m]; if(v==null) return "";
    const good=LOWER_BETTER.has(m)?100-v:v;
    const col=good>=66?"var(--green)":good>=33?"var(--gold)":"var(--faint)";
    return `<div class="metric"><span class="nm">${LABEL[m]||m}</span>
      <span class="tr"><span style="width:${v}%;background:${col}"></span></span>
      <span class="vl">${p.ad[m]??""}</span></div>`;}).join("");
  return `<div class="card"><h2>${flag(p.nat)}${esc(p.f||p.n)}</h2>
    <div class="sub">${p.r||p.c}${p.nat?" · "+p.nat:""}${p.a?" · age "+Math.floor(p.a):""}</div>
    <div class="tags"><span class="tag ${p.e==="domestic"?"gold":""}">${EXPOSURE[p.e]||p.e}</span>
      ${p.act?'<span class="tag blue">playing</span>':`<span class="tag">last ${(p.ls||"").slice(0,7)}</span>`}
      <span class="tag">${p.m} matches</span>${p.kp?'<span class="tag">keeper</span>':""}
      ${both?`<div class="segmented" style="margin-left:.3rem">
        <button data-disc="batting" aria-pressed="${p.d==="batting"}">Batting</button>
        <button data-disc="bowling" aria-pressed="${p.d==="bowling"}">Bowling</button></div>`:""}
    </div></div>
  <div class="cols">
    <div class="card"><div class="hd">Sample</div>
      <div class="prov"><b>${p.b.toLocaleString()}</b> balls, <b>${p.eb.toLocaleString()}</b> after recency weighting
      <div class="bar"><span style="width:${Math.min(100,shrink)}%"></span></div>
      ${shrink<40?"Thin or dated record — heavily shrunk toward the role average."
                 :"Enough recent cricket to judge on."}</div>
      <div class="hd" style="margin-top:1rem">By competition</div><div class="kv">${comps}</div>
      <div class="hd" style="margin-top:1rem">By standard</div><div class="kv">${tiers}</div>
      <div class="note">Debut ${(p.fs||"").slice(0,4)} · last seen ${(p.ls||"").slice(0,7)}</div></div>
    <div class="card"><div class="hd">Profile — percentile among ${p.c}s</div>${bars}</div>
  </div>`;
}
function paneSimilar(){
  const p=entry();
  if(!p) return `<div class="empty">Search a player first.</div>`;
  const list=ranked();
  const head=filterBar()+`<div class="note" style="margin-bottom:.8rem">Ranked on shape, not
    quality — a player with the same profile is not necessarily as good. Scores are not
    comparable across sample sizes: a thin record is shrunk toward the average and can
    never score as close.</div>`;
  if(!list.length) return head+`<div class="empty">Nothing matches those filters.</div>`;
  return head+list.map(([s,c])=>`<div class="row">
    <div class="score" style="color:${s>=60?"var(--green)":s>=45?"var(--gold)":"var(--faint)"}">${s.toFixed(0)}</div>
    <div><div class="who2">${flag(c.nat)}<span>${esc(c.f||c.n)}</span></div>
      <div class="why">${why(p,c)}</div></div>
    <div class="rmeta">${c.b.toLocaleString()} balls<br>${EXPOSURE[c.e]||c.e}${c.a?" · "+Math.floor(c.a):""}</div>
    <button class="add" data-add="${c.u}" aria-pressed="${state.compare.includes(c.u)}"
      title="Add to comparison">${state.compare.includes(c.u)?"✓":"+"}</button></div>`).join("");
}
function paneCompare(){
  const p=entry();
  const uids=[...(p?[p.u]:[]),...state.compare.filter(u=>!p||u!==p.u)].slice(0,6);
  if(!uids.length) return `<div class="empty">Add players from the similar list to compare them.</div>`;
  const set=uids.map(u=>byUid[u]).filter(Boolean);
  const mt=D.spaces[set[0].d][set[0].c].mt;
  const rows=mt.map(m=>{
    const vals=set.map(x=>x.pc[m]);
    const ok=vals.filter(v=>v!=null);
    const best=ok.length?(LOWER_BETTER.has(m)?Math.min(...ok):Math.max(...ok)):null;
    return `<tr><td>${LABEL[m]||m}</td>${set.map((x,i)=>{
      const v=vals[i]; if(v==null) return "<td>—</td>";
      return `<td class="${v===best?"best":""}">${x.ad[m]??"—"}<span style="color:var(--faint);font-size:.75rem"> ${v}</span></td>`;
    }).join("")}</tr>`;}).join("");
  return `<div class="chips">${set.map(x=>`<span class="chip">${flag(x.nat)}${esc(x.f||x.n)}
      ${p&&x.u===p.u?"":`<button data-drop="${x.u}">×</button>`}</span>`).join("")}</div>
    <div class="card cmp"><table>
      <thead><tr><th>Metric</th>${set.map(x=>`<th>${(x.f||x.n).split(" ").slice(-1)[0]}</th>`).join("")}</tr></thead>
      <tbody><tr><td>Balls</td>${set.map(x=>`<td>${x.b.toLocaleString()}</td>`).join("")}</tr>
      <tr><td>Age</td>${set.map(x=>`<td>${x.a?Math.floor(x.a):"—"}</td>`).join("")}</tr>
      <tr><td>Exposure</td>${set.map(x=>`<td>${EXPOSURE[x.e]||x.e}</td>`).join("")}</tr>
      ${rows}</tbody></table></div>
    <div class="note">Adjusted value, with the percentile within role in grey. Green marks the
    best of those shown, which says nothing about the wider pool.</div>`;
}
function draw(){
  $("ccount").textContent = state.compare.length ? " "+state.compare.length : "";
  document.querySelectorAll("#tabs button").forEach(b=>
    b.setAttribute("aria-selected",String(b.dataset.tab===state.tab)));
  $("pane").innerHTML = state.tab==="profile"?paneProfile()
                      : state.tab==="similar"?paneSimilar():paneCompare();
  document.querySelectorAll("[data-f]").forEach(el=>{
    const k=el.dataset.f;
    if(el.type==="checkbox") el.checked=!!state.f[k]; else el.value=state.f[k];
    el.onchange=e=>{
      state.f[k]= e.target.type==="checkbox" ? e.target.checked
                : k==="minBalls" ? (+e.target.value||0) : e.target.value;
      draw();};
  });
  const m=document.querySelector("[data-more]"); if(m) m.onclick=()=>{state.showMore=true;draw();};
  const r=document.querySelector("[data-reset]"); if(r) r.onclick=()=>{
    state.f=BLANK(); state.f.minBalls=state.mode==="scout"?300:0; draw();};
  document.querySelectorAll("[data-disc]").forEach(b=>
    b.onclick=()=>{state.disc=b.dataset.disc; state.compare=[]; draw();});
  document.querySelectorAll("[data-add]").forEach(b=>b.onclick=()=>{
    const u=b.dataset.add, i=state.compare.indexOf(u);
    if(i>=0) state.compare.splice(i,1); else if(state.compare.length<5) state.compare.push(u);
    draw();});
  document.querySelectorAll("[data-drop]").forEach(b=>b.onclick=()=>{
    state.compare=state.compare.filter(u=>u!==b.dataset.drop); draw();});
}
$("search").addEventListener("input",e=>{state.sugg=-1;renderSugg(e.target.value);});
$("search").addEventListener("keydown",e=>{
  const box=$("sugg"); if(box.hidden) return;
  const n=box.querySelectorAll("li").length;
  if(e.key==="ArrowDown"){state.sugg=Math.min(n-1,state.sugg+1);e.preventDefault();}
  else if(e.key==="ArrowUp"){state.sugg=Math.max(0,state.sugg-1);e.preventDefault();}
  else if(e.key==="Enter"){const b=box.querySelectorAll("li")[Math.max(0,state.sugg)];if(b)b.click();return;}
  else if(e.key==="Escape"){box.hidden=true;return;} else return;
  renderSugg($("search").value);
});
document.addEventListener("click",e=>{if(!e.target.closest(".finder"))$("sugg").hidden=true;});
document.querySelectorAll("#tabs button").forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;draw();});
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
  if (mode === "scout"){ state.f.minBalls = 300; state.f.active = true;
                         state.f.exposure = "uncapped"; state.showMore = true; }
  else { state.f.minBalls = 0; state.f.exposure = "any"; }
  const hint = $("route-hint");
  if (hint) hint.textContent = mode === "scout"
    ? "Scouting: uncapped players only, 300 balls minimum, all filters open."
    : "Exploring: the whole pool, no minimum.";
  if (!quiet) draw();
}
document.querySelectorAll(".route").forEach(r => {
  r.onclick = () => setMode(r.dataset.route);
  r.onkeydown = e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); r.click(); } };
});
setMode("explore", true);

/* ── landing, in football's markup ──────────────────────── */
const PICKS = ["V Kohli","JJ Bumrah","SA Yadav","Rashid Khan","RA Jadeja"];
$("examples").innerHTML = PICKS.map(n => {
  const p = D.players.find(x => x.n === n);
  return p ? `<button class="pick" data-pid="${p.p}">${flag(p.nat)}${esc(p.f||p.n)}</button>` : "";
}).join("");
document.querySelectorAll(".pick").forEach(b => b.onclick = () => select(b.dataset.pid));

const people = new Set(D.players.map(p => p.p));
const playing = new Set(D.players.filter(p => p.act).map(p => p.p));
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
    return `<li><span class="lmark letters">${short}</span>
      <span class="lname">${esc(name)}</span>
      <span class="lcountry">${set.size.toLocaleString()}</span></li>`;
  }).join("");

const roleCount = {};
D.players.forEach(p => roleCount[p.c] = (roleCount[p.c]||0) + 1);
const ROLES = ["opener","top middle","middle","finisher","pace","spin"]
  .filter(r => roleCount[r]).sort((a,b) => roleCount[b]-roleCount[a]);
const topRole = Math.max(...ROLES.map(r => roleCount[r]));
$("rolebars").innerHTML = `<h3>Players by role</h3>` + ROLES.map(r =>
  `<div class="posrow"><span>${r[0].toUpperCase()+r.slice(1)}</span>
    <span class="postrack"><span style="width:${(roleCount[r]/topRole*100).toFixed(1)}%"></span></span>
    <b>${roleCount[r]}</b></div>`).join("");

/* ── freshness ──────────────────────────────────────────── */
if (D.built){
  const d = new Date(D.built);
  const days = Math.floor((Date.now() - d) / 864e5);
  $("fresh-label").textContent = days < 1 ? "Updated today"
    : days === 1 ? "Updated yesterday" : `Updated ${days} days ago`;
  $("fresh-list").innerHTML = `<li><span>Model last run</span><b>${
    d.toLocaleString("en-GB",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",
      year:"numeric",hour:"2-digit",minute:"2-digit",hour12:false})} IST</b></li>`;
  $("fresh-foot").textContent =
    "Cricsheet is pulled nightly and the model is rebuilt on the same run.";
  $("fresh-btn").onclick = () => {
    const panel = $("fresh-panel"), open = panel.hidden;
    panel.hidden = !open;
    $("fresh-btn").setAttribute("aria-expanded", String(open));
  };
  document.addEventListener("click", e => {
    if (!e.target.closest(".freshness")) $("fresh-panel").hidden = true; });
}

$("clear").onclick = toLanding;

$("attrib").innerHTML = `Match data from <a href="https://cricsheet.org">Cricsheet</a>,
  under the Open Data Commons Attribution Licence. Biography from Wikidata.
  ${D.matches.toLocaleString()} matches.`;
$("withheld").innerHTML = `<b>${D.withheld.matches} matches are missing by design.</b>
  ${esc(D.withheld.summary)} ${esc(D.withheld.reason)}
  <a href="${D.withheld.link}">His explanation</a>.`;

draw();
})();
