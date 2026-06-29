/* ============ STATE & PERSISTENCE ============ */
const LS_KEY = 'fintrack_v1';
let DB = null;

function defaultDB(){
  return {
    seeded: true,
    income: SEED.income.map((r,i)=>({id:'si'+i, date:r[0], source:r[1], amount:r[2], account:r[3], desc:r[4]})),
    expenses: SEED.expenses.map((r,i)=>({id:'se'+i, date:r[0], item:r[1], amount:r[2], category:r[3], account:r[4]})),
    transfers: [],
    networth: SEED.networthSnapshots.map(([month, vals])=>({id:'sn'+month, month, values:vals})),
    accounts: JSON.parse(JSON.stringify(SEED.accounts)),
    manualAccounts: JSON.parse(JSON.stringify(SEED.manualAccounts)),
    incomeSources: SEED.incomeSources.slice(),
    expenseCategories: SEED.expenseCategories.slice(),
    goal: Object.assign({}, SEED.goal),
    seq: 1
  };
}

function loadDB(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){ console.warn('storage read failed', e); }
  const fresh = defaultDB();
  saveDB(fresh);
  return fresh;
}
function saveDB(db){
  try{ localStorage.setItem(LS_KEY, JSON.stringify(db)); }
  catch(e){ console.warn('storage write failed', e); toast('Could not save — storage full or blocked'); }
}
function persist(){ saveDB(DB); if(typeof Sync!=='undefined') Sync.schedulePush(DB); }
function nextId(){ DB.seq = (DB.seq||1)+1; return 'x'+Date.now()+'_'+DB.seq; }

/* ============ HELPERS ============ */
const fmt = n => 'RM ' + (Math.round((n||0)*100)/100).toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtShort = n => {
  const a = Math.abs(n||0);
  if(a>=1000000) return (n<0?'-':'')+'RM '+(a/1000000).toFixed(2)+'M';
  if(a>=1000) return (n<0?'-':'')+'RM '+(a/1000).toFixed(1)+'k';
  return fmt(n);
};
const todayStr = () => new Date().toISOString().slice(0,10);
const monthStr = () => new Date().toISOString().slice(0,7);
function monthLabel(m){ const [y,mo]=m.split('-'); return new Date(y,mo-1,1).toLocaleDateString('en-MY',{month:'short',year:'numeric'}); }
function dateLabel(d){ const dt=new Date(d+'T00:00:00'); return dt.toLocaleDateString('en-MY',{day:'numeric',month:'short',year:'numeric'}); }
function dayLabel(d){ const dt=new Date(d+'T00:00:00'); return dt.toLocaleDateString('en-MY',{weekday:'short',day:'numeric',month:'short'}); }
function shiftBalanceDate(delta){
  const d = new Date(CUR.balanceDate+'T00:00:00');
  d.setDate(d.getDate()+delta);
  const next = d.toISOString().slice(0,10);
  CUR.balanceDate = next > todayStr() ? todayStr() : next;
  render();
}
function timeAgo(date){
  const s = Math.floor((Date.now()-date.getTime())/1000);
  if(s<60) return 'just now';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}

const PALETTE = ['#34D8A8','#5B9CF2','#E8B860','#F2725C','#9D7FE8','#5FD0E0','#E08FC0','#C4D85A','#7FA8E8','#E8985F','#6FE0A8','#D88FE0'];
function colorFor(key, list){ const i = list.indexOf(key); return PALETTE[((i<0?0:i))%PALETTE.length]; }

function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window._toastT);
  window._toastT = setTimeout(()=>el.classList.remove('show'), 2200);
}

/* ============ DERIVED DATA ============ */
function allAccounts(){ return DB.accounts; }
function accountByName(name){ return DB.accounts.find(a=>a.name===name); }

function accountBalance(acc, asOf){
  let bal = acc.opening||0;
  for(const r of DB.income) if(r.account===acc.name && (!asOf || r.date<=asOf)) bal += r.amount;
  for(const r of DB.expenses) if(r.account===acc.name && (!asOf || r.date<=asOf)) bal -= r.amount;
  for(const t of DB.transfers){
    if(asOf && t.date>asOf) continue;
    if(t.from===acc.name) bal -= t.amount;
    if(t.to===acc.name) bal += t.amount;
  }
  return bal;
}

function latestManualSnapshot(){
  if(!DB.networth.length) return {};
  const sorted = DB.networth.slice().sort((a,b)=>a.month<b.month?-1:1);
  return sorted[sorted.length-1].values || {};
}

function netWorthBreakdown(){
  const accs = allAccounts();
  let cash=0, unitTrust=0;
  for(const a of accs){
    const bal = accountBalance(a);
    if(a.type==='cash') cash += bal;
    else if(a.type==='unittrust') unitTrust += bal;
  }
  const manual = latestManualSnapshot();
  let other=0, liability=0;
  for(const m of DB.manualAccounts){
    const v = manual[m.name]||0;
    if(m.type==='unittrust') unitTrust += v;
    else if(m.type==='other') other += v;
    else if(m.type==='liability') liability += v; // stored negative
  }
  const total = cash+unitTrust+other+liability;
  return {cash, unitTrust, other, liability, total};
}

function endOfMonth(m){
  const [y,mo] = m.split('-').map(Number);
  const days = [31,(y%4===0&&(y%100!==0||y%400===0))?29:28,31,30,31,30,31,31,30,31,30,31][mo-1];
  return `${y}-${String(mo).padStart(2,'0')}-${String(days).padStart(2,'0')}`;
}

function networthBreakdownForMonth(snap){
  const cutoff = endOfMonth(snap.month);
  const cashAccounts = DB.accounts.filter(a=>a.type==='cash');
  const utAccounts = DB.accounts.filter(a=>a.type==='unittrust');
  const cashDetail = cashAccounts.map(a=>({name:a.name, value:accountBalance(a,cutoff)}));
  const utDetail = utAccounts.map(a=>({name:a.name, value:accountBalance(a,cutoff)}));
  let cash = cashDetail.reduce((s,d)=>s+d.value,0);
  let unitTrust = utDetail.reduce((s,d)=>s+d.value,0);
  let other=0, liability=0;
  const otherDetail=[], liabDetail=[];
  for(const m of DB.manualAccounts){
    if(!(m.name in (snap.values||{}))) continue;
    const v = snap.values[m.name];
    if(m.type==='unittrust'){ unitTrust += v; utDetail.push({name:m.name, value:v}); }
    else if(m.type==='other'){ other += v; otherDetail.push({name:m.name, value:v}); }
    else if(m.type==='liability'){ liability += v; liabDetail.push({name:m.name, value:v}); }
  }
  const total = cash+unitTrust+other+liability;
  return {cash, unitTrust, other, liability, total, cashDetail, utDetail, otherDetail, liabDetail};
}

function periodFilter(rows, dateField, year, month){
  return rows.filter(r=>{
    const d = r[dateField];
    if(!d) return false;
    if(year && d.slice(0,4)!==String(year)) return false;
    if(month && d.slice(0,7)!==month) return false;
    return true;
  });
}

