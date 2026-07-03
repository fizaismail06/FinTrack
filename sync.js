/* ============ CLOUD SYNC (Firebase Auth + Firestore) ============
   Auto-initialises from FIREBASE_CONFIG (firebase-config.js).
   No manual setup needed — just sign in and everything syncs.

   STORAGE SHAPE (year-sharded, future-proof):
     fintrack_users/{uid}                    — profile: accounts, categories, goal,
                                               transfers, net-worth snapshots
     fintrack_users/{uid}/income_years/{y}   — income records for calendar year y
     fintrack_users/{uid}/expense_years/{y}  — expense records for calendar year y
*/
const Sync = (function(){
  let auth = null, db = null;
  let profileUnsub = null, incomeUnsub = null, expenseUnsub = null;
  let applyingRemote = false;
  let pushTimer = null;
  let localEchoId = null;
  let hasPendingLocalPush = false;

  // in-memory mirror of the cloud, updated incrementally by listeners
  let cloudProfile = null;
  let cloudIncomeByYear = {};
  let cloudExpenseByYear = {};
  let combineTimer = null;

  const listeners = { authChange: ()=>{}, remoteUpdate: ()=>{}, statusChange: ()=>{} };
  const status = { ready: false, signedIn: false, email: null, uid: null, syncing: false, error: null };

  function emitStatus(){ listeners.statusChange(Object.assign({}, status)); }

  /* ---------- init (called once at app startup) ---------- */
  function init(){
    try{
      if(typeof firebase === 'undefined') throw new Error('Firebase SDK not loaded');
      if(!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      auth = firebase.auth();
      db   = firebase.firestore();
      status.ready = true;
      auth.onAuthStateChanged(user=>{
        status.signedIn = !!user;
        status.email    = user ? user.email : null;
        status.uid      = user ? user.uid   : null;
        status.error    = null;
        if(user) attachListeners(user.uid); else detachListeners();
        listeners.authChange(user);
        emitStatus();
      });
      emitStatus();
    }catch(e){
      status.error = e.message;
      emitStatus();
    }
  }

  /* ---------- auth ---------- */
  function signUp(email, pass){ return auth.createUserWithEmailAndPassword(email, pass); }
  function signIn(email, pass){ return auth.signInWithEmailAndPassword(email, pass); }
  function signOut(){ detachListeners(); return auth.signOut(); }
  function sendPasswordReset(email){ return auth.sendPasswordResetEmail(email); }

  /* ---------- Firestore paths ---------- */
  function userRef(uid){ return db.collection('fintrack_users').doc(uid); }
  function yearsCol(uid, kind){ return userRef(uid).collection(kind); }

  function groupByYear(records){
    const out = {};
    (records||[]).forEach(r=>{
      const y = (r.date||'').slice(0,4) || 'unknown';
      (out[y] = out[y]||[]).push(r);
    });
    return out;
  }

  /* ---------- realtime listeners ---------- */
  function scheduleCombinedEmit(){
    clearTimeout(combineTimer);
    combineTimer = setTimeout(emitIfReady, 400);
  }

  function emitIfReady(){
    if(hasPendingLocalPush){
      combineTimer = setTimeout(emitIfReady, 400);
      return;
    }
    if(!cloudProfile) return;
    let income = [];
    Object.values(cloudIncomeByYear).forEach(arr=>{ income = income.concat(arr); });
    let expenses = [];
    Object.values(cloudExpenseByYear).forEach(arr=>{ expenses = expenses.concat(arr); });
    const parsed = {
      income, expenses,
      transfers:          cloudProfile.transfers||[],
      networth:           cloudProfile.networth||[],
      accounts:           cloudProfile.accounts||[],
      manualAccounts:     cloudProfile.manualAccounts||[],
      incomeSources:      cloudProfile.incomeSources||[],
      expenseCategories:  cloudProfile.expenseCategories||[],
      goal:               cloudProfile.goal||{label:'Savings Goal', achieved:0, target:0},
      seq:                cloudProfile.seq||1,
      seeded:             true
    };
    applyingRemote = true;
    listeners.remoteUpdate(parsed, cloudProfile.updatedAtMs||null);
    applyingRemote = false;
  }

  function attachListeners(uid){
    detachListeners();
    profileUnsub = userRef(uid).onSnapshot(snap=>{
      if(!snap.exists) return;
      const data = snap.data();
      // Legacy single-doc format from before sharding — read it as-is;
      // first push will transparently migrate it to sharded format.
      if(data && typeof data.db === 'string') return;
      cloudProfile = data;
      scheduleCombinedEmit();
    }, err=>{ status.error = err.message; emitStatus(); });

    incomeUnsub = yearsCol(uid,'income_years').onSnapshot(qs=>{
      qs.docChanges().forEach(ch=>{
        if(ch.type==='removed'){ delete cloudIncomeByYear[ch.doc.id]; return; }
        cloudIncomeByYear[ch.doc.id] = ch.doc.data().records||[];
      });
      scheduleCombinedEmit();
    }, err=>{ status.error = err.message; emitStatus(); });

    expenseUnsub = yearsCol(uid,'expense_years').onSnapshot(qs=>{
      qs.docChanges().forEach(ch=>{
        if(ch.type==='removed'){ delete cloudExpenseByYear[ch.doc.id]; return; }
        cloudExpenseByYear[ch.doc.id] = ch.doc.data().records||[];
      });
      scheduleCombinedEmit();
    }, err=>{ status.error = err.message; emitStatus(); });
  }

  function detachListeners(){
    if(profileUnsub){ profileUnsub(); profileUnsub = null; }
    if(incomeUnsub){ incomeUnsub(); incomeUnsub = null; }
    if(expenseUnsub){ expenseUnsub(); expenseUnsub = null; }
    cloudProfile = null;
    cloudIncomeByYear = {};
    cloudExpenseByYear = {};
  }

  /* ---------- push ---------- */
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
    const incByYear  = groupByYear(dbObj.income);
    const expByYear  = groupByYear(dbObj.expenses);
    const allYears   = new Set([...Object.keys(incByYear), ...Object.keys(expByYear)]);
    allYears.forEach(y=>{
      batch.set(yearsCol(uid,'income_years').doc(y),  {records: incByYear[y]||[],  updatedAtMs: now, _localEcho: localEchoId});
      batch.set(yearsCol(uid,'expense_years').doc(y), {records: expByYear[y]||[], updatedAtMs: now, _localEcho: localEchoId});
    });

    return batch.commit().then(()=>{
      status.syncing = false; status.error = null; emitStatus();
      hasPendingLocalPush = false;
      scheduleCombinedEmit();
    }).catch(e=>{
      status.syncing = false; status.error = e.message; emitStatus();
      hasPendingLocalPush = false;
      scheduleCombinedEmit();
    });
  }

  /* ---------- one-off fetch (for new device first login) ---------- */
  function fetchCloudOnce(){
    if(!auth || !auth.currentUser) return Promise.resolve(null);
    const uid = auth.currentUser.uid;
    return userRef(uid).get().then(snap=>{
      if(!snap.exists) return null;
      const profile = snap.data();
      if(profile && typeof profile.db === 'string'){
        try{ return {parsed: JSON.parse(profile.db), updatedAtMs: profile.updatedAtMs||null}; }
        catch(e){ return null; }
      }
      return Promise.all([
        yearsCol(uid,'income_years').get(),
        yearsCol(uid,'expense_years').get()
      ]).then(([incSnaps, expSnaps])=>{
        let income = []; incSnaps.forEach(d=>{ income = income.concat(d.data().records||[]); });
        let expenses = []; expSnaps.forEach(d=>{ expenses = expenses.concat(d.data().records||[]); });
        return {
          parsed: {
            income, expenses,
            transfers:         profile.transfers||[],
            networth:          profile.networth||[],
            accounts:          profile.accounts||[],
            manualAccounts:    profile.manualAccounts||[],
            incomeSources:     profile.incomeSources||[],
            expenseCategories: profile.expenseCategories||[],
            goal:              profile.goal||{label:'Savings Goal', achieved:0, target:0},
            seq:               profile.seq||1,
            seeded:            true
          },
          updatedAtMs: profile.updatedAtMs||null
        };
      });
    });
  }

  return {
    init, signUp, signIn, signOut, sendPasswordReset,
    schedulePush, pushNow, fetchCloudOnce,
    getStatus: ()=>Object.assign({}, status),
    on: (event, fn)=>{ listeners[event] = fn; }
  };
})();
