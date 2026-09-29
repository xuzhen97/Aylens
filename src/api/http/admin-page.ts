export type AdminPage =
  | "overview"
  | "runtimes"
  | "providers"
  | "profiles"
  | "audits"
  | "tester";

export const ADMIN_PAGES: Record<AdminPage, {
  path: string;
  label: string;
  title: string;
  description: string;
}> = {
  overview: {
    path: "/admin",
    label: "系统总览",
    title: "基础设施运行总览",
    description: "查看 Gateway、Provider、Runtime、Browser Profile 与最近检索状态摘要。",
  },
  runtimes: {
    path: "/admin/runtimes",
    label: "Runtime / Runner",
    title: "Runtime / Runner",
    description: "查看执行节点、能力声明、容量和最近心跳。",
  },
  providers: {
    path: "/admin/providers",
    label: "Providers",
    title: "Providers",
    description: "查看 Provider 定义、Runtime selector、Browser Profile 与 Transport。",
  },
  profiles: {
    path: "/admin/profiles",
    label: "Browser Profiles",
    title: "Browser Profiles",
    description: "查看逻辑浏览器 Profile；本地敏感路径不会显示。",
  },
  audits: {
    path: "/admin/audits",
    label: "检索审计",
    title: "检索审计",
    description: "查看最近 30 条检索记录、执行状态和耗时。",
  },
  tester: {
    path: "/admin/tester",
    label: "请求测试",
    title: "请求测试",
    description: "直接调用 /v1/search 验证 generic-browser 和 Runner 链路。",
  },
};

function pageBody(page: AdminPage): string {
  if (page === "overview") {
    return [
      '<div class="stats">',
      '<article><small>Gateway</small><b id="sGateway">—</b><span id="sGatewayFoot">等待状态</span></article>',
      '<article><small>Providers</small><b id="sProviders">—</b><span>启用 / 总数</span></article>',
      '<article><small>Runtimes</small><b id="sRuntimes">—</b><span>在线 / 总数</span></article>',
      '<article><small>Profiles</small><b id="sProfiles">—</b><span>逻辑 Profile</span></article>',
      '<article><small>Recent Audits</small><b id="sAudits">—</b><span id="sRefresh">尚未刷新</span></article>',
      '</div>',
      '<div class="two">',
      '<section class="panel"><header><b>Runtime 摘要</b><a href="/admin/runtimes">查看全部 →</a></header><div id="runtimeSummary"></div></section>',
      '<section class="panel"><header><b>最近检索</b><a href="/admin/audits">查看全部 →</a></header><div id="auditSummary"></div></section>',
      '</div>',
      '<div class="quick">',
      '<a href="/admin/tester"><b>运行请求测试</b><span>验证 generic-browser →</span></a>',
      '<a href="/admin/providers"><b>查看 Provider</b><span>检查调度配置 →</span></a>',
      '</div>',
    ].join("");
  }

  if (page === "runtimes") {
    return [
      '<section class="panel">',
      '<header><b>Runtime / Runner</b><span id="runtimeMeta"></span></header>',
      '<div class="table"><table><thead><tr>',
      '<th>Runtime</th><th>状态</th><th>能力</th><th>容量</th><th>最后心跳</th>',
      '</tr></thead><tbody id="runtimeRows"></tbody></table></div>',
      '</section>',
    ].join("");
  }

  if (page === "providers") {
    return '<div class="meta" id="providerMeta"></div><div class="cards" id="providerGrid"></div>';
  }

  if (page === "profiles") {
    return '<div class="meta" id="profileMeta"></div><div class="cards" id="profileGrid"></div>';
  }

  if (page === "audits") {
    return [
      '<section class="panel">',
      '<header><b>最近 30 条检索审计</b><span id="auditMeta"></span></header>',
      '<div class="table"><table><thead><tr>',
      '<th>时间</th><th>状态</th><th>请求</th><th>Provider / Runtime</th><th>耗时</th>',
      '</tr></thead><tbody id="auditRows"></tbody></table></div>',
      '</section>',
    ].join("");
  }

  return [
    '<div class="tester">',
    '<section class="panel form"><form id="searchForm">',
    '<label>查询 / URL<input id="queryInput" placeholder="https://example.com" required></label>',
    '<label>Provider<select id="sourceSelect"><option value="">使用默认路由</option></select></label>',
    '<label>结果上限<input id="limitInput" value="10"></label>',
    '<div class="buttons"><button class="primary" id="searchButton">发送请求</button>',
    '<button type="button" id="clearResultButton">清空结果</button></div>',
    '</form></section>',
    '<section class="panel"><header><b>检索结果</b><span id="resultStatus">尚未执行</span></header>',
    '<div id="resultBody" class="results"><div class="empty">输入 URL 或查询后发送请求。</div></div>',
    '</section></div>',
  ].join("");
}