function incomeBySource(month){
  const rows = DB.income.filter(r=>r.date.slice(0,7)===month && r.source!=='Account Transfer');
  const map = {};
  let total = 0;
  for(const r of rows){ map[r.source]=(map[r.source]||0)+r.amount; total+=r.amount; }
  return {map, total};
}
function expenseByCategory(month){
  const rows = DB.expenses.filter(r=>r.date.slice(0,7)===month);
  const map = {};
  let total = 0;
  for(const r of rows){ map[r.category]=(map[r.category]||0)+r.amount; total+=r.amount; }
  return {map, total};
}

function lastNMonths(n){
  const out = [];
  const d = new Date();
  d.setDate(1);
  for(let i=0;i<n;i++){
    out.unshift(d.toISOString().slice(0,7));
    d.setMonth(d.getMonth()-1);
  }
  return out;
}
function monthTrend(n){
  return lastNMonths(n).map(m=>({
    month:m,
    income: incomeBySource(m).total,
    expense: expenseByCategory(m).total
  }));
}

/* ============ NAVIGATION ============ */
let CUR = {screen:'dashboard', month: new Date().toISOString().slice(0,7), histTab:'all', histSearch:'', histLimit:150, balanceDate: new Date().toISOString().slice(0,10), expandedNW:null, advancedOpen:false};
let restoreSearchFocus = false;

function switchScreen(name){
  CUR.screen = name;
  document.querySelectorAll('.navbtn').forEach(b=>b.classList.toggle('active', b.dataset.nav===name));
  render();
}

function render(){
  const root = document.getElementById('screen-root');
  if(CUR.screen==='dashboard') root.innerHTML = renderDashboard();
  else if(CUR.screen==='history') root.innerHTML = renderHistory();
  else if(CUR.screen==='settings') root.innerHTML = renderSettings();
  bindScreenEvents();
}

