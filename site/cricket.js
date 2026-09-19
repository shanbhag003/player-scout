/* Cricket. A separate page from football on purpose: the two share a shell, a
   stylesheet and a switcher, but not a code path. app.js is sixty-eight kilobytes
   of working, validated football logic and a second sport has no business
   reaching into it. */
(async function(){
const $ = id => document.getElementById(id);
const BASE = "data/cricket";

let D, FLAGS = {};

function fail(msg){ $("pane").innerHTML = `<div class="empty">${msg}</div>`; }

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
  fail(`Cricket data could not be loaded (${err.message}). ` +
       `If this is staging, the daily job may not have run yet.`);
  return;
}

/* A flag where there is one, a lettered badge where there is not. West Indies
   and an ICC XI are teams rather than countries and have no ISO code. */
function flag(nat){
  if (!nat) return "";
  const code = FLAGS[nat];
  if (code) return `<img class="flag" src="assets/flags/${code}.svg" alt="" loading="lazy">`;
  const letters = nat.split(/\s+/).map(w => w[0]).join("").slice(0,2).toUpperCase();
  return `<span class="flag flag-badge">${letters}</span>`;
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
  return `<div class="card"><h2>${flag(p.nat)}${p.f||p.n}</h2>
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
    <div><div class="who2">${flag(c.nat)}<span>${c.f||c.n}</span></div>
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
  return `<div class="chips">${set.map(x=>`<span class="chip">${flag(x.nat)}${x.f||x.n}
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
$("q").addEventListener("input",e=>{state.sugg=-1;renderSugg(e.target.value);});
$("q").addEventListener("keydown",e=>{
  const box=$("sugg"); if(box.hidden) return;
  const n=box.querySelectorAll("button").length;
  if(e.key==="ArrowDown"){state.sugg=Math.min(n-1,state.sugg+1);e.preventDefault();}
  else if(e.key==="ArrowUp"){state.sugg=Math.max(0,state.sugg-1);e.preventDefault();}
  else if(e.key==="Enter"){const b=box.querySelectorAll("button")[Math.max(0,state.sugg)];if(b)b.click();return;}
  else if(e.key==="Escape"){box.hidden=true;return;} else return;
  renderSugg($("q").value);
});
document.addEventListener("click",e=>{if(!e.target.closest(".finder"))$("sugg").hidden=true;});
document.querySelectorAll("#tabs button").forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;draw();});
document.querySelectorAll("[data-mode]").forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
/* ── landing ────────────────────────────────────────── */
const PICKS = ["V Kohli","JJ Bumrah","SA Yadav","Rashid Khan","RA Jadeja"];
$("examples").innerHTML = PICKS.map(n=>{
  const p=D.players.find(x=>x.n===n); if(!p) return "";
  return `<button class="pick" data-pid="${p.p}">${flag(p.nat)}${p.f||p.n}</button>`;
}).join("");
document.querySelectorAll(".pick").forEach(b=>b.onclick=()=>select(b.dataset.pid));

/* The two routes on the landing are the mode chooser. Picking one sets the mode
   and the filters that go with it, so a scout arrives at the results with the
   pool already narrowed instead of having to find the controls first. */
function setMode(mode, quiet){
  state.mode = mode;
  document.querySelectorAll("[data-mode]").forEach(x=>
    x.setAttribute("aria-pressed", String(x.dataset.mode === mode)));
  document.querySelectorAll(".route").forEach(r=>
    r.setAttribute("aria-pressed", String(r.dataset.route === mode)));
  if (mode === "scout"){ state.f.minBalls = 300; state.f.active = true;
                         state.f.exposure = "uncapped"; state.showMore = true; }
  else { state.f.minBalls = 0; state.f.exposure = "any"; }
  if (!quiet) draw();
}
document.querySelectorAll(".route").forEach(r=>{
  r.onclick = () => setMode(r.dataset.route);
  r.onkeydown = e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); r.click(); } };
});
setMode("explore", true);

const people = new Set(D.players.map(p=>p.p));
const playing = new Set(D.players.filter(p=>p.act).map(p=>p.p));
$("bigstats").innerHTML = `
  <div><b>${people.size.toLocaleString()}</b><span>players</span></div>
  <div><b>${playing.size.toLocaleString()}</b><span>still playing</span></div>
  <div><b>${D.comps.length}</b><span>competitions</span></div>`;

// Competitions by how much of the pool has played in them, biggest first.
const compCount = {};
D.players.forEach(p=>Object.keys(p.cb||{}).forEach(c=>{
  compCount[c]=(compCount[c]||new Set()); compCount[c].add(p.p);}));
$("complist").innerHTML = Object.entries(compCount)
  .sort((a,b)=>b[1].size-a[1].size).slice(0,10)
  .map(([c,set])=>`<li><span class="lg-name">${D.compNames[c]||c}</span>
    <span class="lg-side">${set.size.toLocaleString()}</span></li>`).join("");

const roleCount={};
D.players.forEach(p=>roleCount[p.c]=(roleCount[p.c]||0)+1);
const maxRole=Math.max(...Object.values(roleCount));
const ROLE_ORDER=["opener","top middle","middle","finisher","pace","spin"];
$("rolebars").innerHTML = ROLE_ORDER.filter(r=>roleCount[r]).map(r=>
  `<div class="posbar"><span class="pb-name">${r[0].toUpperCase()+r.slice(1)}</span>
   <span class="pb-track"><span style="width:${100*roleCount[r]/maxRole}%"></span></span>
   <span class="pb-val">${roleCount[r]}</span></div>`).join("");

/* ── freshness ──────────────────────────────────────── */
if (D.built){
  const d=new Date(D.built);
  const days=Math.floor((Date.now()-d)/864e5);
  $("fresh-label").textContent = days<1?"Updated today":days===1?"Updated yesterday"
                               :`Updated ${days} days ago`;
  $("fresh-list").innerHTML = `<li><span>Model last run</span><b>${
    d.toLocaleString("en-GB",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",
      year:"numeric",hour:"2-digit",minute:"2-digit",hour12:false})} IST</b></li>`;
  $("fresh-foot").textContent =
    "Cricsheet data is pulled nightly; the model is rebuilt on the same run.";
  $("fresh-btn").onclick=()=>{
    const panel=$("fresh-panel"), open=panel.hidden;
    panel.hidden=!open; $("fresh-btn").setAttribute("aria-expanded",String(open));
  };
  document.addEventListener("click",e=>{
    if(!e.target.closest(".freshness")) $("fresh-panel").hidden=true;});
}

$("clear").onclick = toLanding;

$("attrib").innerHTML=`Match data from <a href="https://cricsheet.org">Cricsheet</a>, used under
  the Open Data Commons Attribution Licence. Biographical data from Wikidata.
  ${D.matches.toLocaleString()} matches.`;
$("withheld").innerHTML=`<b>${D.withheld.matches} matches are missing by design.</b>
  ${D.withheld.summary} ${D.withheld.reason}
  <a href="${D.withheld.link}">His explanation</a>.`;
draw();

})();