const CSS = [
  ':root{--bg:#071019;--side:#06101a;--panel:#0f1d2b;--soft:#112234;--input:#091521;--border:#21384a;--text:#eef7ff;--muted:#8fa8ba;--accent:#61dafb;--green:#53e6a4;--yellow:#ffc857;--red:#ff6f8f;--shadow:0 16px 44px #0005;color-scheme:dark;font-family:Inter,system-ui,"Segoe UI","Microsoft YaHei",sans-serif}',
  'html[data-theme="light"]{--bg:#f4f7fa;--side:#fbfcfe;--panel:#fff;--soft:#f6f8fa;--input:#fff;--border:#dce5eb;--text:#182833;--muted:#688092;--accent:#008bb8;--green:#16875e;--yellow:#9a6800;--red:#c63d60;--shadow:0 12px 34px #26384712;color-scheme:light}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}a{color:inherit;text-decoration:none}button,input,select{font:inherit}',
  '.layout{min-height:100vh;display:grid;grid-template-columns:230px 1fr}.side{position:sticky;top:0;height:100vh;padding:22px 16px;background:var(--side);border-right:1px solid var(--border)}',
  '.brand{display:flex;gap:11px;align-items:center;margin:0 7px 28px}.logo{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:#61dafb18;color:var(--accent);border:1px solid var(--border);font-weight:800}.brand small{display:block;color:var(--muted)}',
  'nav{display:grid;gap:5px}nav a{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;color:var(--muted);border:1px solid transparent}nav a:hover,nav a.active{color:var(--text);background:var(--soft);border-color:var(--border)}nav a.active{box-shadow:inset 3px 0 var(--accent)}nav i{width:7px;height:7px;border-radius:50%;background:var(--muted)}nav a.active i{background:var(--accent)}',
  '.key{position:absolute;bottom:20px;left:16px;right:16px;padding:11px;border:1px solid var(--border);border-radius:11px;background:var(--soft);color:var(--muted);font-size:12px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--yellow);margin-right:7px}.dot.ok{background:var(--green)}',
  'main{min-width:0;padding:0 28px 50px}.top{height:72px;display:flex;align-items:center;justify-content:space-between;gap:14px;position:sticky;top:0;z-index:3;background:linear-gradient(var(--bg) 75%,transparent)}.crumb{font-size:12px;color:var(--muted);letter-spacing:.06em}.actions{display:flex;align-items:center;gap:7px}.actions label{font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center}',
  'button,select{min-height:36px;border:1px solid var(--border);border-radius:9px;background:var(--soft);color:var(--text);padding:0 11px}button:hover,select:hover{border-color:var(--accent)}button.primary{background:var(--accent);border-color:var(--accent);color:#06202a;font-weight:700}',
  '.heading{display:flex;justify-content:space-between;gap:20px;padding:28px 0 24px}.heading em{font-style:normal;color:var(--accent);font-size:11px;letter-spacing:.13em;text-transform:uppercase}.heading h1{font-size:36px;letter-spacing:-.04em;margin:7px 0}.heading p{margin:0;color:var(--muted);font-size:14px}.live{align-self:flex-start;color:var(--green);border:1px solid var(--border);border-radius:999px;padding:8px 10px;font-size:12px}',
  '.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:11px;margin-bottom:12px}.stats article,.panel,.quick a,.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow)}.stats article{padding:16px}.stats small,.stats span{display:block;color:var(--muted);font-size:11px}.stats b{display:block;font-size:27px;margin:6px 0}',
  '.two,.quick{display:grid;grid-template-columns:1fr 1fr;gap:12px}.quick{margin-top:12px}.quick a{padding:16px}.quick span{display:block;color:var(--muted);font-size:12px;margin-top:5px}',
  '.panel>header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)}.panel>header span,.meta{color:var(--muted);font-size:11px}.panel>header a{color:var(--accent);font-size:12px}',
  '.summary{display:grid;grid-template-columns:1fr auto;gap:12px;padding:13px 16px;border-bottom:1px solid var(--border)}.summary:last-child{border:0}.summary small{display:block;color:var(--muted);margin-top:4px}.mono{font-family:Consolas,"SFMono-Regular",monospace;font-size:12px}',
  '.badge{display:inline-block;border:1px solid var(--border);border-radius:99px;padding:4px 8px;background:var(--soft);font-size:11px}.green{color:var(--green)}.yellow{color:var(--yellow)}.red{color:var(--red)}.blue{color:var(--accent)}',
  '.table{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:13px 15px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top}th{color:var(--muted);font-size:11px}.chips{display:flex;flex-wrap:wrap;gap:5px}.muted{color:var(--muted);font-size:11px;margin-top:4px}',
  '.meta{text-align:right;margin-bottom:8px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card{padding:16px}.cardhead{display:flex;justify-content:space-between;gap:12px}.cardhead small{display:block;color:var(--muted);margin-top:4px}.details{display:grid;gap:8px;margin-top:16px}.details div{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:12px}.details strong{color:var(--text);text-align:right}',
  '.tester{display:grid;grid-template-columns:minmax(280px,.75fr) minmax(0,1.25fr);gap:12px}.form{padding:17px}.form label{display:block;color:var(--muted);font-size:12px;margin-bottom:13px}.form input,.form select{display:block;width:100%;height:41px;margin-top:7px;border:1px solid var(--border);border-radius:9px;background:var(--input);color:var(--text);padding:0 11px}.buttons{display:flex;gap:8px}.results{padding:14px;display:grid;gap:10px}.empty{min-height:140px;display:grid;place-items:center;color:var(--muted);font-size:12px}.result,.provider-failure{padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--soft)}.result a{color:var(--accent);font-weight:650}.result p{white-space:pre-wrap;color:var(--text);font-size:12px;line-height:1.55}.result small{color:var(--muted)}.provider-failure{border-color:color-mix(in srgb,var(--red) 45%,var(--border));background:color-mix(in srgb,var(--red) 7%,var(--panel))}.provider-failure-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.provider-failure-head strong{font-size:13px}.provider-failure-message{margin:9px 0 0;color:var(--text);font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.provider-failure-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px;color:var(--muted);font-size:11px}.request-failed-note{padding:10px 12px;border-radius:9px;background:color-mix(in srgb,var(--red) 6%,transparent);color:var(--red);font-size:12px}',
  '.modalbg{position:fixed;inset:0;z-index:10;display:none;place-items:center;background:#0009}.modalbg.show{display:grid}.modal{width:min(440px,calc(100vw - 32px));background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:22px}.modal p{color:var(--muted);font-size:13px}.modal input{width:100%;height:42px;background:var(--input);border:1px solid var(--border);border-radius:9px;color:var(--text);padding:0 10px;margin:8px 0 14px}.toast{position:fixed;right:20px;bottom:20px;opacity:0;background:var(--panel);border:1px solid var(--red);color:var(--red);padding:11px;border-radius:9px}.toast.show{opacity:1}',
  '@media(max-width:1000px){.stats{grid-template-columns:repeat(3,1fr)}.cards{grid-template-columns:repeat(2,1fr)}}@media(max-width:760px){.layout{grid-template-columns:1fr}.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--border)}nav{grid-template-columns:repeat(3,1fr)}.key{display:none}main{padding:0 15px 40px}.two,.tester{grid-template-columns:1fr}.top{height:64px}.heading{display:block}.live{display:inline-block;margin-top:14px}}@media(max-width:520px){nav{grid-template-columns:repeat(2,1fr)}.stats,.cards,.quick{grid-template-columns:1fr}.actions label{display:none}.heading h1{font-size:30px}}',
].join("");