/* ============ DASHBOARD ============ */
function renderDashboard(){
  const nw = netWorthBreakdown();
  const accs = allAccounts();
  const {map: incMap, total: incTotal} = incomeBySource(CUR.month);
  const {map: expMap, total: expTotal} = expenseByCategory(CUR.month);
  const goal = DB.goal;
  const goalPct = goal.target ? Math.min(100, Math.round(goal.achieved/goal.target*100)) : 0;

  const incSorted = Object.entries(incMap).sort((a,b)=>b[1]-a[1]);
  const expSorted = Object.entries(expMap).sort((a,b)=>b[1]-a[1]);

  const recent = recentTransactions(8);
  const trend = monthTrend(6);
  const trendMax = Math.max(1, ...trend.map(t=>Math.max(t.income,t.expense)));
  const monthLbl = monthLabel(CUR.month);

  return `
  <div class="screen">
    <div class="hero">
      <div class="label">Total Net Worth</div>
      <div class="amount">${fmt(nw.total)}</div>
      <div class="hero-row">
        <div class="hero-chip"><div class="k"><span class="dot" style="background:#34D8A8"></span>Cash</div><div class="v">${fmtShort(nw.cash)}</div></div>
        <div class="hero-chip"><div class="k"><span class="dot" style="background:#5B9CF2"></span>Unit Trust</div><div class="v">${fmtShort(nw.unitTrust)}</div></div>
        <div class="hero-chip"><div class="k"><span class="dot" style="background:#E8B860"></span>Assets</div><div class="v">${fmtShort(nw.other)}</div></div>
        <div class="hero-chip"><div class="k"><span class="dot" style="background:#F2725C"></span>Loans</div><div class="v">${fmtShort(nw.liability)}</div></div>
      </div>
    </div>

    <div class="card tight">
      <div class="goal-head"><div class="name">🎯 ${esc(goal.label)}</div><div class="pct">${goalPct}%</div></div>
      <div class="progress-track"><div class="progress-fill" style="width:${goalPct}%"></div></div>
      <div class="goal-foot"><span>${fmt(goal.achieved)}</span><span>${fmt(goal.target)}</span></div>
    </div>

    <div class="section-label" style="display:flex; align-items:center; justify-content:space-between;">
      <span>Bank &amp; account balances</span>
      ${CUR.balanceDate!==todayStr() ? `<span style="color:var(--gold); font-weight:600; text-transform:none; letter-spacing:0;">as of ${dateLabel(CUR.balanceDate)}</span>` : ''}
    </div>
    <div class="card">
      <div class="bal-datenav">
        <button class="iconbtn" id="balPrev" aria-label="Previous day">‹</button>
        <input type="date" id="balDate" value="${CUR.balanceDate}" max="${todayStr()}">
        <button class="iconbtn" id="balNext" aria-label="Next day" ${CUR.balanceDate>=todayStr()?'disabled':''}>›</button>
        ${CUR.balanceDate!==todayStr() ? `<button class="chip sel" id="balToday">Today</button>` : ''}
      </div>
      <div class="row-list">
        ${accs.map(a=>{
          const bal = accountBalance(a, CUR.balanceDate);
          const init = a.name.slice(0,2).toUpperCase();
          const c = colorFor(a.name, accs.map(x=>x.name));
          return `<div class="acct-row">
            <div class="left">
              <div class="acct-badge" style="background:${c}22; color:${c}">${init}</div>
              <div><div class="acct-name">${esc(a.name)}</div><div class="acct-sub">${a.type==='unittrust'?'Unit trust · tracked':'Cash account'}</div></div>
            </div>
            <div class="acct-val ${bal<0?'neg':'pos'}">${fmt(bal)}</div>
          </div>`;
        }).join('')}
        <div class="acct-row" style="border-top:1px solid var(--border); margin-top:2px; padding-top:13px;">
          <div class="left"><div class="acct-name" style="font-weight:700;">Total</div></div>
          <div class="acct-val" style="font-weight:700;">${fmt(accs.reduce((s,a)=>s+accountBalance(a,CUR.balanceDate),0))}</div>
        </div>
      </div>
    </div>

    <div class="section-label">6-month trend</div>
    <div class="card">
      <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:6px; height:90px;">
        ${trend.map(t=>`
          <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:3px; height:100%; justify-content:flex-end;">
            <div style="display:flex; gap:2px; align-items:flex-end; height:72px;">
              <div style="width:7px; border-radius:3px 3px 0 0; background:var(--emerald); height:${Math.max(2,t.income/trendMax*72)}px;"></div>
              <div style="width:7px; border-radius:3px 3px 0 0; background:var(--coral); height:${Math.max(2,t.expense/trendMax*72)}px;"></div>
            </div>
            <div style="font-size:9.5px; color:var(--text-faint)">${t.month.slice(5,7)}/${t.month.slice(2,4)}</div>
          </div>`).join('')}
      </div>
      <div style="display:flex; gap:14px; margin-top:10px; font-size:11px; color:var(--text-dim)">
        <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--emerald);margin-right:5px;"></span>Income</span>
        <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--coral);margin-right:5px;"></span>Expenses</span>
      </div>
    </div>

    <div class="period-pill" style="margin:18px 2px 0;">
      <span>📅</span>
      <input type="month" id="monthSelect" value="${CUR.month}" style="background:none;border:none;color:var(--text);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:600;">
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="card-head"><div class="title">📈 Income — ${esc(monthLbl)}</div><div class="total" style="color:var(--emerald)">${fmt(incTotal)}</div></div>
      ${incSorted.length? incSorted.map(([k,v])=>{
        const pct = incTotal? Math.round(v/incTotal*100):0;
        const c = colorFor(k, DB.incomeSources);
        return `<div class="bar-item"><div class="bar-top"><span class="name">${esc(k)}</span><span class="val">${fmt(v)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%; background:${c}"></div></div></div>`;
      }).join('') : `<div class="empty">No income recorded for ${esc(monthLbl)}</div>`}
    </div>

    <div class="card">
      <div class="card-head"><div class="title">📉 Expenses — ${esc(monthLbl)}</div><div class="total" style="color:var(--coral)">${fmt(expTotal)}</div></div>
      ${expSorted.length? expSorted.map(([k,v])=>{
        const pct = expTotal? Math.round(v/expTotal*100):0;
        const c = colorFor(k, DB.expenseCategories);
        return `<div class="bar-item"><div class="bar-top"><span class="name">${esc(k)}</span><span class="val">${fmt(v)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%; background:${c}"></div></div></div>`;
      }).join('') : `<div class="empty">No expenses recorded for ${esc(monthLbl)}</div>`}
    </div>

    <div class="section-label">Recent activity</div>
    <div class="card">
      ${recent.length? recent.map(txRowHtml).join('') : `<div class="empty"><div class="big">🌱</div>Nothing recorded yet — tap + to add your first entry</div>`}
    </div>
  </div>`;
}

function recentTransactions(limit){
  const items = [];
  DB.income.forEach(r=>items.push({type:'income', date:r.date, title:r.source, sub:r.account+(r.desc?' · '+r.desc:''), amount:r.amount}));
  DB.expenses.forEach(r=>items.push({type:'expense', date:r.date, title:r.item||r.category, sub:r.account+' · '+r.category, amount:-r.amount}));
  DB.transfers.forEach(r=>items.push({type:'transfer', date:r.date, title:'Transfer', sub:r.from+' → '+r.to, amount:r.amount}));
  items.sort((a,b)=> b.date.localeCompare(a.date) || (b.id||0)-(a.id||0));
  return items.slice(0,limit);
}

function txRowHtml(t){
  const icon = t.type==='income'?'💰':t.type==='expense'?'🛒':'🔁';
  const bg = t.type==='income'?'#34D8A822':t.type==='expense'?'#F2725C22':'#5B9CF222';
  const amtColor = t.type==='income'?'var(--emerald)':t.type==='expense'?'var(--coral)':'var(--azure)';
  const sign = t.amount>0 && t.type!=='expense' ? '+' : (t.type==='expense'?'-':'');
  return `<div class="tx-row">
    <div class="tx-icon" style="background:${bg}">${icon}</div>
    <div class="tx-mid"><div class="tx-title">${esc(t.title||'—')}</div><div class="tx-sub">${esc(t.sub||'')} · ${dateLabel(t.date)}</div></div>
    <div class="tx-amt" style="color:${amtColor}">${sign}${fmt(Math.abs(t.amount))}</div>
  </div>`;
}

function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function nwCategoryBlock(label, color, total, detail){
  if(!detail.length) return '';
  return `<div class="nw-cat">
    <div class="nw-cat-head"><span class="dot" style="background:${color}"></span><span class="nw-cat-name">${esc(label)}</span><span class="nw-cat-total">${fmt(total)}</span></div>
    ${detail.map(d=>`<div class="nw-cat-item"><span>${esc(d.name)}</span><span class="mono ${d.value<0?'neg':''}">${fmt(d.value)}</span></div>`).join('')}
  </div>`;
}
function renderNetworthMonthDetail(bd){
  return `<div class="nw-detail">
    ${nwCategoryBlock('Cash', '#34D8A8', bd.cash, bd.cashDetail)}
    ${nwCategoryBlock('Unit Trust', '#5B9CF2', bd.unitTrust, bd.utDetail)}
    ${nwCategoryBlock('Other Assets', '#E8B860', bd.other, bd.otherDetail)}
    ${nwCategoryBlock('Loans', '#F2725C', bd.liability, bd.liabDetail)}
  </div>`;
}

/* ============ HISTORY ============ */
function renderHistory(){
  const tabs = [['all','All'],['income','Income'],['expense','Expenses'],['transfer','Transfers'],['networth','Net worth']];
  let rows = [];
  if(CUR.histTab==='all' || CUR.histTab==='income') DB.income.forEach(r=>rows.push({type:'income',id:r.id,date:r.date,title:r.source,sub:r.account+(r.desc?' · '+r.desc:''),amount:r.amount}));
  if(CUR.histTab==='all' || CUR.histTab==='expense') DB.expenses.forEach(r=>rows.push({type:'expense',id:r.id,date:r.date,title:r.item||r.category,sub:r.account+' · '+r.category,amount:-r.amount}));
  if(CUR.histTab==='all' || CUR.histTab==='transfer') DB.transfers.forEach(r=>rows.push({type:'transfer',id:r.id,date:r.date,title:'Transfer · '+(r.desc||''),sub:r.from+' → '+r.to,amount:r.amount}));

  if(CUR.histSearch){
    const q = CUR.histSearch.toLowerCase();
    rows = rows.filter(r=> (r.title||'').toLowerCase().includes(q) || (r.sub||'').toLowerCase().includes(q));
  }
  rows.sort((a,b)=>b.date.localeCompare(a.date));
  const totalRows = rows.length;
  const shown = rows.slice(0, CUR.histLimit);
  const hasMore = totalRows > shown.length;

  let networthHtml = '';
  if(CUR.histTab==='networth'){
    const snaps = DB.networth.slice().sort((a,b)=>b.month.localeCompare(a.month));
    networthHtml = snaps.length ? snaps.map(s=>{
      const bd = networthBreakdownForMonth(s);
      const expanded = CUR.expandedNW===s.month;
      return `<div class="card tight nw-month-card">
        <div class="tx-row nw-month-toggle" data-nwmonth="${s.month}">
          <div class="tx-icon" style="background:#9D7FE822">🗓️</div>
          <div class="tx-mid"><div class="tx-title">${monthLabel(s.month)}</div><div class="tx-sub">${expanded?'Tap to collapse':'Tap for cash · unit trust · assets · loans'}</div></div>
          <div class="tx-amt" style="color:var(--violet)">${fmt(bd.total)}</div>
          <span class="nw-chevron ${expanded?'open':''}">›</span>
        </div>
        ${expanded? renderNetworthMonthDetail(bd) : ''}
      </div>`;
    }).join('') : `<div class="empty">No net worth snapshots yet</div>`;
  }

  const grouped = {};
  shown.forEach(r=>{ (grouped[r.date]=grouped[r.date]||[]).push(r); });
  const dates = Object.keys(grouped).sort((a,b)=>b.localeCompare(a));

  return `<div class="screen">
    <div style="height:8px"></div>
    <div class="search-bar"><span>🔎</span><input id="histSearch" placeholder="Search transactions" value="${esc(CUR.histSearch)}"></div>
    <div class="tabs">${tabs.map(([k,l])=>`<div class="tab ${CUR.histTab===k?'active':''}" data-tab="${k}">${l}</div>`).join('')}</div>
    ${CUR.histTab==='networth' ? networthHtml : (dates.length? dates.map(d=>`
      <div class="day-group-label">${dayLabel(d)}</div>
      <div class="card">${grouped[d].map(r=>historyRowHtml(r)).join('')}</div>
    `).join('') + (hasMore? `<button class="btn-secondary" id="loadMoreHist">Load more (${totalRows-shown.length} remaining)</button>` : `<div class="empty" style="padding-top:6px">— end of records · ${totalRows} shown —</div>`)
      : `<div class="empty"><div class="big">📭</div>No transactions found</div>`)}
  </div>`;
}

function historyRowHtml(t){
  const icon = t.type==='income'?'💰':t.type==='expense'?'🛒':'🔁';
  const bg = t.type==='income'?'#34D8A822':t.type==='expense'?'#F2725C22':'#5B9CF222';
  const amtColor = t.type==='income'?'var(--emerald)':t.type==='expense'?'var(--coral)':'var(--azure)';
  const sign = t.type==='expense'?'-':'+';
  return `<div class="tx-row" data-del="${t.type}:${t.id}" style="cursor:pointer">
    <div class="tx-icon" style="background:${bg}">${icon}</div>
    <div class="tx-mid"><div class="tx-title">${esc(t.title||'—')}</div><div class="tx-sub">${esc(t.sub||'')}</div></div>
    <div class="tx-amt" style="color:${amtColor}">${sign}${fmt(Math.abs(t.amount))}</div>
  </div>`;
}

function renderCloudSyncCard(){
  if(typeof Sync === 'undefined'){
    return `<div class="section-label">Cloud sync (multi-device)</div>
    <div class="card tight"><div class="empty">Sync engine failed to load. Check that sync.js is present alongside index.html.</div></div>`;
  }
  const s = Sync.getStatus();
  if(!s.configured){
    return `<div class="section-label">Cloud sync (multi-device)</div>
    <div class="card tight">
      <div style="font-size:13px; color:var(--text-dim); margin-bottom:12px; line-height:1.5;">Sign in to keep this app in sync across your phone, tablet, or any other device. Requires a free Firebase project — see the README for a 5-minute one-time setup.</div>
      <button class="btn-secondary" id="setupSyncBtn">Set up cloud sync</button>
    </div>`;
  }
  if(!s.signedIn){
    return `<div class="section-label">Cloud sync (multi-device)</div>
    <div class="card tight">
      ${s.error?`<div style="color:var(--coral); font-size:12px; margin-bottom:10px;">${esc(s.error)}</div>`:''}
      <div class="field"><label>Email</label><input id="syncEmail" type="email" autocomplete="email" placeholder="you@email.com"></div>
      <div class="field"><label>Password</label><input id="syncPass" type="password" autocomplete="current-password" placeholder="At least 6 characters"></div>
      <div class="two-col">
        <button class="btn-primary" id="syncSignIn" style="margin-top:0">Log in</button>
        <button class="btn-secondary" id="syncSignUp" style="margin-top:0">Sign up</button>
      </div>
      <button class="btn-secondary" id="syncReconfigure">Change project config</button>
    </div>`;
  }
  return `<div class="section-label">Cloud sync (multi-device)</div>
  <div class="card tight">
    ${s.error?`<div style="color:var(--coral); font-size:12px; margin-bottom:10px;">${esc(s.error)}</div>`:''}
    <div class="settings-row"><div><div class="label">${esc(s.email)}</div><div class="hint">${s.syncing?'Syncing…':(s.lastSync? 'Last synced '+timeAgo(s.lastSync) : 'Not yet synced')}</div></div></div>
    <button class="btn-secondary" id="syncNow" style="margin-top:10px;">Sync now</button>
    <button class="btn-secondary" id="syncSignOut" style="color:var(--coral)">Sign out</button>
  </div>`;
}

/* ============ SETTINGS ============ */
function renderAppLockCard(){
  if(typeof Lock === 'undefined') return '';
  const has = Lock.hasPin();
  return `<div class="section-label">App lock</div>
  <div class="card tight">
    <div style="font-size:13px; color:var(--text-dim); margin-bottom:12px; line-height:1.5;">${has? 'A 4-digit PIN is required every time this app is opened.' : 'Require a 4-digit PIN every time this app is opened — useful if you ever share this device or link.'}</div>
    ${has
      ? `<button class="btn-secondary" id="changePinBtn">Change PIN</button><button class="btn-secondary" id="removePinBtn" style="color:var(--coral)">Remove PIN</button>`
      : `<button class="btn-primary" id="setPinBtn" style="margin-top:0">Set a PIN</button>`}
  </div>`;
}

function renderSettings(){
  return `<div class="screen">
    <div style="height:8px"></div>
    ${renderAppLockCard()}

    <div class="section-label">Savings goal</div>
    <div class="card">
      <div class="field"><label>Goal name</label><input id="goalLabel" value="${esc(DB.goal.label)}"></div>
      <div class="two-col">
        <div class="field"><label>Achieved (RM)</label><input id="goalAchieved" type="number" step="0.01" value="${DB.goal.achieved}"></div>
        <div class="field"><label>Target (RM)</label><input id="goalTarget" type="number" step="0.01" value="${DB.goal.target}"></div>
      </div>
      <button class="btn-primary" id="saveGoal">Save goal</button>
    </div>

    <div class="section-label">Accounts</div>
    <div class="card tight">
      <div class="row-list">
        ${DB.accounts.map(a=>`<div class="settings-row settings-row-tap" data-edit-acc="${esc(a.name)}"><div><div class="label">${esc(a.name)}</div><div class="hint">${a.type} · opening RM ${a.opening||0}</div></div><span class="nw-chevron">›</span></div>`).join('')}
      </div>
    </div>
    <button class="btn-secondary" id="addAccountBtn">+ Add cash / transactable account</button>

    <div class="section-label">Manual net-worth accounts</div>
    <div class="card tight">
      <div class="row-list">
        ${DB.manualAccounts.map(a=>`<div class="settings-row settings-row-tap" data-edit-manual="${esc(a.name)}"><div><div class="label">${esc(a.name)}</div><div class="hint">${a.type}</div></div><span class="nw-chevron">›</span></div>`).join('')}
      </div>
    </div>
    <button class="btn-secondary" id="addManualAccountBtn">+ Add unit trust / asset / loan</button>

    ${renderCloudSyncCard()}

    <div class="section-label">Data</div>
    <div class="card tight">
      <div class="settings-row"><div><div class="label">Income entries</div><div class="hint">${DB.income.length} records</div></div></div>
      <div class="settings-row"><div><div class="label">Expense entries</div><div class="hint">${DB.expenses.length} records</div></div></div>
      <div class="settings-row"><div><div class="label">Transfers</div><div class="hint">${DB.transfers.length} records</div></div></div>
      <div class="settings-row"><div><div class="label">Net worth snapshots</div><div class="hint">${DB.networth.length} months</div></div></div>
    </div>
    <button class="btn-secondary" id="exportBtn">⬇ Export data as JSON</button>
    <button class="btn-secondary" id="importBtn">⬆ Import data from JSON backup</button>
    <input type="file" id="importFile" accept="application/json" style="display:none">

    <button class="btn-secondary" id="advancedToggle" style="color:var(--text-faint); display:flex; align-items:center; justify-content:center; gap:6px;">
      Advanced <span class="nw-chevron ${CUR.advancedOpen?'open':''}" style="font-size:14px;">›</span>
    </button>
    ${CUR.advancedOpen? `<button class="btn-secondary" id="resetBtn" style="color:var(--coral)">⚠ Reset all data</button>` : ''}
    <div style="text-align:center; color:var(--text-faint); font-size:11.5px; margin-top:18px;">FinTrack · personal ledger · data stored only on this device</div>
  </div>`;
}

/* ============ EVENT BINDING ============ */
function bindScreenEvents(){
  if(CUR.screen==='dashboard'){
    const sel = document.getElementById('monthSelect');
    if(sel) sel.onchange = e=>{ CUR.month = e.target.value; render(); };
    const bd = document.getElementById('balDate');
    if(bd) bd.onchange = e=>{ CUR.balanceDate = e.target.value || todayStr(); render(); };
    const bp = document.getElementById('balPrev');
    if(bp) bp.onclick = ()=>{ shiftBalanceDate(-1); };
    const bn = document.getElementById('balNext');
    if(bn) bn.onclick = ()=>{ shiftBalanceDate(1); };
    const bt = document.getElementById('balToday');
    if(bt) bt.onclick = ()=>{ CUR.balanceDate = todayStr(); render(); };
  }
  if(CUR.screen==='history'){
    document.querySelectorAll('.tab').forEach(t=> t.onclick = ()=>{ CUR.histTab=t.dataset.tab; CUR.histLimit=150; render(); });
    const s = document.getElementById('histSearch');
    if(s){
      s.oninput = e=>{ CUR.histSearch = e.target.value; CUR.histLimit=150; restoreSearchFocus=true; render(); };
      if(restoreSearchFocus){ s.focus(); s.selectionStart = s.value.length; restoreSearchFocus = false; }
    }
    document.querySelectorAll('[data-del]').forEach(el=>{
      el.onclick = ()=>{
        const [type,id] = el.dataset.del.split(':');
        openDeleteConfirm(type,id);
      };
    });
    const lm = document.getElementById('loadMoreHist');
    if(lm) lm.onclick = ()=>{ CUR.histLimit += 200; render(); };
    document.querySelectorAll('[data-nwmonth]').forEach(el=>{
      el.onclick = ()=>{
        const m = el.dataset.nwmonth;
        CUR.expandedNW = (CUR.expandedNW===m) ? null : m;
        render();
      };
    });
  }
  if(CUR.screen==='settings'){
    document.getElementById('saveGoal').onclick = ()=>{
      DB.goal.label = document.getElementById('goalLabel').value || 'Savings Goal';
      DB.goal.achieved = parseFloat(document.getElementById('goalAchieved').value)||0;
      DB.goal.target = parseFloat(document.getElementById('goalTarget').value)||0;
      persist(); toast('Goal updated'); render();
    };
    document.getElementById('addAccountBtn').onclick = ()=>openAddAccountSheet('cash');
    document.getElementById('addManualAccountBtn').onclick = ()=>openAddAccountSheet('manual');
    document.querySelectorAll('[data-edit-acc]').forEach(el=> el.onclick = ()=>openEditAccountSheet(el.dataset.editAcc));
    document.querySelectorAll('[data-edit-manual]').forEach(el=> el.onclick = ()=>openEditManualAccountSheet(el.dataset.editManual));
    document.getElementById('exportBtn').onclick = exportData;
    document.getElementById('importBtn').onclick = ()=> document.getElementById('importFile').click();
    document.getElementById('importFile').onchange = (e)=>{
      const file = e.target.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = (ev)=>{
        let parsed;
        try{ parsed = JSON.parse(ev.target.result); }
        catch(err){ toast('Could not read that file'); return; }
        if(!parsed || !Array.isArray(parsed.income) || !Array.isArray(parsed.expenses)){
          toast("That file doesn't look like a FinTrack export"); return;
        }
        openConfirmSheet('Import this backup?','This replaces everything currently on this device with the contents of the file. This cannot be undone.','Import & replace', ()=>{
          DB = parsed; persist(); closeSheet(); render(); toast('Data imported');
        });
      };
      reader.readAsText(file);
      e.target.value = '';
    };
    document.getElementById('advancedToggle').onclick = ()=>{ CUR.advancedOpen = !CUR.advancedOpen; render(); };
    const resetBtn = document.getElementById('resetBtn');
    if(resetBtn) resetBtn.onclick = ()=>{
      openConfirmSheet('Reset all data?','This permanently deletes everything stored on this device, including your imported history. This cannot be undone.','Reset everything', ()=>{
        closeSheet();
        const doReset = ()=>{ localStorage.removeItem(LS_KEY); DB = defaultDB(); persist(); render(); toast('Data reset'); };
        if(typeof Lock !== 'undefined' && Lock.hasPin()){
          toast('Confirm with your PIN to continue');
          Lock.showLockScreen(doReset);
        } else {
          doReset();
        }
      });
    };
    if(typeof Lock !== 'undefined'){
      const setPinBtn = document.getElementById('setPinBtn');
      if(setPinBtn) setPinBtn.onclick = ()=>openSetPinSheet(false);
      const changePinBtn = document.getElementById('changePinBtn');
      if(changePinBtn) changePinBtn.onclick = ()=>openSetPinSheet(true);
      const removePinBtn = document.getElementById('removePinBtn');
      if(removePinBtn) removePinBtn.onclick = ()=>{
        openConfirmSheet('Remove PIN?','The app will open without requiring a PIN from now on.','Remove PIN', ()=>{
          Lock.removePin(); closeSheet(); render(); toast('PIN removed');
        });
      };
    }
    if(typeof Sync !== 'undefined'){
      const setupBtn = document.getElementById('setupSyncBtn');
      if(setupBtn) setupBtn.onclick = openSyncSetupSheet;
      const reconfig = document.getElementById('syncReconfigure');
      if(reconfig) reconfig.onclick = openSyncSetupSheet;
      const signInBtn = document.getElementById('syncSignIn');
      if(signInBtn) signInBtn.onclick = ()=>{
        const email = document.getElementById('syncEmail').value.trim();
        const pass = document.getElementById('syncPass').value;
        if(!email||!pass){ toast('Enter email and password'); return; }
        Sync.signIn(email,pass).catch(e=>{ toast(e.message); render(); });
      };
      const signUpBtn = document.getElementById('syncSignUp');
      if(signUpBtn) signUpBtn.onclick = ()=>{
        const email = document.getElementById('syncEmail').value.trim();
        const pass = document.getElementById('syncPass').value;
        if(!email||!pass){ toast('Enter email and password'); return; }
        if(pass.length<6){ toast('Password must be at least 6 characters'); return; }
        Sync.signUp(email,pass).catch(e=>{ toast(e.message); render(); });
      };
      const syncNowBtn = document.getElementById('syncNow');
      if(syncNowBtn) syncNowBtn.onclick = ()=>{ Sync.pushNow(DB); toast('Syncing…'); };
      const signOutBtn = document.getElementById('syncSignOut');
      if(signOutBtn) signOutBtn.onclick = ()=>{ Sync.signOut(); toast('Signed out'); };
    }
  }
}

function openDeleteConfirm(type,id){
  openConfirmSheet('Delete this entry?','This removes it from your records permanently.','Delete', ()=>{
    if(type==='income') DB.income = DB.income.filter(r=>r.id!==id);
    if(type==='expense') DB.expenses = DB.expenses.filter(r=>r.id!==id);
    if(type==='transfer') DB.transfers = DB.transfers.filter(r=>r.id!==id);
    persist(); closeSheet(); render(); toast('Deleted');
  });
}

/* ============ SHEETS / MODALS ============ */
const backdrop = ()=>document.getElementById('backdrop');
const sheetEl = ()=>document.getElementById('sheet');

function openSheet(html){
  sheetEl().innerHTML = html;
  backdrop().classList.add('show');
  sheetEl().classList.add('show');
}
function closeSheet(){
  backdrop().classList.remove('show');
  sheetEl().classList.remove('show');
}

function openConfirmSheet(title, body, actionLabel, onConfirm){
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>${esc(title)}</h2>
    <div class="sub">${esc(body)}</div>
    <button class="btn-primary" id="confirmYes" style="background:var(--coral)">${esc(actionLabel)}</button>
    <button class="btn-secondary" id="confirmNo">Cancel</button>
  `);
  document.getElementById('confirmYes').onclick = onConfirm;
  document.getElementById('confirmNo').onclick = closeSheet;
}

