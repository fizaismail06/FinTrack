/* ============ APP LOCK (local PIN) ============
   A lightweight deterrent against someone casually opening this app's link —
   not bank-grade security (it's all client-side), but enough to stop a
   passerby from seeing your data just by tapping a shared link. The PIN
   itself is never stored — only its SHA-256 hash.
*/
const Lock = (function(){
  const PIN_KEY = 'fintrack_pin_hash';
  let entered = '';
  let onUnlock = null;

  async function sha256(text){
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  function hasPin(){ return !!localStorage.getItem(PIN_KEY); }
  async function setPin(pin){ localStorage.setItem(PIN_KEY, await sha256(pin)); }
  function removePin(){ localStorage.removeItem(PIN_KEY); }
  async function verify(pin){ return (await sha256(pin)) === localStorage.getItem(PIN_KEY); }

  function updateDots(){
    document.querySelectorAll('#lockDots .lock-dot').forEach((d,i)=> d.classList.toggle('filled', i<entered.length));
  }

  function showLockScreen(cb){
    onUnlock = cb;
    entered = '';
    const el = document.getElementById('lockScreen');
    el.style.display = 'flex';
    document.getElementById('lockError').style.display = 'none';
    updateDots();
  }
  function hideLockScreen(){ document.getElementById('lockScreen').style.display = 'none'; }

  async function trySubmit(){
    const ok = await verify(entered);
    if(ok){
      hideLockScreen();
      if(onUnlock) onUnlock();
    } else {
      document.getElementById('lockError').style.display = 'block';
      entered = '';
      updateDots();
      const dots = document.getElementById('lockDots');
      dots.classList.add('shake');
      setTimeout(()=>dots.classList.remove('shake'), 400);
    }
  }

  function pressDigit(d){
    if(entered.length>=4) return;
    entered += d;
    updateDots();
    if(entered.length===4) trySubmit();
  }
  function pressBackspace(){ entered = entered.slice(0,-1); updateDots(); }

  function initKeypad(){
    document.querySelectorAll('#lockKeypad [data-digit]').forEach(btn=>{
      btn.onclick = ()=>pressDigit(btn.dataset.digit);
    });
    const back = document.getElementById('lockBackspace');
    if(back) back.onclick = pressBackspace;
  }

  return { hasPin, setPin, removePin, verify, showLockScreen, hideLockScreen, initKeypad };
})();
