/* ============ CLOUD SYNC (Firebase Auth + Firestore) ============
   This file is self-contained and optional: if Firebase's CDN scripts fail to
   load (e.g. no internet on first load), every method here fails safe and the
   app continues to work as a local-only ledger. Nothing here runs unless the
   person explicitly sets up a Firebase project in Settings → Cloud sync.

   STORAGE SHAPE (future-proofed against Firestore's 1MB-per-document limit):
     fintrack_users/{uid}                       — "profile" doc: accounts,
       categories, goal, transfers, net-worth snapshots (all small & slow-growing)
     fintrack_users/{uid}/income_years/{year}    — one doc per calendar year
     fintrack_users/{uid}/expense_years/{year}   — one doc per calendar year
   Income and expenses are the only fields that grow without bound, so they're
   sharded by year — each yearly document stays small forever, however many
   decades of history accumulate. Pulling "all history since inception" just
   means reading every document in income_years / expense_years, which Firestore
   does in one query each, no matter how many years exist.
*/
const Sync = (function(){
  const FB_CONFIG_KEY = 'fintrack_fbconfig';
  const SYNCED_ONCE_KEY = 'fintrack_synced_once';

  let auth=null, db=null;
  let profileUnsub=null, incomeUnsub=null, expenseUnsub=null;
  let applyingRemote = false;
  let pushTimer = null;
  let localEchoId = null;
  let hasPendingLocalPush = false; // true from the moment a local edit is made until it's safely written to the cloud

  // local mirror of the cloud, rebuilt incrementally by the realtime listeners
  let cloudProfile = null;
  let cloudIncomeByYear = {};
  let cloudExpenseByYear = {};
  let combineTimer = null;

  const listeners = { authChange: ()=>{}, remoteUpdate: ()=>{}, statusChange: ()=>{} };
  const status = { configured:false, signedIn:false, email:null, lastSync:null, syncing:false, error:null };

  function emitStatus(){ listeners.statusChange(Object.assign({},status)); }

  function loadConfig(){
    try{ const raw = localStorage.getItem(FB_CONFIG_KEY); return raw? JSON.parse(raw): null; }catch(e){ return null; }
  }
  function saveConfig(cfg){ try{ localStorage.setItem(FB_CONFIG_KEY, JSON.stringify(cfg)); }catch(e){} }
  function clearConfig(){ localStorage.removeItem(FB_CONFIG_KEY); }

  function initFromStorage(){
    const cfg = loadConfig();
    if(cfg) configure(cfg);
  }

  function configure(cfg){
    try{
      if(typeof firebase === 'undefined') throw new Error('Could not reach Firebase — check your internet connection and try again.');
      if(!firebase.apps.length) firebase.initializeApp(cfg);
      auth = firebase.auth();
      db = firebase.firestore();
      saveConfig(cfg);
      status.configured = true; status.error = null;
      auth.onAuthStateChanged(user=>{
        status.signedIn = !!user;
        status.email = user ? user.email : null;
        if(user) attachListeners(user.uid); else detachListeners();
        listeners.authChange(user);
        emitStatus();
      });
      emitStatus();
      return true;
    }catch(e){
      status.error = e.message || String(e);
      emitStatus();
      return false;
    }
  }

  function signUp(email, pass){ return auth.createUserWithEmailAndPassword(email, pass); }
  function signIn(email, pass){ return auth.signInWithEmailAndPassword(email, pass); }
  function signOut(){ detachListeners(); return auth.signOut(); }

  function userRef(uid){ return db.collection('fintrack_users').doc(uid); }
  function yearsCol(uid, kind){ return userRef(uid).collection(kind); } // kind: 'income_years' | 'expense_years'

  function groupByYear(records){
    const out = {};
    (records||[]).forEach(r=>{
      const y = (r.date||'').slice(0,4) || 'unknown';
      (out[y] = out[y] || []).push(r);
    });
    return out;
  }

  /* ---------- realtime listeners (combine into one remoteUpdate event) ---------- */
  function scheduleCombinedEmit(){
    clearTimeout(combineTimer);
    combineTimer = setTimeout(emitIfReady, 400);
  }
  function emitIfReady(){
    if(hasPendingLocalPush){
      // a local edit hasn't finished writing to the cloud yet — applying a remote
      // snapshot now could overwrite it on screen. Just check back shortly instead;
      // pushNow() also forces a fresh emit the moment the local write lands.
      combineTimer = setTimeout(emitIfReady, 400);
      return;
    }
    if(!cloudProfile) return; // not loaded yet, or still legacy-format (held back below)
    let income = [];
    Object.values(cloudIncomeByYear).forEach(arr=>{ income = income.concat(arr); });
    let expenses = [];
    Object.values(cloudExpenseByYear).forEach(arr=>{ expenses = expenses.concat(arr); });
    const parsed = {
      income, expenses,
      transfers: cloudProfile.transfers||[],
      networth: cloudProfile.networth||[],
      accounts: cloudProfile.accounts||[],
      manualAccounts: cloudProfile.manualAccounts||[],
      incomeSources: cloudProfile.incomeSources||[],
      expenseCategories: cloudProfile.expenseCategories||[],
      goal: cloudProfile.goal||{label:'Savings Goal', achieved:0, target:0},
      seq: cloudProfile.seq||1,
      seeded: true
    };
    applyingRemote = true;
    listeners.remoteUpdate(parsed, cloudProfile.updatedAtMs || null);
    applyingRemote = false;
    status.lastSync = new Date();
    emitStatus();
  }

  function attachListeners(uid){
    detachListeners();
    profileUnsub = userRef(uid).onSnapshot(snap=>{
      if(!snap.exists) return;
      const data = snap.data();
      if(data._localEcho === localEchoId) return; // ignore echo of our own write
      if(data && typeof data.db === 'string') return; // legacy single-doc format — wait for auto-migration on next push
      cloudProfile = data;
      scheduleCombinedEmit();
    }, err=>{ status.error = err.message; emitStatus(); });

    incomeUnsub = yearsCol(uid,'income_years').onSnapshot(qs=>{
      qs.docChanges().forEach(ch=>{
        if(ch.type==='removed'){ delete cloudIncomeByYear[ch.doc.id]; return; }
        const data = ch.doc.data();
        if(data._localEcho === localEchoId) return;
        cloudIncomeByYear[ch.doc.id] = data.records || [];
      });
      scheduleCombinedEmit();
    }, err=>{ status.error = err.message; emitStatus(); });

    expenseUnsub = yearsCol(uid,'expense_years').onSnapshot(qs=>{
      qs.docChanges().forEach(ch=>{
        if(ch.type==='removed'){ delete cloudExpenseByYear[ch.doc.id]; return; }
        const data = ch.doc.data();
        if(data._localEcho === localEchoId) return;
        cloudExpenseByYear[ch.doc.id] = data.records || [];
      });
      scheduleCombinedEmit();
    }, err=>{ status.error = err.message; emitStatus(); });
  }
  function detachListeners(){
    if(profileUnsub){ profileUnsub(); profileUnsub=null; }
    if(incomeUnsub){ incomeUnsub(); incomeUnsub=null; }
    if(expenseUnsub){ expenseUnsub(); expenseUnsub=null; }
    cloudProfile=null; cloudIncomeByYear={}; cloudExpenseByYear={};
  }

  /* ---------- push (batched: profile + one doc per year that has data) ---------- */
  function schedulePush(dbObj){
    if(!status.signedIn || applyingRemote) return;
    hasPendingLocalPush = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(()=>pushNow(dbObj), 2000);
  }

  function pushNow(dbObj){
    if(!auth || !auth.currentUser) return Promise.resolve();
    hasPendingLocalPush = true;
    status.syncing = true; emitStatus();
    const uid = auth.currentUser.uid;
    localEchoId = Date.now()+'_'+Math.random().toString(36).slice(2);
    const now = Date.now();

    const batch = db.batch();
    batch.set(userRef(uid), {
      accounts: dbObj.accounts, manualAccounts: dbObj.manualAccounts,
      incomeSources: dbObj.incomeSources, expenseCategories: dbObj.expenseCategories,
      goal: dbObj.goal, seq: dbObj.seq, transfers: dbObj.transfers, networth: dbObj.networth,
      updatedAtMs: now, _localEcho: localEchoId
    });
    const incomeByYear = groupByYear(dbObj.income);
    const expenseByYear = groupByYear(dbObj.expenses);
    const allYears = new Set([...Object.keys(incomeByYear), ...Object.keys(expenseByYear)]);
    allYears.forEach(y=>{
      batch.set(yearsCol(uid,'income_years').doc(y), {records: incomeByYear[y]||[], updatedAtMs: now, _localEcho: localEchoId});
      batch.set(yearsCol(uid,'expense_years').doc(y), {records: expenseByYear[y]||[], updatedAtMs: now, _localEcho: localEchoId});
    });

    return batch.commit().then(()=>{
      status.syncing = false; status.lastSync = new Date(); status.error = null; emitStatus();
      hasPendingLocalPush = false;
      scheduleCombinedEmit(); // flush anything that arrived from elsewhere while this push was pending
    }).catch(e=>{
      status.syncing = false; status.error = e.message; emitStatus();
      hasPendingLocalPush = false; // don't get stuck ignoring remote updates if a push fails
      scheduleCombinedEmit();
    });
  }

  /* ---------- one-off fetch (used for the post-login conflict check) ---------- */
  function fetchCloudOnce(){
    if(!auth || !auth.currentUser) return Promise.resolve(null);
    const uid = auth.currentUser.uid;
    return userRef(uid).get().then(profileSnap=>{
      if(!profileSnap.exists) return null;
      const profile = profileSnap.data();
      // Legacy single-document format from before sharding existed — read it as-is.
      // The very next push will transparently migrate it to the sharded format.
      if(profile && typeof profile.db === 'string'){
        try{ return {parsed: JSON.parse(profile.db), updatedAtMs: profile.updatedAtMs||null}; }
        catch(e){ return null; }
      }
      return Promise.all([
        yearsCol(uid,'income_years').get(),
        yearsCol(uid,'expense_years').get()
      ]).then(([incomeSnaps, expenseSnaps])=>{
        let income = [];
        incomeSnaps.forEach(d=>{ income = income.concat(d.data().records || []); });
        let expenses = [];
        expenseSnaps.forEach(d=>{ expenses = expenses.concat(d.data().records || []); });
        const parsed = {
          income, expenses,
          transfers: profile.transfers||[],
          networth: profile.networth||[],
          accounts: profile.accounts||[],
          manualAccounts: profile.manualAccounts||[],
          incomeSources: profile.incomeSources||[],
          expenseCategories: profile.expenseCategories||[],
          goal: profile.goal||{label:'Savings Goal', achieved:0, target:0},
          seq: profile.seq||1,
          seeded: true
        };
        return {parsed, updatedAtMs: profile.updatedAtMs||null};
      });
    });
  }

  function hasSyncedBefore(){ return localStorage.getItem(SYNCED_ONCE_KEY)==='1'; }
  function markSyncedOnce(){ localStorage.setItem(SYNCED_ONCE_KEY,'1'); }
  function clearSyncedOnceFlag(){ localStorage.removeItem(SYNCED_ONCE_KEY); }

  return {
    initFromStorage, configure, signUp, signIn, signOut,
    schedulePush, pushNow, fetchCloudOnce,
    hasSyncedBefore, markSyncedOnce, clearSyncedOnceFlag,
    clearConfig, loadConfig,
    getStatus: ()=>Object.assign({}, status),
    on: (event, fn)=>{ listeners[event]=fn; }
  };
})();