function openFabSheet(){
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Add a record</h2>
    <div class="sub">Choose what you'd like to log</div>
    <div class="actionsheet-item" id="actIncome"><div class="ic" style="background:#34D8A822">💰</div><div><div class="t">Income</div><div class="d">Salary, bonus, interest, reimbursement…</div></div></div>
    <div class="actionsheet-item" id="actExpense"><div class="ic" style="background:#F2725C22">🛒</div><div><div class="t">Expense</div><div class="d">Daily spending by category</div></div></div>
    <div class="actionsheet-item" id="actTransfer"><div class="ic" style="background:#5B9CF222">🔁</div><div><div class="t">Inter-account transfer</div><div class="d">Move money between your accounts</div></div></div>
    <div class="actionsheet-item" id="actNetworth"><div class="ic" style="background:#9D7FE822">🗓️</div><div><div class="t">Net worth snapshot</div><div class="d">Monthly update — investments &amp; assets</div></div></div>
  `);
  document.getElementById('actIncome').onclick = openIncomeForm;
  document.getElementById('actExpense').onclick = openExpenseForm;
  document.getElementById('actTransfer').onclick = openTransferForm;
  document.getElementById('actNetworth').onclick = openNetworthForm;
}

function chipRow(id, options, selected){
  return `<div class="chip-row" id="${id}">${options.map(o=>`<div class="chip ${o===selected?'sel':''}" data-val="${esc(o)}">${esc(o)}</div>`).join('')}</div>`;
}
function bindChips(id, onPick){
  document.querySelectorAll(`#${id} .chip`).forEach(c=>{
    c.onclick = ()=>{ document.querySelectorAll(`#${id} .chip`).forEach(x=>x.classList.remove('sel')); c.classList.add('sel'); onPick(c.dataset.val); };
  });
}