const CLIENT_SCRIPT = [
  '(function(){"use strict";',
  'var PAGE=document.body.dataset.page,KEY="aylens.admin.apiKey",THEME="aylens.admin.theme",media=matchMedia("(prefers-color-scheme: dark)");',
  'var state={apiKey:sessionStorage.getItem(KEY)||"",overview:null,timer:null};var $=function(id){return document.getElementById(id)};',
  'function txt(n,v){if(n)n.textContent=v==null?"—":String(v)}',
  'function tone(v){return ["online","completed","ready","success","available"].includes(v)?"green":["degraded","partial","running","draining","busy"].includes(v)?"yellow":["offline","failed"].includes(v)?"red":"blue"}',
  'function badge(v,t){var n=document.createElement("span");n.className="badge "+(t||"");n.textContent=v;return n}',
  'function time(v){return v?new Date(v).toLocaleString("zh-CN",{hour12:false}):"—"}',
  'function ago(v){if(!v)return"—";var d=Date.now()-v;return d<60000?Math.max(0,Math.floor(d/1000))+" 秒前":d<3600000?Math.floor(d/60000)+" 分钟前":time(v)}',
  'function themeMode(){try{return localStorage.getItem(THEME)||"system"}catch(_){return"system"}}',
  'function applyTheme(m){document.documentElement.dataset.theme=m==="system"?(media.matches?"dark":"light"):m;document.documentElement.dataset.themeMode=m;$("themeSelect").value=m}',
  'function saveTheme(m){try{localStorage.setItem(THEME,m)}catch(_){}applyTheme(m)}',
  'function auth(ok){$("keyDot").classList.toggle("ok",ok);txt($("keyState"),ok?"管理 API 已连接":"尚未连接管理 API");txt($("keyButton"),ok?"更换 API Key":"API Key")}',
  'function modal(show){$("authModal").classList.toggle("show",show);if(show){$("apiKeyInput").value=state.apiKey;setTimeout(function(){$("apiKeyInput").focus()},20)}}',
  'function toast(m){var n=$("toast");n.textContent=m;n.classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(function(){n.classList.remove("show")},3500)}',
  'async function req(path,opt){opt=opt||{};var h=Object.assign({},opt.headers||{});if(state.apiKey)h.Authorization="Bearer "+state.apiKey;if(opt.body)h["Content-Type"]="application/json";var r=await fetch(path,Object.assign({},opt,{headers:h})),p=null;try{p=await r.json()}catch(_){}if(r.status===401){auth(false);modal(true);throw Error("API Key 无效")}if(!r.ok)throw Error(p&&p.error&&p.error.message?p.error.message:"请求失败："+r.status);return p}',
  'function runtimeDesc(r){if(!r)return"selector";if(r.nodeId)return"node: "+r.nodeId;var s=r.selector||{};return[s.os,s.providerType,s.browser,s.profile?"profile:"+s.profile:null].filter(Boolean).join(" / ")||"selector"}',
  'function profileStatus(v){return v==="available"?"可用":v==="busy"?"占用中":v==="draining"?"排空中":v==="offline"?"Runner 离线":"未上报"}',
  'function summaryRow(title,sub,status){var r=document.createElement("div");r.className="summary";var l=document.createElement("div"),a=document.createElement("div");a.className="mono";a.textContent=title;var b=document.createElement("small");b.textContent=sub;l.append(a,b);r.append(l,badge(status,tone(status)));return r}',
  'function renderOverview(){var d=state.overview;txt($("sGateway"),"OK");txt($("sGatewayFoot"),d.summary.onlineRuntimes+" 个执行节点在线");txt($("sProviders"),d.summary.enabledProviders+"/"+d.summary.providers);txt($("sRuntimes"),d.summary.onlineRuntimes+"/"+d.summary.runtimes);txt($("sProfiles"),d.summary.browserProfiles);txt($("sAudits"),d.summary.recentAudits);txt($("sRefresh"),new Date(d.generatedAt).toLocaleTimeString("zh-CN",{hour12:false}));var rs=$("runtimeSummary");rs.replaceChildren();d.runtimes.slice(0,5).forEach(function(r){rs.appendChild(summaryRow(r.id,r.hostname+" · "+r.os+" · "+ago(r.lastSeenAt),r.status))});if(!d.runtimes.length)rs.textContent="暂无 Runtime";var as=$("auditSummary");as.replaceChildren();d.audits.slice(0,5).forEach(function(a){as.appendChild(summaryRow(a.request.query,a.requestId+" · "+time(a.createdAt),a.status))});if(!d.audits.length)as.textContent="暂无检索记录"}',
  'function renderRuntimes(){var b=$("runtimeRows"),arr=state.overview.runtimes;b.replaceChildren();txt($("runtimeMeta"),arr.length+" 个节点");arr.forEach(function(r){var tr=document.createElement("tr"),id=document.createElement("td"),id1=document.createElement("div"),id2=document.createElement("div");id1.className="mono";id1.textContent=r.id;id2.className="muted";id2.textContent=r.hostname+" · "+r.os+" · v"+r.version;id.append(id1,id2);var st=document.createElement("td");st.appendChild(badge(r.status,tone(r.status)));var cp=document.createElement("td"),chips=document.createElement("div");chips.className="chips";[].concat(r.capabilities.providerTypes||[],r.capabilities.browsers||[],(r.capabilities.profiles||[]).map(function(v){return"profile:"+v})).forEach(function(v){chips.appendChild(badge(v,"blue"))});cp.appendChild(chips);var cap=document.createElement("td");cap.textContent=r.capacity.activeJobs+" / "+r.capacity.maxJobs;var seen=document.createElement("td");seen.textContent=ago(r.lastSeenAt);tr.append(id,st,cp,cap,seen);b.appendChild(tr)});if(!arr.length){var tr=document.createElement("tr"),td=document.createElement("td");td.colSpan=5;td.className="empty";td.textContent="暂无 Runtime";tr.appendChild(td);b.appendChild(tr)}}',
  'function renderCards(kind){var arr=kind==="providers"?state.overview.providers:state.overview.browserProfiles,grid=$(kind==="providers"?"providerGrid":"profileGrid");grid.replaceChildren();txt($(kind==="providers"?"providerMeta":"profileMeta"),arr.length+" 个"+(kind==="providers"?" Provider":"逻辑 Profile"));arr.forEach(function(x){var c=document.createElement("article");c.className="card";var h=document.createElement("div");h.className="cardhead";var l=document.createElement("div"),n=document.createElement("b");n.className="mono";n.textContent=x.id;var s=document.createElement("small");s.textContent=kind==="providers"?x.type:"Runner · "+x.runtimeId;l.append(n,s);h.append(l,badge(kind==="providers"?(x.enabled?"enabled":"disabled"):(x.browser||"browser"),kind==="providers"?(x.enabled?"green":"red"):"blue"));var ds=document.createElement("div");ds.className="details";var rows=kind==="providers"?[["Runtime",runtimeDesc(x.runtime)]]:[["状态",profileStatus(x.status)],["模式",x.mode||"Runner 未上报"],["Lease",x.activeLeases==null?"Runner 未上报":x.activeLeases+" / "+x.maxConcurrency],["交互",x.interactive==null?"Runner 未上报":(x.interactive?"是":"否")],["Transport",x.transport||"Runner 未上报"]];rows.forEach(function(z){var r=document.createElement("div"),k=document.createElement("span"),v=document.createElement("strong");k.textContent=z[0];v.textContent=z[1];r.append(k,v);ds.appendChild(r)});c.append(h,ds);grid.appendChild(c)});if(!arr.length)grid.textContent="暂无数据"}',
  'function renderAudits(){var b=$("auditRows"),arr=state.overview.audits;b.replaceChildren();txt($("auditMeta"),arr.length+" 条记录");arr.forEach(function(a){var tr=document.createElement("tr"),t=document.createElement("td");t.textContent=time(a.createdAt);var st=document.createElement("td");st.appendChild(badge(a.status,tone(a.status)));var q=document.createElement("td"),q1=document.createElement("div"),q2=document.createElement("div");q1.className="mono";q1.textContent=a.request.query;q2.className="muted mono";q2.textContent=a.requestId;q.append(q1,q2);var p=document.createElement("td"),chips=document.createElement("div");chips.className="chips";(a.providers||[]).forEach(function(e){chips.appendChild(badge(e.providerId+(e.runtimeId?" · "+e.runtimeId:""),tone(e.status)))});p.appendChild(chips);var d=document.createElement("td");d.textContent=a.completedAt?Math.max(0,a.completedAt-a.createdAt)+" ms":"—";tr.append(t,st,q,p,d);b.appendChild(tr)});if(!arr.length){var tr=document.createElement("tr"),td=document.createElement("td");td.colSpan=5;td.className="empty";td.textContent="暂无检索记录";tr.appendChild(td);b.appendChild(tr)}}',
  'function sourceSelect(){var s=$("sourceSelect");if(!s)return;var prev=s.value;var keys=state.overview.providers.filter(function(p){return p.enabled}).map(function(p){return p.id+"\u0000"+p.type}).join("|");if(s.dataset.keys===keys)return;s.replaceChildren();var o=document.createElement("option");o.value="";o.textContent="使用默认路由";s.appendChild(o);state.overview.providers.filter(function(p){return p.enabled}).forEach(function(p){var x=document.createElement("option");x.value=p.id;x.textContent=p.id+" \u00b7 "+p.type;s.appendChild(x)});s.dataset.keys=keys;if(prev&&Array.from(s.options).some(function(opt){return opt.value===prev}))s.value=prev}',
  'function render(){if(PAGE==="overview")renderOverview();if(PAGE==="runtimes")renderRuntimes();if(PAGE==="providers")renderCards("providers");if(PAGE==="profiles")renderCards("profiles");if(PAGE==="audits")renderAudits();if(PAGE==="tester")sourceSelect()}',
  'async function refresh(){if(!state.apiKey){modal(true);return}var b=$("refreshButton");b.disabled=true;try{state.overview=await req("/v1/admin/overview");auth(true);modal(false);txt($("liveText"),"Gateway 正常 · "+state.overview.summary.onlineRuntimes+" 个 Runtime 可用");render()}catch(e){toast(e instanceof Error?e.message:"刷新失败")}finally{b.disabled=false}}',
  'function safeTitle(item){try{var u=new URL(item.url);if(u.protocol==="http:"||u.protocol==="https:"){var a=document.createElement("a");a.href=u.toString();a.target="_blank";a.rel="noopener noreferrer";a.textContent=item.title||item.url;return a}}catch(_){}var n=document.createElement("span");n.textContent=item.title||item.url||"未命名结果";return n}',
  'function appendProviderFailures(body,r){var providers=r.meta&&r.meta.providers?r.meta.providers:{},failures=Object.entries(providers).filter(function(entry){return entry[1]&&entry[1].status==="failed"});if(!failures.length)return 0;var note=document.createElement("div");note.className="request-failed-note";note.textContent=r.status==="partial"?"部分 Provider 执行失败，成功结果仍显示在下方。":"检索执行失败。下面是 Gateway 返回的实际 Provider 错误：";body.appendChild(note);failures.forEach(function(entry){var providerId=entry[0],meta=entry[1],error=meta.error||{};var card=document.createElement("article");card.className="provider-failure";var head=document.createElement("div");head.className="provider-failure-head";var name=document.createElement("strong");name.textContent=providerId;head.append(name,badge(error.code||"UNKNOWN_ERROR","red"));var message=document.createElement("div");message.className="provider-failure-message";message.textContent=error.message||"Provider 执行失败，但没有返回错误消息。";var details=document.createElement("div");details.className="provider-failure-meta";["Runtime: "+(meta.runtimeId||"未返回"),"retryable: "+(error.retryable===true?"true":"false"),"latency: "+(meta.latencyMs==null?"—":meta.latencyMs+" ms")].forEach(function(value){var span=document.createElement("span");span.textContent=value;details.appendChild(span)});card.append(head,message,details);body.appendChild(card)});return failures.length}',
  'function searchResult(r){var b=$("resultBody");b.replaceChildren();txt($("resultStatus"),r.status+" · "+r.items.length+" 条 · "+r.requestId);var failures=appendProviderFailures(b,r);if(!r.items.length){if(!failures){var empty=document.createElement("div");empty.className="empty";empty.textContent="请求完成，但没有返回结果。";b.appendChild(empty)}return}r.items.forEach(function(i){var c=document.createElement("article");c.className="result";var p=document.createElement("p");p.textContent=(i.text||i.snippet||"").slice(0,3000);var m=document.createElement("small");m.textContent=[i.platform,i.provenance&&i.provenance.provider,i.provenance&&i.provenance.runtimeId].filter(Boolean).join(" · ");c.append(safeTitle(i),p,m);b.appendChild(c)})}',
  '$("authForm").addEventListener("submit",function(e){e.preventDefault();state.apiKey=$("apiKeyInput").value.trim();if(state.apiKey){sessionStorage.setItem(KEY,state.apiKey);refresh()}});',
  '$("disconnectButton").addEventListener("click",function(){state.apiKey="";sessionStorage.removeItem(KEY);auth(false);modal(true)});',
  '$("keyButton").addEventListener("click",function(){modal(true)});$("refreshButton").addEventListener("click",refresh);',
  'applyTheme(themeMode());$("themeSelect").addEventListener("change",function(){saveTheme(this.value)});if(media.addEventListener)media.addEventListener("change",function(){if(themeMode()==="system")applyTheme("system")});',
  '$("autoRefresh").addEventListener("change",function(){clearInterval(state.timer);state.timer=this.checked?setInterval(refresh,5000):null});',
  'var form=$("searchForm");if(form){$("clearResultButton").addEventListener("click",function(){$("resultBody").textContent="输入 URL 或查询后发送请求。";txt($("resultStatus"),"尚未执行")});form.addEventListener("submit",async function(e){e.preventDefault();var payload={query:$("queryInput").value.trim(),limit:Math.min(100,Math.max(1,Number($("limitInput").value)||10))},src=$("sourceSelect").value;if(src)payload.sources=[src];$("searchButton").disabled=true;txt($("resultStatus"),"执行中…");try{var r=await req("/v1/search",{method:"POST",body:JSON.stringify(payload)});searchResult(r);await refresh()}catch(err){txt($("resultStatus"),"失败");toast(err.message)}finally{$("searchButton").disabled=false}})}',
  'auth(Boolean(state.apiKey));state.timer=setInterval(refresh,5000);state.apiKey?refresh():modal(true);',
  '})();',
].join("");