function openIncomeForm(){
  let source = DB.incomeSources[0];
  let account = DB.accounts[0].name;
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Add income</h2>
    <div class="sub">Record money coming in</div>
    <div class="field"><label>Date</label><input type="date" id="f_date" value="${todayStr()}"></div>
    <div class="field"><label>Amount (RM)</label><input type="number" inputmode="decimal" step="0.01" class="amt-input" id="f_amount" placeholder="0.00"></div>
    <div class="field"><label>Source</label>${chipRow('f_source', DB.incomeSources, source)}</div>
    <div class="field"><label>Into account</label>${chipRow('f_account', DB.accounts.map(a=>a.name), account)}</div>
    <div class="field"><label>Description (optional)</label><input id="f_desc" placeholder="e.g. June salary"></div>
    <button class="btn-primary" id="saveIncome">Save income</button>
  `);
  bindChips('f_source', v=>source=v);
  bindChips('f_account', v=>account=v);
  document.getElementById('saveIncome').onclick = ()=>{
    const amount = parseFloat(document.getElementById('f_amount').value);
    if(!amount || amount<=0){ toast('Enter a valid amount'); return; }
    DB.income.push({id:nextId(), date:document.getElementById('f_date').value||todayStr(), source, amount, account, desc:document.getElementById('f_desc').value.trim()});
    persist(); closeSheet(); render(); toast('Income added');
  };
}

function openExpenseForm(){
  let category = DB.expenseCategories[0];
  let account = DB.accounts[0].name;
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Add expense</h2>
    <div class="sub">Record daily spending</div>
    <div class="field"><label>Date</label><input type="date" id="f_date" value="${todayStr()}"></div>
    <div class="field"><label>Amount (RM)</label><input type="number" inputmode="decimal" step="0.01" class="amt-input" id="f_amount" placeholder="0.00"></div>
    <div class="field"><label>Item / merchant</label><input id="f_item" placeholder="e.g. Grab, groceries…"></div>
    <div class="field"><label>Category</label>${chipRow('f_cat', DB.expenseCategories, category)}</div>
    <div class="field"><label>Paid from</label>${chipRow('f_account', DB.accounts.map(a=>a.name), account)}</div>
    <button class="btn-primary" id="saveExpense">Save expense</button>
  `);
  bindChips('f_cat', v=>category=v);
  bindChips('f_account', v=>account=v);
  document.getElementById('saveExpense').onclick = ()=>{
    const amount = parseFloat(document.getElementById('f_amount').value);
    if(!amount || amount<=0){ toast('Enter a valid amount'); return; }
    DB.expenses.push({id:nextId(), date:document.getElementById('f_date').value||todayStr(), item:document.getElementById('f_item').value.trim(), amount, category, account});
    persist(); closeSheet(); render(); toast('Expense added');
  };
}

function openTransferForm(){
  let from = DB.accounts[0].name;
  let to = DB.accounts[1] ? DB.accounts[1].name : DB.accounts[0].name;
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Inter-account transfer</h2>
    <div class="sub">Move money between your own accounts — doesn't affect income or expense totals</div>
    <div class="field"><label>Date</label><input type="date" id="f_date" value="${todayStr()}"></div>
    <div class="field"><label>Amount (RM)</label><input type="number" inputmode="decimal" step="0.01" class="amt-input" id="f_amount" placeholder="0.00"></div>
    <div class="field"><label>From</label>${chipRow('f_from', DB.accounts.map(a=>a.name), from)}</div>
    <div class="field"><label>To</label>${chipRow('f_to', DB.accounts.map(a=>a.name), to)}</div>
    <div class="field"><label>Note (optional)</label><input id="f_desc" placeholder="e.g. ASB subscription"></div>
    <button class="btn-primary" id="saveTransfer">Save transfer</button>
  `);
  bindChips('f_from', v=>from=v);
  bindChips('f_to', v=>to=v);
  document.getElementById('saveTransfer').onclick = ()=>{
    const amount = parseFloat(document.getElementById('f_amount').value);
    if(!amount || amount<=0){ toast('Enter a valid amount'); return; }
    if(from===to){ toast('Pick two different accounts'); return; }
    DB.transfers.push({id:nextId(), date:document.getElementById('f_date').value||todayStr(), from, to, amount, desc:document.getElementById('f_desc').value.trim()});
    persist(); closeSheet(); render(); toast('Transfer recorded');
  };
}

function openNetworthForm(){
  const month = monthStr();
  const existing = DB.networth.find(s=>s.month===month);
  const vals = existing ? existing.values : (latestManualSnapshot()||{});
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Net worth snapshot</h2>
    <div class="sub">Manually update investments, assets &amp; loans for ${monthLabel(month)}. Bank balances are tracked automatically.</div>
    <div class="field"><label>Month</label><input type="month" id="f_month" value="${month}"></div>
    ${['unittrust','other','liability'].map(type=>{
      const items = DB.manualAccounts.filter(m=>m.type===type);
      if(!items.length) return '';
      const heading = type==='unittrust'?'Unit trust & investments':type==='other'?'Other assets':'Loans & liabilities (negative)';
      return `<div class="section-label" style="margin-top:16px">${heading}</div>` + items.map(m=>
        `<div class="field"><label>${esc(m.name)}</label><input type="number" step="0.01" class="amt-input" data-acc="${esc(m.name)}" value="${vals[m.name]!=null?vals[m.name]:''}" placeholder="0.00"></div>`
      ).join('');
    }).join('')}
    <button class="btn-primary" id="saveNetworth">Save snapshot</button>
  `);
  document.getElementById('saveNetworth').onclick = ()=>{
    const m = document.getElementById('f_month').value || month;
    const newVals = {};
    document.querySelectorAll('[data-acc]').forEach(inp=>{
      const v = parseFloat(inp.value);
      if(!isNaN(v)) newVals[inp.dataset.acc] = v;
    });
    const i = DB.networth.findIndex(s=>s.month===m);
    if(i>=0) DB.networth[i] = {id:DB.networth[i].id, month:m, values:newVals};
    else DB.networth.push({id:nextId(), month:m, values:newVals});
    persist(); closeSheet(); render(); toast('Net worth snapshot saved');
  };
}