export function renderAdminPage(page: AdminPage): string {
  const meta = ADMIN_PAGES[page];
  const nav = (Object.entries(ADMIN_PAGES) as Array<[AdminPage, (typeof ADMIN_PAGES)[AdminPage]]>)
    .map(([key, item]) =>
      '<a class="' + (key === page ? "active" : "") + '" href="' + item.path + '"><i></i>' + item.label + "</a>",
    )
    .join("");

  const themeBoot =
    '(function(){try{var m=localStorage.getItem("aylens.admin.theme")||"system";' +
    'var d=matchMedia("(prefers-color-scheme: dark)").matches;' +
    'document.documentElement.dataset.theme=m==="system"?(d?"dark":"light"):m;' +
    'document.documentElement.dataset.themeMode=m}catch(_){}})()';

  return [
    '<!doctype html><html lang="zh-CN" data-theme="dark"><head>',
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="dark light">',
    '<title>' + meta.label + ' · Aylens 控制台</title>',
    '<script>' + themeBoot + '</script><style>' + CSS + '</style></head>',
    '<body data-page="' + page + '"><div class="layout">',
    '<aside class="side"><div class="brand"><div class="logo">A</div><div><b>AYLENS</b>',
    '<small>Retrieval Control Plane</small></div></div><nav>' + nav + '</nav>',
    '<div class="key"><span id="keyDot" class="dot"></span><span id="keyState">尚未连接管理 API</span></div></aside>',
    '<main><header class="top"><span class="crumb">CONTROL PLANE / ' + meta.label.toUpperCase() + '</span>',
    '<div class="actions"><label><input id="autoRefresh" type="checkbox" checked>5 秒自动刷新</label>',
    '<select id="themeSelect" aria-label="主题"><option value="system">跟随系统</option>',
    '<option value="light">亮色</option><option value="dark">暗色</option></select>',
    '<button id="refreshButton">立即刷新</button><button id="keyButton">API Key</button></div></header>',
    '<section class="heading"><div><em>Aylens Gateway</em><h1>' + meta.title + '</h1><p>' + meta.description + '</p></div>',
    '<div class="live" id="liveText">等待连接</div></section>',
    pageBody(page),
    '</main></div>',
    '<div id="authModal" class="modalbg"><div class="modal"><h2>连接管理 API</h2>',
    '<p>API Key 仅保存在当前标签页的 sessionStorage；主题偏好保存在 localStorage。</p>',
    '<form id="authForm"><label>API Key<input id="apiKeyInput" type="password" required></label>',
    '<div class="buttons"><button class="primary">连接</button><button id="disconnectButton" type="button">清除 Key</button></div>',
    '</form></div></div><div id="toast" class="toast"></div>',
    '<script>' + CLIENT_SCRIPT + '</script></body></html>',
  ].join("");
}

export const ADMIN_HTML = renderAdminPage("overview");