function openAddAccountSheet(kind){
  const isCash = kind==='cash';
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>${isCash?'Add account':'Add asset / loan'}</h2>
    <div class="sub">${isCash?'A transactable account you can pay from or into':'Tracked manually each month in net worth snapshots'}</div>
    <div class="field"><label>Name</label><input id="f_name" placeholder="e.g. ${isCash?'Touch n Go eWallet':'Fixed Deposit'}"></div>
    ${isCash?`<div class="field"><label>Opening balance (RM)</label><input type="number" step="0.01" class="amt-input" id="f_opening" value="0"></div>`
      : `<div class="field"><label>Type</label>${chipRow('f_type', ['unittrust','other','liability'], 'unittrust')}</div>`}
    <button class="btn-primary" id="saveAcc">Save</button>
  `);
  let mtype = 'unittrust';
  if(!isCash) bindChips('f_type', v=>mtype=v);
  document.getElementById('saveAcc').onclick = ()=>{
    const name = document.getElementById('f_name').value.trim();
    if(!name){ toast('Enter a name'); return; }
    if(isCash){
      if(DB.accounts.some(a=>a.name===name)){ toast('Account already exists'); return; }
      DB.accounts.push({name, type:'cash', opening: parseFloat(document.getElementById('f_opening').value)||0});
    } else {
      if(DB.manualAccounts.some(a=>a.name===name)){ toast('Already exists'); return; }
      DB.manualAccounts.push({name, type:mtype});
    }
    persist(); closeSheet(); render(); toast('Account added');
  };
}

function openEditAccountSheet(name){
  const acc = DB.accounts.find(a=>a.name===name);
  if(!acc) return;
  const usageCount = DB.income.filter(r=>r.account===name).length + DB.expenses.filter(r=>r.account===name).length
    + DB.transfers.filter(t=>t.from===name||t.to===name).length;
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Edit account</h2>
    <div class="sub">${usageCount? usageCount+' existing record(s) reference this account.' : 'A transactable account you can pay from or into'}</div>
    <div class="field"><label>Name</label><input id="f_name" value="${esc(acc.name)}"></div>
    <div class="field"><label>Opening balance (RM)</label><input type="number" step="0.01" class="amt-input" id="f_opening" value="${acc.opening||0}"></div>
    <button class="btn-primary" id="saveAccEdit">Save changes</button>
    <button class="btn-secondary" id="delAcc" style="color:var(--coral)">Delete account</button>
  `);
  document.getElementById('saveAccEdit').onclick = ()=>{
    const newName = document.getElementById('f_name').value.trim();
    if(!newName){ toast('Enter a name'); return; }
    if(newName!==acc.name && DB.accounts.some(a=>a.name===newName)){ toast('Another account already has that name'); return; }
    if(newName!==acc.name){
      DB.income.forEach(r=>{ if(r.account===acc.name) r.account=newName; });
      DB.expenses.forEach(r=>{ if(r.account===acc.name) r.account=newName; });
      DB.transfers.forEach(t=>{ if(t.from===acc.name) t.from=newName; if(t.to===acc.name) t.to=newName; });
    }
    acc.name = newName;
    acc.opening = parseFloat(document.getElementById('f_opening').value)||0;
    persist(); closeSheet(); render(); toast('Account updated');
  };
  document.getElementById('delAcc').onclick = ()=>{
    openConfirmSheet('Delete '+acc.name+'?',
      usageCount? `This account has ${usageCount} existing record(s). They will stay in your history showing "${acc.name}", but the account will no longer appear in balances or be selectable for new entries.` : 'This removes the account. It can be re-added at any time.',
      'Delete account', ()=>{
        DB.accounts = DB.accounts.filter(a=>a.name!==acc.name);
        persist(); closeSheet(); render(); toast('Account deleted');
      });
  };
}

function openEditManualAccountSheet(name){
  const acc = DB.manualAccounts.find(a=>a.name===name);
  if(!acc) return;
  const monthsUsed = DB.networth.filter(s=>name in (s.values||{})).length;
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Edit net-worth category</h2>
    <div class="sub">${monthsUsed? 'Logged in '+monthsUsed+' monthly snapshot(s).' : 'Tracked manually each month in net worth snapshots'}</div>
    <div class="field"><label>Name</label><input id="f_name" value="${esc(acc.name)}"></div>
    <div class="field"><label>Type</label>${chipRow('f_type', ['unittrust','other','liability'], acc.type)}</div>
    <button class="btn-primary" id="saveManualEdit">Save changes</button>
    <button class="btn-secondary" id="delManual" style="color:var(--coral)">Delete category</button>
  `);
  let mtype = acc.type;
  bindChips('f_type', v=>mtype=v);
  document.getElementById('saveManualEdit').onclick = ()=>{
    const newName = document.getElementById('f_name').value.trim();
    if(!newName){ toast('Enter a name'); return; }
    if(newName!==acc.name && DB.manualAccounts.some(a=>a.name===newName)){ toast('Another category already has that name'); return; }
    if(newName!==acc.name){
      DB.networth.forEach(s=>{
        if(s.values && (acc.name in s.values)){ s.values[newName] = s.values[acc.name]; delete s.values[acc.name]; }
      });
    }
    acc.name = newName;
    acc.type = mtype;
    persist(); closeSheet(); render(); toast('Category updated');
  };
  document.getElementById('delManual').onclick = ()=>{
    openConfirmSheet('Delete '+acc.name+'?',
      monthsUsed? `This will also remove "${acc.name}" from all ${monthsUsed} monthly snapshot(s) where it was logged. This can't be undone.` : `This removes the category. It can be re-added at any time.`,
      'Delete category', ()=>{
        DB.manualAccounts = DB.manualAccounts.filter(a=>a.name!==acc.name);
        DB.networth.forEach(s=>{ if(s.values) delete s.values[acc.name]; });
        persist(); closeSheet(); render(); toast('Category deleted');
      });
  };
}

function exportData(){
  const blob = new Blob([JSON.stringify(DB,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'fintrack-export-'+todayStr()+'.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Export downloaded');
}

function openSetPinSheet(changing){
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>${changing?'Change PIN':'Set a PIN'}</h2>
    <div class="sub">Choose a 4-digit PIN. There's no recovery if you forget it — you'd need to clear this device's browser data to reset, which also clears your local copy of your data (your cloud copy, if synced, is unaffected).</div>
    <div class="field"><label>New PIN</label><input id="pinNew" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]*" placeholder="••••"></div>
    <div class="field"><label>Confirm PIN</label><input id="pinConfirm" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]*" placeholder="••••"></div>
    <button class="btn-primary" id="savePinBtn">Save PIN</button>
  `);
  document.getElementById('savePinBtn').onclick = async ()=>{
    const a = document.getElementById('pinNew').value.trim();
    const b = document.getElementById('pinConfirm').value.trim();
    if(!/^\d{4}$/.test(a)){ toast('Enter a 4-digit PIN'); return; }
    if(a!==b){ toast("PINs don't match"); return; }
    await Lock.setPin(a);
    closeSheet(); render(); toast('PIN set');
  };
}

function openSyncSetupSheet(){
  const existing = Sync.loadConfig();
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Cloud sync setup</h2>
    <div class="sub">Paste the Firebase config from your free Firebase project (see README for the 5-minute setup). This connects this device to your project — you'll sign up / log in next.</div>
    <div class="field"><label>Firebase config (JSON)</label><textarea id="fbConfigInput" rows="7" placeholder='{"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}'>${existing?esc(JSON.stringify(existing)):''}</textarea></div>
    <button class="btn-primary" id="saveFbConfig">Save &amp; connect</button>
  `);
  document.getElementById('saveFbConfig').onclick = ()=>{
    const raw = document.getElementById('fbConfigInput').value.trim();
    let cfg;
    try{ cfg = JSON.parse(raw); }catch(e){ toast("That doesn't look like valid JSON"); return; }
    if(!cfg.apiKey || !cfg.projectId){ toast('Missing apiKey or projectId'); return; }
    const ok = Sync.configure(cfg);
    if(ok){ closeSheet(); render(); toast('Connected — now sign up or log in'); }
  };
}

function openSyncConflictSheet(result){
  const when = result.updatedAtMs ? new Date(result.updatedAtMs).toLocaleString() : 'previously';
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Cloud backup found</h2>
    <div class="sub">This account already has data saved, last updated ${esc(when)}. Choose which version to keep on this device — this choice only matters once, right after signing in on a new device. After this, changes sync both ways automatically.</div>
    <button class="btn-primary" id="useCloud">Use cloud data (replace this device)</button>
    <button class="btn-secondary" id="useLocal">Keep this device's data (replace cloud)</button>
  `);
  document.getElementById('useCloud').onclick = ()=>{
    DB = result.parsed; saveDB(DB); closeSheet(); render(); toast('Loaded from cloud');
  };
  document.getElementById('useLocal').onclick = ()=>{
    Sync.pushNow(DB); closeSheet(); toast("Uploaded this device's data");
  };
}

/* ============ INIT ============ */
function init(){
  DB = loadDB();
  document.getElementById('backdrop').onclick = closeSheet;
  document.querySelectorAll('.navbtn[data-nav]').forEach(b=> b.onclick = ()=>switchScreen(b.dataset.nav));
  document.getElementById('fab').onclick = openFabSheet;
  document.getElementById('settingsShortcut').onclick = ()=>switchScreen('settings');

  function proceedInit(){
    render();
    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
    }
    if(typeof Sync !== 'undefined'){
      Sync.on('statusChange', ()=>{ if(CUR.screen==='settings') render(); });
      Sync.on('authChange', user=>{
        if(CUR.screen==='settings') render();
        if(user && !Sync.hasSyncedBefore()){
          Sync.fetchCloudOnce().then(result=>{
            Sync.markSyncedOnce();
            if(result && result.parsed) openSyncConflictSheet(result);
            else Sync.pushNow(DB);
          });
        }
        if(!user){ Sync.clearSyncedOnceFlag(); }
      });
      Sync.on('remoteUpdate', (parsed)=>{
        DB = parsed;
        saveDB(DB);
        render();
        toast('Synced from another device');
      });
      Sync.initFromStorage();
    }
  }

  if(typeof Lock !== 'undefined'){
    Lock.initKeypad();
    if(Lock.hasPin()){
      Lock.showLockScreen(proceedInit);
    } else {
      proceedInit();
    }
  } else {
    proceedInit();
  }
}
document.addEventListener('DOMContentLoaded', init);
