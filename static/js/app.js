// ═══════════════════════════════════════════════
// GLOBALS & API
// ═══════════════════════════════════════════════
const API = '/api';

let token = localStorage.getItem('shiloh_token');
let currentUser = null;
try { currentUser = JSON.parse(localStorage.getItem('shiloh_user') || 'null'); } catch (_) { }

// Everything people typed (names, messages, addresses...) goes through esc() before it is put
// into HTML, and through jsArg() before it is put inside an onclick="..." call.
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
}
function jsArg(v) { return esc(JSON.stringify(v === undefined ? null : v)); }

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API + path, { headers, ...opts });
  let json;
  try { json = await res.json(); }
  catch (_) { throw new Error('Server error (' + res.status + '). Please try refreshing the page.'); }
  // Signed out elsewhere or the session expired: back to the sign-in screen
  if (res.status === 401 && token && !path.startsWith('/auth/login')) {
    logout(true);
    throw new Error('Your session has ended. Please sign in again.');
  }
  if (res.status === 402) refreshPlanBanner();
  if (!res.ok) throw new Error(json.message || 'Request failed');
  return json.data !== undefined ? json.data : json;
}

// ═══════════════════════════════════════════════
// ENTRY LINKS — /join/CODE (tenant join link / QR), old ?register=tenant&code=X links,
// /invite/CODE (a landlord invite from the admin), /register (landlord sign-up link — there is no
// button for it on the sign-in screen), and ?open=page from a tapped phone notification
// ═══════════════════════════════════════════════
let PENDING_JOIN_CODE = null;
let PENDING_OPEN_PAGE = null;
let PENDING_INVITE_CODE = null;
let PENDING_LANDLORD_SIGNUP = false;
(function captureEntryIntent() {
  const params = new URLSearchParams(location.search);
  const m = location.pathname.match(/^\/join\/([A-Za-z0-9]{8})\/?$/);
  const inv = location.pathname.match(/^\/invite\/([A-Za-z0-9]{8})\/?$/);
  if (inv) PENDING_INVITE_CODE = inv[1].toUpperCase();
  const signup = /^\/register\/?$/.test(location.pathname);
  if (signup) PENDING_LANDLORD_SIGNUP = true;
  if (m) PENDING_JOIN_CODE = m[1].toUpperCase();
  else if (params.get('register') === 'tenant' && params.get('code')) PENDING_JOIN_CODE = params.get('code').toUpperCase();
  if (params.get('open')) PENDING_OPEN_PAGE = params.get('open');
  if (params.get('notif')) apiFetchQuiet('/notifications/' + parseInt(params.get('notif')) + '/read', { method: 'PATCH' });
  if (m || inv || signup || params.get('register') || params.get('open') || params.get('source')) history.replaceState(null, '', '/');
})();
function apiFetchQuiet(path, opts) { if (token) apiFetch(path, opts).catch(() => { }); }

// ═══════════════════════════════════════════════
// INSTALL THE APP (Add to Home Screen)
// Registered at load: Chrome fires beforeinstallprompt once, early.
// ═══════════════════════════════════════════════
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_STANDALONE = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
(function installPrompt() {
  const banner = document.getElementById('install-banner');
  const text = document.getElementById('install-text');
  const btn = document.getElementById('install-btn');
  const KEY = 'shiloh_install_dismissed';
  let dismissed = false;
  try { dismissed = localStorage.getItem(KEY) === '1'; } catch (_) { }
  document.getElementById('install-dismiss').onclick = () => {
    banner.hidden = true;
    try { localStorage.setItem(KEY, '1'); } catch (_) { }
  };
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
    if (dismissed) return;
    text.textContent = 'Install Shiloh Living on your phone for quick access and notifications.';
    btn.hidden = false; banner.hidden = false;
  });
  btn.onclick = async () => {
    if (!deferred) return;
    deferred.prompt(); await deferred.userChoice; deferred = null; banner.hidden = true;
  };
  window.addEventListener('appinstalled', () => { banner.hidden = true; });
  if (IS_IOS && !IS_STANDALONE && !dismissed) {
    text.innerHTML = 'Install Shiloh Living: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.';
    banner.hidden = false;
  }
})();

// ═══════════════════════════════════════════════
// PHONE NOTIFICATIONS (Web Push) — shown by /sw.js, sent by app.py send_push.
// iPhone/iPad: only in the app added to the Home Screen (iOS 16.4+).
// ═══════════════════════════════════════════════
const PUSH_SUPPORTED = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function b64urlToBytes(s) {
  const raw = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function swRegistration() {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  if (reg.active) return reg;
  const sw = reg.installing || reg.waiting;
  await new Promise(res => sw.addEventListener('statechange', () => { if (sw.state === 'activated') res(); }));
  return reg;
}
async function currentPushSub() {
  if (!PUSH_SUPPORTED) return null;
  return (await swRegistration()).pushManager.getSubscription();
}
async function turnOnPush() {
  const { public_key } = await apiFetch('/push/key');
  if (!public_key) throw new Error("Phone notifications aren't set up on this site yet.");
  if (await Notification.requestPermission() !== 'granted')
    throw new Error("Notifications weren't allowed. Allow them for this site in your browser's settings, then try again.");
  const reg = await swRegistration();
  let sub;
  try {
    sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(public_key) });
  } catch (_) { throw new Error("This device couldn't turn on notifications. Please try again, or use Chrome or Safari."); }
  await apiFetch('/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
}
async function turnOffPush() {
  const sub = await currentPushSub();
  if (!sub) return;
  await apiFetch('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
  await sub.unsubscribe();
}
// After every sign-in: a device that already allows notifications is linked to whoever signed in.
async function resyncPush() {
  try {
    if (!PUSH_SUPPORTED || Notification.permission !== 'granted') return;
    const sub = await currentPushSub();
    if (sub) await apiFetch('/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
  } catch (_) { }
}
// The "Notifications on this device" card in Settings
function pushCardHtml() {
  return `<div class="card"><div class="card-header"><h3>📱 Notifications on this device</h3></div>
    <div id="push-state" class="muted-text">Checking…</div>
    <div class="btn-group" style="margin-top:12px">
      <button class="btn btn-brand" id="push-btn" hidden></button>
      <button class="btn btn-outline" id="push-test-btn" hidden>Send a Test</button>
    </div>
    <p id="push-msg" class="small-msg"></p></div>`;
}
async function wirePushCard() {
  const state = document.getElementById('push-state');
  const btn = document.getElementById('push-btn');
  const testBtn = document.getElementById('push-test-btn');
  const msg = (t, good) => { const m = document.getElementById('push-msg'); m.textContent = t || ''; m.className = 'small-msg ' + (good ? 'ok' : 'bad'); };
  const show = async () => {
    btn.hidden = true; testBtn.hidden = true;
    if (!PUSH_SUPPORTED) {
      state.innerHTML = IS_IOS
        ? 'On iPhone or iPad, first add Shiloh Living to your Home Screen (tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>). Open it from there and turn this on.'
        : "This browser can't show notifications.";
      return;
    }
    if (Notification.permission === 'denied') {
      state.textContent = "Notifications are blocked for this site. Allow them in your browser's settings, then come back here.";
      return;
    }
    const on = !!(await currentPushSub()) && Notification.permission === 'granted';
    state.innerHTML = on ? '<strong>On</strong> — new bills, payments, messages and announcements pop up on this device.'
      : 'Get a phone notification for new bills, payments, messages and announcements.';
    btn.textContent = on ? 'Turn Off' : 'Turn On Notifications';
    btn.hidden = false; testBtn.hidden = !on;
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      try { await apiFetch('/push/test', { method: 'POST' }); msg('Test sent — it should appear in a few seconds.', true); }
      catch (e) { msg(e.message); }
      testBtn.disabled = false;
    };
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        if (on) { await turnOffPush(); msg('Notifications are off for this device.', true); }
        else { await turnOnPush(); msg("Notifications are on! You'll get them on this device.", true); }
      } catch (e) { msg(e.message); }
      btn.disabled = false; show();
    };
  };
  try { await show(); } catch (_) { state.textContent = "This browser can't show notifications."; }
}
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { }); });
  // A tapped notification while the app is already open
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'open-page') {
      if (e.data.id) apiFetchQuiet('/notifications/' + parseInt(e.data.id) + '/read', { method: 'PATCH' });
      if (e.data.page) goPage(e.data.page);
      loadNotifications();
    }
  });
}

// ═══════════════════════════════════════════════
// SIDEBAR / NAV
// ═══════════════════════════════════════════════
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

// ═══════════════════════════════════════════════
// NOTIFICATIONS (bell)
// ═══════════════════════════════════════════════
let _notifs = [];
async function loadNotifications() {
  if (!token) return;
  try {
    const d = await apiFetch('/notifications');
    const badgeEl = document.getElementById('notif-badge');
    const list = document.getElementById('notif-list');
    if (d.unread_count > 0) { badgeEl.textContent = d.unread_count > 99 ? '99+' : d.unread_count; badgeEl.style.display = 'flex'; }
    else badgeEl.style.display = 'none';
    _notifs = d.notifications || [];
    if (!_notifs.length) { list.innerHTML = '<div class="notif-empty">No notifications</div>'; return; }
    list.innerHTML = _notifs.map(n =>
      `<div class="notif-item ${!n.is_read ? 'unread' : ''}" onclick="readNotif(${parseInt(n.id)})">
        <div class="ntitle">${esc(n.title)}</div>
        <div class="nbody">${esc(n.body)}</div>
        <div class="ntime">${fmtDateTime(n.created_at)}</div>
      </div>`).join('');
  } catch (e) { }
}
async function readNotif(id) {
  const n = _notifs.find(x => x.id === id);
  document.getElementById('notif-dropdown').classList.remove('open');
  if (n && n.link) goPage(n.link);
  try { await apiFetch('/notifications/' + id + '/read', { method: 'PATCH' }); } catch (_) { }
  loadNotifications();
}
async function markAllNotifsRead() { await apiFetch('/notifications/read-all', { method: 'PATCH' }); loadNotifications(); document.getElementById('notif-dropdown').classList.remove('open'); }
function toggleNotifDropdown() { document.getElementById('notif-dropdown').classList.toggle('open'); }
document.addEventListener('click', e => {
  const d = document.getElementById('notif-dropdown');
  const b = document.getElementById('notif-btn');
  if (d && !d.contains(e.target) && b && !b.contains(e.target)) d.classList.remove('open');
});

// ═══════════════════════════════════════════════
// AUTH SCREENS
// Anyone can sign in or open a landlord account. Tenants only sign up through their
// landlord's join code / link / QR (like members joining a clan).
// ═══════════════════════════════════════════════
const LOGO = `<div class="auth-logo"><h1 class="brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M4 15.2 16 5l12 10.2v12.3H4V15.2Z" fill="currentColor"/><path d="M12.3 27.5v-8.3h7.4v8.3" stroke="#F7F7F2" stroke-width="2"/><path d="M8.7 15.7h4.2" stroke="#F7F7F2" stroke-width="1.7" stroke-linecap="round"/></svg></span><span>shiloh<span class="brand-light">living</span></span></h1><p>Rent, bills and messages in one calm place</p></div>`;
function authCard(html) {
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('auth-card').innerHTML = LOGO + html;
}
function joinBanner(info) {
  if (!info) return '';
  const what = `<strong>${esc(info.business_name || info.landlord_name)}</strong>${info.business_name ? `<br><span>${esc(info.landlord_name)}</span>` : ''}`;
  return `<div class="join-banner"><div class="muted-text">You've been invited to join</div><div>${what}</div></div>`;
}
let _joinInfo = null;   // the landlord/property a join code points to, once looked up

function showLogin(notice) {
  authCard(`
    ${_joinInfo ? joinBanner(_joinInfo) + '<p class="center muted-text" style="margin-bottom:12px">Sign in to join, or go back to create a new account.</p>' : ''}
    ${notice ? `<div class="info-box">${esc(notice)}</div>` : ''}
    <form onsubmit="event.preventDefault();doLogin()">
      <div class="form-group"><label>Email</label><input type="email" id="login-email" autocomplete="email" placeholder="you@example.com"/></div>
      <div class="form-group"><label>Password</label><input type="password" id="login-password" autocomplete="current-password" placeholder="••••••••"/></div>
      <button class="btn-primary" type="submit" id="login-btn">Sign In</button>
    </form>
    <p class="center" style="margin-top:10px;font-size:13px"><a href="#" onclick="event.preventDefault();showForgotPassword()">Forgot your password?</a></p>
    <p class="err-msg" id="login-err"></p>
    ${_joinInfo ? `<button class="btn-secondary" style="margin-top:14px" onclick="showTenantRegister()">← Create a new tenant account instead</button>` : `
    <div class="auth-divider"><span>New to Shiloh Living?</span></div>
    <button class="btn-secondary" onclick="showJoinCode()">🔑 I'm a tenant — I have a join code</button>`}`);
}

function showJoinCode(prefill, error) {
  _joinInfo = null;
  authCard(`
    <h2 class="auth-title">Join your landlord</h2>
    <p class="center muted-text" style="margin-bottom:14px">Enter the code your landlord gave you, or scan their QR code with your phone camera.</p>
    <form onsubmit="event.preventDefault();lookupJoinCode()">
      <div class="form-group"><label>Join Code</label>
        <input type="text" id="join-code" maxlength="8" value="${esc(prefill || '')}" placeholder="e.g. L3KX9MFA" class="code-input" autocomplete="off"/></div>
      <button class="btn-primary" type="submit">Continue</button>
    </form>
    <p class="err-msg" id="join-err">${esc(error || '')}</p>
    <button class="btn-link" onclick="showLogin()">← Back to Sign In</button>`);
}
async function lookupJoinCode(code) {
  code = (code || document.getElementById('join-code')?.value || '').trim().toUpperCase();
  const errEl = document.getElementById('join-err');
  if (!code) { if (errEl) errEl.textContent = 'Enter the code from your landlord'; return null; }
  try {
    _joinInfo = await apiFetch('/join/' + encodeURIComponent(code));
    PENDING_JOIN_CODE = _joinInfo.code;
    if (errEl) showTenantRegister();
    return _joinInfo;
  } catch (e) {
    if (errEl) errEl.textContent = e.message; else showJoinCode(code, e.message);
    return null;
  }
}

function registerFields(extra) {
  return `
    <div class="form-group"><label>Full Name</label><input type="text" id="reg-name" autocomplete="name" maxlength="150"/></div>
    ${extra || ''}
    <div class="form-group"><label>Email</label><input type="email" id="reg-email" autocomplete="email"/></div>
    <div class="form-group"><label>Phone (optional)</label><input type="tel" id="reg-phone" autocomplete="tel"/></div>
    <div class="form-group"><label>Password</label>
      <input type="password" id="reg-password" autocomplete="new-password" placeholder="Min 8 chars, uppercase, number, symbol"/>
      <small class="hint">Must contain uppercase, lowercase, a number, and a special character.</small></div>
    <div class="form-group"><label>Confirm Password</label><input type="password" id="reg-confirm-password" autocomplete="new-password"/></div>`;
}
function showTenantRegister() {
  if (!_joinInfo) { showJoinCode(); return; }
  authCard(`
    ${joinBanner(_joinInfo)}
    <h2 class="auth-title">Create your tenant account</h2>
    <form onsubmit="event.preventDefault();doRegister('tenant')">
      ${registerFields()}
      <button class="btn-primary" type="submit" id="reg-btn">Create Account &amp; Join</button>
    </form>
    <p class="err-msg" id="reg-err"></p>
    <p class="center" style="margin-top:12px;font-size:13px">Already have an account?
      <a href="#" onclick="event.preventDefault();showLogin()">Sign in to join</a></p>
    <button class="btn-link" onclick="_joinInfo=null;PENDING_JOIN_CODE=null;showLogin()">← Cancel</button>`);
}
function showLandlordRegister() {
  _joinInfo = null; PENDING_JOIN_CODE = null;
  authCard(`
    <h2 class="auth-title">Register as a Landlord</h2>
    <p class="center muted-text" style="margin-bottom:14px">Manage your properties, tenants, bills and payments. Tenants join you with your code — they don't register here.</p>
    <p class="info-box" id="reg-trial" hidden></p>
    <form onsubmit="event.preventDefault();doRegister('landlord')">
      <div class="form-group" id="reg-invite-group"><label>Invite Code</label>
        <input type="text" id="reg-invite" maxlength="8" value="${esc(PENDING_INVITE_CODE || '')}" placeholder="e.g. I7KX9MFA" class="code-input" autocomplete="off"/>
        <small class="hint">Sign-up is invite-only for now. Ask Shiloh Living support for a code.</small></div>
      ${registerFields('<div class="form-group"><label>Business Name (optional)</label><input type="text" id="reg-biz" autocomplete="organization"/></div>')}
      <button class="btn-primary" type="submit" id="reg-btn">Create Landlord Account</button>
    </form>
    <p class="err-msg" id="reg-err"></p>
    <button class="btn-link" onclick="showLogin()">← Back to Sign In</button>`);
  apiFetch('/auth/signup-info').then(info => {
    const grp = document.getElementById('reg-invite-group');
    if (grp && !info.invite_only) grp.hidden = true;
    const trial = document.getElementById('reg-trial');
    if (trial && info.trial_days) { trial.textContent = `Free for ${info.trial_days} days — no card needed.`; trial.hidden = false; }
  }).catch(() => { });
}

// ═══════════════════════════════════════════════
// PASSWORD STRENGTH VALIDATOR (mirrors backend)
// ═══════════════════════════════════════════════
function validatePasswordStrength(pw) {
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(pw)) return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(pw)) return 'Password must contain at least one lowercase letter';
  if (!/[0-9]/.test(pw)) return 'Password must contain at least one number';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must contain at least one special character (e.g. !@#$%)';
  return null;
}

// ═══════════════════════════════════════════════
// LOGIN / REGISTER
// ═══════════════════════════════════════════════
function saveSession(d) {
  token = d.token; currentUser = d.user;
  localStorage.setItem('shiloh_token', token);
  localStorage.setItem('shiloh_user', JSON.stringify(currentUser));
}
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-err');
  const btn = document.getElementById('login-btn');
  errEl.textContent = '';
  btn.disabled = true;
  try {
    saveSession(await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }));
    initApp();
  } catch (e) {
    btn.disabled = false;
    const msg = e.message || '';
    errEl.textContent = msg;
    if (msg.toLowerCase().includes('verify your email')) {
      errEl.insertAdjacentHTML('beforeend', ' <a href="#" onclick="event.preventDefault();showResendFromLogin()">Resend link</a>');
    }
  }
}
async function showResendFromLogin() {
  const email = document.getElementById('login-email').value.trim();
  if (!email) { alert('Enter your email address first'); return; }
  try { await apiFetch('/auth/resend-verification-by-email', { method: 'POST', body: JSON.stringify({ email }) }); } catch (_) { }
  alert('If that email is registered and unverified, a new verification link has been sent.');
}
async function doRegister(role) {
  const password = document.getElementById('reg-password').value;
  const errEl = document.getElementById('reg-err');
  errEl.textContent = '';
  const pwErr = validatePasswordStrength(password);
  if (pwErr) { errEl.textContent = pwErr; return; }
  if (password !== document.getElementById('reg-confirm-password').value) { errEl.textContent = 'Passwords do not match'; return; }
  const body = {
    role, password,
    full_name: document.getElementById('reg-name').value.trim(),
    email: document.getElementById('reg-email').value.trim(),
    phone: document.getElementById('reg-phone').value.trim(),
    business_name: (document.getElementById('reg-biz')?.value || '').trim(),
    landlord_code: role === 'tenant' ? PENDING_JOIN_CODE : '',
    invite_code: role === 'landlord' ? (document.getElementById('reg-invite')?.value || '').trim().toUpperCase() : '',
  };
  if (!body.full_name || !body.email) { errEl.textContent = 'Name and email are required'; return; }
  const btn = document.getElementById('reg-btn'); btn.disabled = true;
  try {
    saveSession(await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(body) }));
    PENDING_JOIN_CODE = null; _joinInfo = null; PENDING_INVITE_CODE = null;   // the account is already linked / the invite used
    showVerifyGate();
  } catch (e) { errEl.textContent = e.message; btn.disabled = false; }
}

// ═══════════════════════════════════════════════
// FORGOT / RESET PASSWORD
// ═══════════════════════════════════════════════
function showForgotPassword() {
  authCard(`
    <h2 class="auth-title">Reset your password</h2>
    <form onsubmit="event.preventDefault();doForgotPassword()">
      <div class="form-group"><label>Email Address</label><input type="email" id="fp-email" placeholder="you@example.com"/></div>
      <button class="btn-primary" type="submit">Send Reset Link</button>
    </form>
    <p class="err-msg" id="fp-err"></p>
    <button class="btn-link" onclick="showLogin()">← Back to Sign In</button>`);
}
async function doForgotPassword() {
  const email = document.getElementById('fp-email').value.trim();
  const errEl = document.getElementById('fp-err');
  errEl.textContent = '';
  if (!email) { errEl.textContent = 'Please enter your email address'; return; }
  try {
    await apiFetch('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    authCard(`<div class="center" style="padding:10px 0">
        <div style="font-size:48px;margin-bottom:12px">📧</div>
        <p style="color:var(--brand);font-weight:600;font-size:16px">Check your inbox</p>
        <p class="muted-text" style="margin-top:8px;line-height:1.6">If that email is registered, a reset link has been sent.<br>It expires in <strong>1 hour</strong>.</p>
        <button class="btn-primary" style="margin-top:16px" onclick="showLogin()">Back to Sign In</button></div>`);
  } catch (e) { errEl.textContent = e.message; }
}
let _resetToken = null;
function showResetPasswordScreen(rtoken) {
  _resetToken = rtoken;
  authCard(`
    <h2 class="auth-title">Set a new password</h2>
    <form onsubmit="event.preventDefault();doResetPassword()">
      <div class="form-group"><label>New Password</label>
        <input type="password" id="rp-password" autocomplete="new-password" placeholder="Min 8 chars, uppercase, number, symbol"/>
        <small class="hint">Must contain uppercase, lowercase, a number, and a special character.</small></div>
      <div class="form-group"><label>Confirm New Password</label><input type="password" id="rp-confirm" autocomplete="new-password"/></div>
      <button class="btn-primary" type="submit">Set New Password</button>
    </form>
    <p class="err-msg" id="rp-err"></p>`);
}
async function doResetPassword() {
  const password = document.getElementById('rp-password').value;
  const errEl = document.getElementById('rp-err');
  errEl.textContent = '';
  const pwErr = validatePasswordStrength(password);
  if (pwErr) { errEl.textContent = pwErr; return; }
  if (password !== document.getElementById('rp-confirm').value) { errEl.textContent = 'Passwords do not match'; return; }
  try {
    await apiFetch('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: _resetToken, password }) });
    showLogin('Password reset! You can now sign in with your new password.');
  } catch (e) { errEl.textContent = e.message; }
}

async function logout(expired) {
  try {
    const sub = token && await currentPushSub();
    if (sub) await fetch(API + '/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ endpoint: sub.endpoint }) });
  } catch (_) { }
  localStorage.removeItem('shiloh_token');
  localStorage.removeItem('shiloh_user');
  token = null; currentUser = null;
  history.replaceState(null, '', '/');
  clearInterval(window._notifTimer);
  closeModalDirect();
  showLogin(expired === true ? 'Your session has ended. Please sign in again.' : null);
}

// ═══════════════════════════════════════════════
// EMAIL VERIFICATION GATE
// ═══════════════════════════════════════════════
function showVerifyGate() {
  authCard(`
    <div class="center" style="padding:6px 0 10px">
      <div style="font-size:48px;margin-bottom:12px">✉️</div>
      <h2 style="color:var(--brand);margin-bottom:10px">Verify Your Email</h2>
      <p class="muted-text" style="margin-bottom:20px;line-height:1.6">
        We sent a verification link to<br><strong>${esc(currentUser.email)}</strong><br><br>
        Please check your inbox and click the link to activate your account.</p>
      <button class="btn-primary" id="resend-gate-btn" onclick="resendFromGate()">Resend Verification Email</button>
      <p id="gate-msg" style="color:var(--success);font-size:13px;margin-top:10px;display:none">✅ Email sent!</p>
      <p style="margin-top:16px;font-size:13px" class="muted-text">Already verified? <a href="#" onclick="event.preventDefault();recheckVerification()">Continue</a></p>
      <p style="margin-top:8px;font-size:13px"><a href="#" onclick="event.preventDefault();logout()" class="muted-text">Sign out</a></p>
    </div>`);
}
async function resendFromGate() {
  const btn = document.getElementById('resend-gate-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try { await apiFetch('/auth/resend-verification', { method: 'POST' }); document.getElementById('gate-msg').style.display = 'block'; }
  catch (e) { alert(e.message); }
  btn.textContent = 'Resend Verification Email'; btn.disabled = false;
}
async function recheckVerification() {
  try {
    const me = await apiFetch('/auth/me');
    if (me && me.email_verified) {
      currentUser = Object.assign({}, currentUser, me);
      localStorage.setItem('shiloh_user', JSON.stringify(currentUser));
      launchApp();
    } else alert('Email not verified yet. Check your inbox.');
  } catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// APP INIT
// ═══════════════════════════════════════════════
function initApp() {
  apiFetch('/auth/me').then(me => {
    if (me) currentUser = Object.assign({}, currentUser, me);
    localStorage.setItem('shiloh_user', JSON.stringify(currentUser));
    if (currentUser.email_verified === false) { showVerifyGate(); return; }
    launchApp();
  }).catch(() => { if (token) launchApp(); });
}

let NAV = {};   // page id -> { label, fn }

// ── PLAN BANNER (landlords) ──
// Trial days left, or — once the trial ended unpaid — that changes are paused and how to pay.
function showPlanBanner(sub) {
  const el = document.getElementById('plan-banner');
  if (!el) return;
  if (!sub || !sub.enforced || sub.state === 'exempt' || (sub.state === 'paid' && sub.days_left > 7)) { el.hidden = true; return; }
  const pay = sub.pay_info ? `<div style="margin-top:4px">${esc(sub.pay_info)}</div>` : '';
  const support = `<a href="#" onclick="event.preventDefault();goPage('support')">Message Support</a>`;
  let html;
  if (sub.state === 'expired') {
    html = `<div class="warn-box"><strong>Your free trial has ended.</strong> You can still view everything, but changes are paused until you subscribe.${pay}<div style="margin-top:4px">${support} once you've paid and we'll switch you on.</div></div>`;
  } else if (sub.state === 'trial') {
    html = `<div class="info-box">Free trial: <strong>${esc(sub.days_left)} day${sub.days_left === 1 ? '' : 's'} left</strong>.${pay}</div>`;
  } else {
    html = `<div class="info-box">Your plan renews in <strong>${esc(sub.days_left)} day${sub.days_left === 1 ? '' : 's'}</strong>.${pay}</div>`;
  }
  el.innerHTML = html; el.hidden = false;
}
let _planRefreshing = false;
function refreshPlanBanner() {
  if (_planRefreshing || !currentUser || currentUser.role !== 'landlord') return;
  _planRefreshing = true;
  apiFetch('/auth/me').then(me => { if (me && me.profile) showPlanBanner(me.profile.subscription); })
    .catch(() => { }).finally(() => { _planRefreshing = false; });
}
function launchApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  document.getElementById('sidebar-name').textContent = currentUser.full_name;
  document.getElementById('sidebar-role').textContent = currentUser.role;
  document.getElementById('sidebar-avatar').textContent = (currentUser.full_name || 'U')[0].toUpperCase();
  _navEntries = []; _navIdx = -1;
  buildNav();
  if (currentUser.role === 'landlord') refreshPropertyFeatureNav();
  showPlanBanner(currentUser.role === 'landlord' && currentUser.profile ? currentUser.profile.subscription : null);
  loadNotifications();
  clearInterval(window._notifTimer);
  window._notifTimer = setInterval(loadNotifications, 60000);
  resyncPush();
  if (PENDING_JOIN_CODE) handlePendingJoin();
}

function buildNav() {
  const nav = document.getElementById('sidebar-nav'); nav.innerHTML = '';
  const role = currentUser.role; let items = [];
  if (role === 'landlord') items = [
    { id: 'dashboard', icon: '📊', label: 'Dashboard', fn: loadLandlordDashboard },
    { id: 'properties', icon: '🏢', label: 'Properties & Units', fn: loadProperties },
    { id: 'tenants', icon: '👥', label: 'Tenants', fn: loadTenants },
    { group: 'gen-bills', icon: '⚡', label: 'Generate Bills', children: [
      { id: 'gen-rent', icon: '🏠', label: 'Monthly Rent', fn: loadGenerateRent },
      { id: 'water', icon: '💧', label: 'Water Bills', fn: loadWaterBilling },
    ] },
    { id: 'announcements', icon: '📣', label: 'Announcements & Reminders', fn: loadLandlordAnnouncements },
    { id: 'messages', icon: '💬', label: 'Messages', fn: loadMessages },
    { id: 'l-settings', icon: '⚙️', label: 'Settings', fn: loadLandlordSettings, bottom: true },
    { id: 'account', icon: '👤', label: 'Account', fn: loadAccount, bottom: true },
    { id: 'billing', icon: '🧾', label: 'Billing & Plan', fn: loadBillingPlan, bottom: true },
    { id: 'support', icon: '🎫', label: 'Help & Support', fn: () => loadSupport('landlord'), under: 'l-settings' },
  ];
  else if (role === 'tenant') items = [
    { id: 't-dashboard', icon: '📊', label: 'My Home', fn: loadTenantDashboard },
    { id: 't-checklist', icon: '✅', label: 'Move-in Checklist', fn: loadTenantChecklist },
    { id: 't-contract', icon: '📋', label: 'My Contracts', fn: loadTenantContracts },
    { id: 't-bills', icon: '💰', label: 'My Bills', fn: loadTenantBills },
    { id: 't-announcements', icon: '📣', label: 'Announcements', fn: loadTenantAnnouncements },
    { id: 't-messages', icon: '💬', label: 'Messages', fn: loadTenantMessages },
    { id: 't-settings', icon: '⚙️', label: 'Settings', fn: loadTenantSettings, bottom: true },
    { id: 'account', icon: '👤', label: 'Account', fn: loadAccount, bottom: true },
    { id: 't-support', icon: '🎫', label: 'Help & Support', fn: () => loadSupport('tenant'), under: 't-settings' },
  ];
  else if (role === 'admin') items = [
    { id: 'admin-stats', icon: '📊', label: 'Overview', fn: loadAdminStats },
    { id: 'admin-landlords', icon: '🏠', label: 'Landlords', fn: loadAdminLandlords },
    { id: 'admin-tenants', icon: '👥', label: 'Tenants', fn: loadAdminTenants },
    { id: 'admin-properties', icon: '🏢', label: 'Properties', fn: loadAdminProperties },
    { id: 'admin-invites', icon: '✉️', label: 'Invites', fn: loadAdminInvites },
    { id: 'admin-tickets', icon: '🎫', label: 'Support Tickets', fn: loadAdminTickets },
    { id: 'admin-chat', icon: '💬', label: 'Live Chat', fn: loadAdminChat },
    { id: 'admin-audit', icon: '📝', label: 'Audit Log', fn: loadAdminAudit },
    { id: 'admin-bin', icon: '🗑️', label: 'Recycle Bin', fn: loadAdminBin },
    { id: 'account', icon: '👤', label: 'Account', fn: loadAccount, bottom: true },
  ];
  NAV = {};
  const navItem = (item, parent) => {
    NAV[item.id] = item;
    const el = document.createElement('div');
    el.className = 'nav-item' + (parent ? ' nav-child' : ''); el.id = 'nav-' + item.id;
    el.innerHTML = `<span class="nav-icon">${item.icon}</span><span>${esc(item.label)}</span>`;
    el.onclick = () => { goPage(item.id); closeSidebar(); };
    return el;
  };
  // Settings / Account / Billing sit at the bottom; pages opened from inside another page
  // (e.g. Help & Support from Settings) have no menu entry of their own (`under`)
  const bottom = document.getElementById('sidebar-nav-bottom'); bottom.innerHTML = '';
  items.forEach(item => {
    if (item.under) { NAV[item.id] = item; return; }
    if (!item.group) { (item.bottom ? bottom : nav).appendChild(navItem(item)); return; }
    // A group (e.g. Generate Bills): tap to open its sub-menu
    const wrap = document.createElement('div');
    wrap.className = 'nav-group-wrap'; wrap.id = 'navgroup-' + item.group;
    const head = document.createElement('div');
    head.className = 'nav-item nav-group';
    head.innerHTML = `<span class="nav-icon">${item.icon}</span><span>${esc(item.label)}</span><span class="nav-caret">›</span>`;
    head.onclick = () => wrap.classList.toggle('open');
    const kids = document.createElement('div'); kids.className = 'nav-children';
    item.children.forEach(c => kids.appendChild(navItem(c, item)));
    wrap.append(head, kids);
    nav.appendChild(wrap);
  });
  bottom.hidden = !bottom.children.length;
  items = items.flatMap(i => i.group ? i.children : i.under ? [] : [i]);
  // A tapped notification wins, then the page in the address (refresh), then the first page
  const opened = PENDING_OPEN_PAGE && NAV[PENDING_OPEN_PAGE];
  if (opened) goPage(PENDING_OPEN_PAGE);
  PENDING_OPEN_PAGE = null;
  if (!opened && !restoreRoute() && items[0]) goPage(items[0].id);
}
// Opens a page by id (sidebar, notifications, quick actions)
// Pages that moved (old notifications and bookmarks still point at them)
const MOVED_PAGES = { payments: 'dashboard', contracts: 'tenants', units: 'properties', bills: 'tenants', reminders: 'l-settings' };
function goPage(id) {
  const item = NAV[id] || NAV[MOVED_PAGES[id]];
  if (!NAV[id] && item) id = MOVED_PAGES[id];
  if (item) showView(id, item.fn);
}

// Each screen has an address (#/tenants, #/tenant/5 ...) so a refresh reopens it.
// Views inside a page open on top of their parent page, so back still works after a refresh.
const SUB_ROUTES = {
  tenant: { parent: 'tenants', open: id => openTenantProfile(id) },
  water: { parent: 'water', open: id => viewWaterSession(id) },
  chat: { parent: 'admin-chat', open: id => openAdminChat(id) },
};
function restoreRoute() {
  const m = location.hash.match(/^#\/([\w-]+)(?:\/(\d+))?$/);
  if (!m) return false;
  if (m[2]) {
    const r = SUB_ROUTES[m[1]];
    if (!r || !NAV[r.parent]) return false;
    goPage(r.parent); r.open(parseInt(m[2]));
    return true;
  }
  if (!NAV[m[1]] && !NAV[MOVED_PAGES[m[1]]]) return false;
  goPage(m[1]);
  return true;
}

// ── BACK BUTTON ──
// Every screen the person moves to (a page, or a view inside one like a property's units) is a
// browser history entry, so the topbar ← and the phone's own back button/gesture both step back.
// An open pop-up is an entry too: back closes it first.
let _navEntries = [];   // index -> { page, render }
let _navIdx = -1;
let _modalEntry = false;
function showView(page, render, route) {
  _navEntries = _navEntries.slice(0, _navIdx + 1);
  _navEntries.push({ page, render });
  _navIdx = _navEntries.length - 1;
  const url = '#/' + (route || page);
  if (_navIdx === 0) history.replaceState({ nav: 0 }, '', url);
  else history.pushState({ nav: _navIdx }, '', url);
  renderView();
}
function renderView() {
  const en = _navEntries[_navIdx];
  setPage(en.page);
  en.render();
  document.getElementById('back-btn').hidden = _navIdx <= 0;
  window.scrollTo(0, 0);
}
function goBack() {
  if (_navIdx > 0) history.back();
}
window.addEventListener('popstate', e => {
  if (document.getElementById('modal-overlay').classList.contains('open')) { closeModalDirect(true); return; }
  const idx = e.state && typeof e.state.nav === 'number' ? e.state.nav : null;
  if (!currentUser || idx === null || !_navEntries[idx]) return;
  // Landing on the screen already shown (the leftover entry of a closed pop-up): keep going
  if (idx === _navIdx) { if (idx > 0) history.back(); return; }
  _navIdx = idx;
  renderView();
});
function setPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pg = document.getElementById('page-' + id); if (pg) pg.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const ni = document.getElementById('nav-' + id) || (NAV[id] && NAV[id].under && document.getElementById('nav-' + NAV[id].under));
  if (ni) ni.classList.add('active');
  const grp = ni && ni.closest('.nav-group-wrap'); if (grp) grp.classList.add('open');
  const labels = { 't-dashboard': 'My Home', 'admin-stats': 'Platform Overview', 'admin-chat': 'Live Support Chat' };
  document.getElementById('topbar-title').textContent = labels[id] || (NAV[id] && NAV[id].label) || '';
}

// A /join/CODE link opened while signed in (or used to sign in)
async function handlePendingJoin() {
  const code = PENDING_JOIN_CODE; PENDING_JOIN_CODE = null;
  if (currentUser.role !== 'tenant') {
    alert('That join link is for tenants. Share it with your tenants so they can join you.');
    return;
  }
  let info = _joinInfo;
  if (!info || info.code !== code) {
    try { info = await apiFetch('/join/' + encodeURIComponent(code)); }
    catch (e) { alert(e.message); return; }
  }
  _joinInfo = null;
  const name = info.business_name || info.landlord_name;
  openModal('Join landlord', `${joinBanner(info)}<p class="err-msg" id="m-join-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Not now</button>
     <button class="btn btn-brand" onclick="submitJoinLandlord(${jsArg(code)})">Join ${esc(name)}</button>`);
}

// ═══════════════════════════════════════════════
// MODAL
// ═══════════════════════════════════════════════
function openModal(title, body, footer = '') {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-footer').innerHTML = footer;
  if (!_modalEntry && currentUser) { history.pushState({ nav: _navIdx, modal: true }, ''); _modalEntry = true; }
  document.getElementById('modal-overlay').classList.add('open');
  document.body.classList.add('modal-open');
}
function closeModal(e) { if (!e || e.target === document.getElementById('modal-overlay')) closeModalDirect(); }
// fromBack: closed by the back button/gesture. Otherwise the pop-up's history entry is left as
// a copy of the current screen, which the back handler skips over.
function closeModalDirect(fromBack) {
  document.getElementById('modal-overlay').classList.remove('open');
  document.body.classList.remove('modal-open');
  if (_modalEntry && fromBack !== true) history.replaceState({ nav: _navIdx }, '');
  _modalEntry = false;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModalDirect(); });

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
function badge(status) {
  const map = {
    active: 'green', occupied: 'green', approved: 'green', paid: 'green', billed: 'green', resolved: 'green',
    pending: 'yellow', vacant: 'yellow', draft: 'yellow', open: 'yellow', in_progress: 'orange', move_out_pending: 'orange',
    overdue: 'red', terminated: 'red', rejected: 'red', high: 'red',
    expired: 'gray', maintenance: 'gray', water: 'blue', electricity: 'purple', rent: 'gray', other: 'gray',
    normal: 'gray', low: 'gray', custom: 'gray', water_reading: 'blue', bill_generation: 'purple', payment_collection: 'green'
  };
  const s = String(status || '');
  return `<span class="badge badge-${map[s] || 'gray'}">${esc(s.replace(/_/g, ' '))}</span>`;
}
function fmt(val) { if (val === null || val === undefined || val === '') return '—'; return Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
// Plain dates (due dates, contract dates) arrive as "... 00:00:00 GMT"; show them as that calendar
// day everywhere instead of shifting a day back in timezones west of UTC.
function fmtDate(d) {
  if (!d) return '—';
  const x = new Date(d);
  if (isNaN(x)) return '—';
  return x.toLocaleDateString(undefined, typeof d === 'string' && / 00:00:00 GMT$/.test(d) ? { timeZone: 'UTC' } : {});
}
function fmtDateTime(d) { return d ? new Date(d).toLocaleString() : '—'; }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const loadingHtml = '<p class="loading">Loading…</p>';
const errHtml = e => `<p class="err-msg">${esc(e.message)}</p>`;

// Bill statements and receipts: the window opens right away (so it isn't blocked as a pop-up),
// then goes to a 10-minute link for that one PDF (see /api/docs/link). Print from the PDF viewer.
async function openPdf(path) {
  const w = window.open('', '_blank');
  try {
    const d = await apiFetch('/docs/link', { method: 'POST', body: JSON.stringify({ path }) });
    if (w) w.location.href = d.url; else location.href = d.url;
  } catch (e) { if (w) w.close(); alert(e.message); }
}
async function resendReceipt(pid) {
  try { const d = await apiFetch(`/payments/${pid}/send-receipt`, { method: 'POST' }); alert(`✅ Receipt ${d.receipt_no} sent again.`); }
  catch (e) { alert(e.message); }
}
function openDoc(url) {
  if (url && url.startsWith('/api/files/')) { openPdf(url); return; }
  if (!url || !/^https:\/\//.test(url)) { alert('No document available'); return; }
  window.open(url, '_blank', 'noopener,noreferrer');
}
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); alert(okMsg || 'Copied!'); }
  catch (_) { prompt('Copy this:', text); }
}

// Phones: tables become stacked cards. Each cell gets its column name (data-label) so the
// CSS can show it; runs on whatever is rendered into a page or the modal.
function labelTables(root) {
  root.querySelectorAll('table').forEach(t => {
    const heads = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
    t.querySelectorAll('tbody tr').forEach(tr => {
      [...tr.children].forEach((td, i) => { if (heads[i] && !td.dataset.label) td.dataset.label = heads[i]; });
    });
  });
}
new MutationObserver(muts => {
  const roots = new Set(muts.map(m => m.target.closest ? (m.target.closest('.page, #modal-body') || null) : null).filter(Boolean));
  roots.forEach(labelTables);
}).observe(document.body, { childList: true, subtree: true });

// ═══════════════════════════════════════════════
// FILE UPLOADS — to our own server (POST /api/files); files stay private to the record's
// tenant and landlord. kind: payment_proof | contract | repair_proof
// ═══════════════════════════════════════════════
const UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf';
// Opens the phone's file / camera picker. Must run straight from a tap.
function pickFile(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.style.display = 'none';
    input.onchange = () => { resolve(input.files[0] || null); input.remove(); };
    document.body.append(input);
    input.click();
  });
}
// Phone photos are often 4–8 MB; shrink big JPG/PNG/WEBP to at most 2000px before sending.
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5 * 1024 * 1024 || !window.createImageBitmap) return file;
  try {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch (_) { return file; }
}
// Returns { url } or null if nothing was chosen. statusEl (optional) shows progress.
async function uploadFile(kind, accept, statusEl) {
  const file = await pickFile(accept || UPLOAD_ACCEPT);
  if (!file) return null;
  if (statusEl) statusEl.textContent = 'Uploading…';
  const body = new FormData();
  body.append('kind', kind);
  body.append('file', await shrinkImage(file));
  const res = await fetch(API + '/files', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
  let json = {};
  try { json = await res.json(); } catch (_) { }
  if (statusEl) statusEl.textContent = '';
  if (!res.ok) throw new Error(json.message || 'Upload failed. Please try again.');
  return json.data;
}

// ═══════════════════════════════════════════════
// CONFIRMATIONS — asked before anything is deleted (and other big actions). Shown above any open
// pop-up. For big deletes the person types the name first, like HubSpot.
// ═══════════════════════════════════════════════
let _confirmDone = null;
function confirmAction({ title, message = '', effects = [], typeToConfirm = null, okText = 'Delete', danger = true, blocked = null }) {
  if (_confirmDone) _confirmDone(false);
  return new Promise(resolve => {
    const layer = document.getElementById('confirm-overlay');
    const ok = document.getElementById('confirm-ok');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').innerHTML = `
      ${message ? `<p>${esc(message)}</p>` : ''}
      ${effects.length ? `<ul class="confirm-effects">${effects.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
      ${blocked ? `<div class="warn-box">${esc(blocked)}</div>` : ''}
      ${typeToConfirm && !blocked ? `<div class="form-group" style="margin-top:12px"><label>Type <strong class="no-caps">${esc(typeToConfirm)}</strong> to confirm</label>
        <input type="text" id="confirm-input" autocomplete="off"/></div>` : ''}`;
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'btn-red' : 'btn-brand');
    ok.hidden = !!blocked;
    const input = document.getElementById('confirm-input');
    const matches = () => !typeToConfirm || (input && input.value.trim().toLowerCase() === typeToConfirm.trim().toLowerCase());
    ok.disabled = !matches();
    if (input) { input.oninput = () => { ok.disabled = !matches(); }; setTimeout(() => input.focus(), 50); }
    const done = answer => {
      layer.classList.remove('open'); _confirmDone = null;
      ok.onclick = null; document.getElementById('confirm-cancel').onclick = null; layer.onclick = null;
      resolve(answer);
    };
    _confirmDone = done;
    ok.onclick = () => { if (matches()) done(true); };
    document.getElementById('confirm-cancel').textContent = blocked ? 'OK' : 'Cancel';
    document.getElementById('confirm-cancel').onclick = () => done(false);
    layer.onclick = e => { if (e.target === layer) done(false); };
    layer.classList.add('open');
  });
}
document.addEventListener('keydown', e => {
  if (!_confirmDone) return;
  if (e.key === 'Escape') { e.stopImmediatePropagation(); _confirmDone(false); }
  if (e.key === 'Enter' && !document.getElementById('confirm-ok').disabled && !document.getElementById('confirm-ok').hidden) document.getElementById('confirm-ok').click();
}, true);
// Re-draws the screen that's showing (after an action inside a page, e.g. on a tenant's profile)
function refreshView() { const en = _navEntries[_navIdx]; if (en) en.render(); }

// ═══════════════════════════════════════════════
// ADMIN — all properties, deleting, Recycle Bin
// ═══════════════════════════════════════════════
async function adminDeleteUser(id) {
  try {
    const info = await apiFetch(`/admin/delete-preview/user/${id}`);
    const ok = await confirmAction({ title: `Delete ${info.role} ${info.name}?`, message: info.email, effects: info.effects,
      blocked: info.blocked, typeToConfirm: info.name, okText: 'Delete' });
    if (!ok) return;
    await apiFetch(`/admin/users/${id}`, { method: 'DELETE' });
    refreshView();
  } catch (e) { alert(e.message); }
}
async function loadAdminProperties() {
  const pg = document.getElementById('page-admin-properties'); pg.innerHTML = loadingHtml;
  try {
    const rows = await apiFetch('/admin/properties');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Properties (${rows.length})</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Property</th><th>Landlord</th><th>Units</th><th>Active contracts</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><strong>${esc(r.name)}</strong><br><small class="muted-text">${esc(r.address)}${r.city ? ', ' + esc(r.city) : ''}</small></td>
        <td>${esc(r.business_name || r.landlord_name)}</td><td>${esc(r.units)}</td><td>${esc(r.active_contracts)}</td>
        <td><button class="btn btn-sm btn-red" onclick="adminDeleteProperty(${parseInt(r.id)})">Delete</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function adminDeleteProperty(id) {
  try {
    const info = await apiFetch(`/admin/delete-preview/property/${id}`);
    if (!await confirmAction({ title: `Delete property ${info.name}?`, effects: info.effects, blocked: info.blocked, typeToConfirm: info.name })) return;
    await apiFetch(`/admin/properties/${id}`, { method: 'DELETE' });
    refreshView();
  } catch (e) { alert(e.message); }
}
async function loadAdminBin() {
  const pg = document.getElementById('page-admin-bin'); pg.innerHTML = loadingHtml;
  try {
    const d = await apiFetch('/admin/recycle-bin');
    const by = r => r.deleted_by_name ? ` by ${esc(r.deleted_by_name)}` : '';
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>🗑️ Recycle Bin</h3></div>
        <p class="muted-text">Deleted accounts and properties. Their records were kept; restore brings them back.
          Restored tenants rejoin their landlord with the landlord's code. <strong>Erase</strong> removes an account and all its
          records for good — for test accounts and privacy requests.</p></div>
      <div class="card"><div class="card-header"><h3>Accounts (${d.users.length})</h3></div>
        ${!d.users.length ? '<p class="muted-text">Nothing here.</p>' : d.users.map(u => `<div class="record">
          <div class="record-top"><strong>${esc(u.name)}</strong>${badge(u.role)}</div>
          <div class="record-meta">${esc(u.email)} · deleted ${fmtDateTime(u.deleted_at)}${by(u)}</div>
          <div class="btn-group" style="margin-top:6px">
            <button class="btn btn-sm btn-brand" onclick="restoreItem('user', ${parseInt(u.id)}, ${jsArg(u.name)})">↩ Restore</button>
            <button class="btn btn-sm btn-red" onclick="eraseUser(${parseInt(u.id)})">Erase permanently</button></div></div>`).join('')}
      </div>
      <div class="card"><div class="card-header"><h3>Properties (${d.properties.length})</h3></div>
        ${!d.properties.length ? '<p class="muted-text">Nothing here.</p>' : d.properties.map(p => `<div class="record">
          <div class="record-top"><strong>${esc(p.name)}</strong><span class="muted-text small">${esc(p.landlord_name)}</span></div>
          <div class="record-meta">${esc(p.address)} · deleted ${p.deleted_at ? fmtDateTime(p.deleted_at) : '(before the Recycle Bin)'}${by(p)}</div>
          <button class="btn btn-sm btn-brand" style="margin-top:6px" onclick="restoreItem('property', ${parseInt(p.id)}, ${jsArg(p.name)})">↩ Restore</button></div>`).join('')}
      </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function eraseUser(id) {
  try {
    const info = await apiFetch('/admin/recycle-bin/erase-preview/' + id);
    if (!await confirmAction({ title: `Erase ${info.name} permanently?`, okText: 'Erase forever',
        message: `This ${info.role} account (${info.email}) and everything below are deleted for good:`,
        effects: info.effects, typeToConfirm: info.email })) return;
    await apiFetch('/admin/recycle-bin/erase', { method: 'POST', body: JSON.stringify({ id, confirm: info.email }) });
    refreshView();
  } catch (e) { alert(e.message); }
}
async function restoreItem(type, id, name) {
  if (!await confirmAction({ title: `Restore ${name}?`, message: type === 'user' ? 'They can sign in again.' : 'It shows up again for its landlord.', okText: 'Restore', danger: false })) return;
  try { await apiFetch('/admin/recycle-bin/restore', { method: 'POST', body: JSON.stringify({ type, id }) }); refreshView(); }
  catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// TENANT RECORDS — payments to review, files
// ═══════════════════════════════════════════════
const billPeriod = x => x.bill_month ? `${MONTHS[x.bill_month - 1]} ${x.bill_year}` : '';
// "Electricity (September 2026)", but just "Monthly Rent — September 2026" when the name already says the month
const forBill = x => esc(x.bill_desc) + (billPeriod(x) && !String(x.bill_desc || '').includes(billPeriod(x)) ? ' (' + billPeriod(x) + ')' : '');
function reviewRecord(p, showTenant) {
  return `<div class="record">
    <div class="record-top"><strong>${showTenant ? `<span class="link" onclick="openTenantProfile(${parseInt(p.tenant_id)})">${esc(p.tenant_name)}</span> · ` : ''}₱${fmt(p.amount_paid)}</strong>${badge('pending')}</div>
    <div class="record-meta">For ${forBill(p)} · bill ₱${fmt(p.bill_amount)}
      · ${esc(p.property_name)} Unit ${esc(p.unit_number)} · sent ${fmtDateTime(p.paid_at)}</div>
    <div class="btn-group" style="margin-top:6px">
      ${p.proof_url ? `<button class="btn btn-sm btn-outline" onclick="openDoc(${jsArg(p.proof_url)})">📎 Proof</button>` : ''}
      <button class="btn btn-sm btn-green" onclick="reviewPayment(${parseInt(p.id)},'approve')">✓ Approve &amp; send receipt</button>
      <button class="btn btn-sm btn-red" onclick="rejectPaymentModal(${parseInt(p.id)})">✗ Reject</button>
    </div></div>`;
}
// Every file on a tenant's record, newest first: contracts, proofs, receipts, checklist, move-out
function tenantFiles(data) {
  const out = [];
  const place = x => `${esc(x.property_name || '')}${x.unit_number ? ' Unit ' + esc(x.unit_number) : ''}`;
  data.contracts.forEach(c => {
    if (c.contract_doc_url) out.push({ kind: 'contract', when: c.doc_uploaded_at || c.created_at, title: 'Signed contract', about: place(c), open: `openDoc(${jsArg(c.contract_doc_url)})` });
    if (c.repair_proof_url) out.push({ kind: 'moveout', when: c.move_out_date || c.updated_at, title: 'Move-out repair receipts/photos', about: place(c), open: `openDoc(${jsArg(c.repair_proof_url)})` });
  });
  data.payments.forEach(p => {
    const forWhat = `${forBill(p)} · ₱${fmt(p.amount_paid)}`;
    if (p.proof_url) out.push({ kind: 'proof', when: p.paid_at, title: `Proof of payment${p.status !== 'approved' ? ' — ' + esc(p.status) : ''}`, about: forWhat, open: `openDoc(${jsArg(p.proof_url)})` });
    if (p.status === 'approved') out.push({ kind: 'receipt', when: p.receipt_sent_at || p.reviewed_at, title: `Receipt ${esc(p.receipt_no || '')}`, about: forWhat, open: `openPdf('/api/payments/${parseInt(p.id)}/receipt.pdf')` });
  });
  ((data.checklist || {}).items || []).forEach(i => {
    if (i.file_url) out.push({ kind: 'movein', when: i.submitted_at || i.reviewed_at, title: esc(i.label), about: 'Move-in checklist · ' + REQ_STATUS[i.status][0], open: `openDoc(${jsArg(i.file_url)})` });
  });
  return out;
}
const FILE_KINDS = [['all', 'All'], ['contract', 'Contracts'], ['proof', 'Proofs of payment'], ['receipt', 'Receipts'], ['movein', 'Move-in'], ['moveout', 'Move-out']];
function filesSectionHtml() {
  const files = sortedBy(tenantFiles(_profile.data).filter(f => _profile.fileKind === 'all' || f.kind === _profile.fileKind), 'when', _profile.sort.files);
  return `<div class="chip-row">${FILE_KINDS.map(([k, l]) => `<button class="chip ${_profile.fileKind === k ? 'active' : ''}" onclick="setFileKind('${k}')">${l}</button>`).join('')}</div>
    ${files.length ? files.map(f => `<div class="record clickable" onclick="${f.open}">
      <div class="record-top"><strong>📄 ${f.title}</strong><span class="muted-text small">${fmtDate(f.when)}</span></div>
      <div class="record-meta">${f.about}</div></div>`).join('') : '<p class="muted-text">No files.</p>'}`;
}
function setFileKind(k) { _profile.fileKind = k; document.getElementById('ps-files').innerHTML = filesSectionHtml(); }

// ═══════════════════════════════════════════════
// INVITE TENANTS — join code, link, QR (tap to share), printable poster
// ═══════════════════════════════════════════════
const joinUrl = code => `${location.origin}/join/${code}`;
const qrSrc = code => `/api/join/${encodeURIComponent(code)}/qr.png`;
let _invite = null;   // { code, title }

async function showLandlordInvite() {
  try {
    const d = await apiFetch('/landlord/join-code');
    _invite = { code: d.code, title: d.business_name || currentUser.full_name };
    renderInvite();
  } catch (e) { alert(e.message); }
}
function renderInvite() {
  const { code, title } = _invite;
  openModal('Invite tenants', `
    <p class="muted-text center" style="margin-bottom:10px">Tenants who join with this code are linked to you. A tenant can join more than one landlord.</p>
    <div class="center">
      <button type="button" class="qr-btn" id="invite-qr-btn" aria-label="Share the QR code">
        <img id="invite-qr" src="${qrSrc(code)}" alt="QR code to join ${esc(title)}" width="220" height="220"/>
      </button>
      <p class="hint">Tap the QR code to share it. Scanning it with a phone camera opens the sign-up page.</p>
      <div class="code-card">${esc(code)}</div>
      <div class="link-text">${esc(joinUrl(code))}</div>
    </div>
    <div class="invite-actions">
      <button class="btn btn-brand" onclick="shareJoinLink()">📤 Share Join Link</button>
      <button class="btn btn-outline" onclick="copyText(joinUrl(_invite.code), 'Join link copied!')">📋 Copy Link</button>
      <button class="btn btn-outline" onclick="printInvite()">🖨️ Print Poster</button>
    </div>
    <p class="small-msg" id="invite-msg"></p>
    <details class="danger-zone"><summary>Code shared with the wrong people?</summary>
      <p class="hint">Make a new code. The old code, link and printed QR stop working; tenants who already joined stay.</p>
      <button class="btn btn-sm btn-red" onclick="regenerateInviteCode()">Make a New Code</button></details>`,
    `<button class="btn btn-brand" onclick="closeModalDirect()">Done</button>`);
  const img = document.getElementById('invite-qr');
  img.addEventListener('contextmenu', e => e.preventDefault());
  document.getElementById('invite-qr-btn').onclick = shareInviteQr;
}
function inviteText() {
  const { code, title } = _invite;
  return `Join ${title} on Shiloh Living to see your bills, pay rent and message your landlord: ${joinUrl(code)} (join code ${code})`;
}
async function shareJoinLink() {
  const say = t => { document.getElementById('invite-msg').textContent = t; };
  const url = joinUrl(_invite.code);
  if (!navigator.share) { try { await navigator.clipboard.writeText(url); say('Link copied!'); } catch (_) { say(url); } return; }
  try { await navigator.share({ title: `Join ${_invite.title}`, text: inviteText(), url }); }
  catch (e) { if (e.name !== 'AbortError') say(url); }
}
// The phone's long-press "share image" would share this page's address instead of the join
// link, so tapping shares the picture with the link in the text (or downloads it on a computer).
async function shareInviteQr() {
  const say = t => { document.getElementById('invite-msg').textContent = t; };
  try {
    const blob = await (await fetch(qrSrc(_invite.code))).blob();
    const file = new File([blob], `Join ${_invite.title}.png`.replace(/[\\/:*?"<>|]/g, ''), { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: `Join ${_invite.title}`, text: inviteText() }); }
      catch (e) { if (e.name !== 'AbortError') throw e; }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = file.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    say('QR code saved to your Downloads.');
  } catch (_) { say("Couldn't share the QR code. Please try again."); }
}
function printInvite() {
  const { code, title } = _invite;
  const w = window.open('', '_blank');
  if (!w) { alert('Allow pop-ups to print the poster.'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Join ${esc(title)}</title>
    <style>body{font-family:-apple-system,Segoe UI,sans-serif;text-align:center;padding:40px;color:#1B4332}
    h1{font-size:30px;margin:0 0 6px}p{font-size:17px;color:#444}img{width:320px;height:320px;margin:20px 0}
    .code{font:700 34px/1 'Courier New',monospace;letter-spacing:6px;margin:10px 0}.url{font-size:14px;color:#666}</style></head>
    <body><h1>${esc(title)}</h1><p>Scan with your phone camera to join on <strong>Shiloh Living</strong></p>
    <img src="${location.origin + qrSrc(code)}" onload="setTimeout(()=>print(),200)"/>
    <p>Or go to <span class="url">${esc(location.origin)}</span>, tap <em>I'm a tenant</em>, and enter:</p>
    <div class="code">${esc(code)}</div></body></html>`);
  w.document.close();
}
async function regenerateInviteCode() {
  if (!await confirmAction({ title: 'Make a new join code?', message: 'The current code, link and any printed QR codes stop working. Tenants who already joined stay.', okText: 'Make New Code' })) return;
  try {
    const d = await apiFetch('/landlord/join-code', { method: 'POST', body: JSON.stringify({ regenerate: true }) });
    _invite.code = d.code;
    renderInvite();
    if (document.getElementById('page-dashboard').classList.contains('active')) loadLandlordDashboard();
  } catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// LANDLORD DASHBOARD
// ═══════════════════════════════════════════════
async function loadLandlordDashboard() {
  const pg = document.getElementById('page-dashboard');
  pg.innerHTML = loadingHtml;
  try {
    const d = await apiFetch('/landlord/dashboard'); const s = d.summary || {};
    const remBanners = (d.due_reminders || []).map(r =>
      `<div class="reminder-banner"><span style="font-size:20px">⏰</span>
        <div style="flex:1"><strong>${esc(r.title)}</strong><div style="font-size:12px;color:var(--warn);margin-top:2px">Today</div></div>
        ${r.page && r.page !== 'dashboard' ? `<button class="btn btn-sm btn-brand" onclick="goPage(${jsArg(r.page)})">Open</button>` : ''}</div>`).join('');
    const stat = (v, label, page) => `<div class="stat-card"${page ? ` onclick="goPage('${page}')" role="button"` : ''}><div class="value">${esc(v)}</div><div class="label">${label}</div></div>`;
    pg.innerHTML = `${remBanners}
      <div class="stats-grid">
        ${stat(s.total_properties || 0, 'Properties', 'properties')}
        ${stat(s.total_units || 0, 'Units', 'properties')}
        ${stat(s.occupied_units || 0, 'Occupied', 'properties')}
        ${stat(s.vacant_units || 0, 'Vacant', 'properties')}
        ${stat(s.total_tenants || 0, 'Tenants', 'tenants')}
        <div class="stat-card" role="button" onclick="document.getElementById('review-card').scrollIntoView({behavior:'smooth'})"><div class="value">${esc(s.pending_payments || 0)}</div><div class="label">Payments to Review</div></div>
        ${stat('₱' + fmt(s.outstanding_amount || 0), 'Unpaid Bills', 'tenants')}
        ${stat(d.unread_threads || 0, 'Unread Messages', 'messages')}
      </div>
      <div class="card" id="review-card"><div class="card-header"><h3>💳 Payments to review (${(d.to_review || []).length})</h3></div>
        ${(d.to_review || []).length ? d.to_review.map(p => reviewRecord(p, true)).join('') : '<p class="muted-text">Nothing to review. New proofs of payment show up here.</p>'}
      </div>
      <div class="card invite-card"><div class="card-header"><h3>👋 Invite Tenants</h3></div>
        <p class="muted-text">Tenants join you with your code, link or QR code — they can't register on their own.</p>
        <button class="btn btn-brand" style="margin-top:10px" onclick="showLandlordInvite()">📱 QR Code &amp; Share Link</button>
      </div>
      <div class="grid-2">
        <div class="card"><div class="card-header"><h3>Recent Payments</h3></div>
          ${!(d.recent_payments || []).length ? '<p class="muted-text">No payments yet</p>' :
        `<div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Amount</th><th>Status</th></tr></thead><tbody>
            ${d.recent_payments.map(p => `<tr><td>${esc(p.tenant_name)}</td><td>₱${fmt(p.amount_paid)}</td><td>${badge(p.status)}</td></tr>`).join('')}
            </tbody></table></div>`}
        </div>
        <div class="card"><div class="card-header"><h3>Quick Actions</h3></div>
          <div class="quick-actions">
            <button class="btn btn-brand" onclick="goPage('announcements')">📣 Send Announcement</button>
            <button class="btn btn-outline" onclick="goPage('messages')">💬 View Messages</button>
            <button class="btn btn-outline" onclick="goPage('gen-rent')">⚡ Generate Bills</button>
            <button class="btn btn-outline" onclick="goPage('tenants')">👥 Tenants &amp; Records</button>
          </div>
        </div>
      </div>
      <div id="usage-section"></div>`;
    loadUsage();
  } catch (e) { pg.innerHTML = errHtml(e); }
}

// ── Water & electricity charts (dashboard) ──
// One filter row (month/year, property) above both charts. Water = main-meter cubic meters per
// water session; electricity = amount billed (bills have no kWh), only where a property bills it.
const CHART_COLORS = { water: '#2a78d6', electricity: '#eb6834' };   // validated pair (dataviz)
let _usage = { view: 'month', property: '', data: null };
async function loadUsage() {
  const box = document.getElementById('usage-section'); if (!box) return;
  try {
    const d = await apiFetch('/landlord/usage' + (_usage.property ? '?property_id=' + parseInt(_usage.property) : ''));
    _usage.data = d;
    if (!d.any_water && !d.any_electricity) { box.innerHTML = ''; return; }
    const props = d.properties.filter(p => p.water || p.electricity);
    box.innerHTML = `
      <h2 class="section-title">📈 Water${d.any_electricity ? ' &amp; Electricity' : ''}</h2>
      <div class="filter-row">
        <div class="chip-row" role="group" aria-label="Period">
          <button class="chip ${_usage.view === 'month' ? 'active' : ''}" onclick="setUsage('view','month')">By month</button>
          <button class="chip ${_usage.view === 'year' ? 'active' : ''}" onclick="setUsage('view','year')">By year</button>
        </div>
        ${props.length > 1 ? `<select class="filter-select" aria-label="Property" onchange="setUsage('property', this.value)">
          <option value="">All properties</option>
          ${props.map(p => `<option value="${parseInt(p.id)}" ${String(p.id) === String(_usage.property) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>` : ''}
      </div>
      ${d.any_water ? `<div class="card chart-card" id="chart-water"></div>` : ''}
      ${d.any_electricity ? `<div class="card chart-card" id="chart-electricity"></div>` : ''}`;
    drawUsage();
  } catch (e) { box.innerHTML = ''; }
}
function setUsage(key, val) {
  if (_usage[key] === val) return;
  _usage[key] = val;
  if (key === 'property') { const b = document.getElementById('usage-section'); if (b) b.style.opacity = .55; loadUsage().then(() => { if (b) b.style.opacity = ''; }); }
  else loadUsage();
}
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Last 12 months up to this month (gaps stay empty), or every year with data
function usagePoints(series) {
  if (!series) return [];
  if (_usage.view === 'year') return series.years.map(y => ({ ...y, label: String(y.year) }));
  const now = new Date(); const out = [];
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const hit = series.months.find(m => m.year === dt.getFullYear() && m.month === dt.getMonth() + 1);
    out.push({ ...(hit || {}), year: dt.getFullYear(), month: dt.getMonth() + 1, empty: !hit,
      label: SHORT_MONTHS[dt.getMonth()], sub: dt.getMonth() === 0 || i === 11 ? String(dt.getFullYear()) : '' });
  }
  return out;
}
const cubic = n => `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })} cu.m`;
const peso0 = n => '₱' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
function drawUsage() {
  const d = _usage.data; if (!d) return;
  const period = _usage.view === 'year' ? 'per year' : 'last 12 months';
  const w = document.getElementById('chart-water');
  if (w) {
    const pts = usagePoints(d.water);
    const total = pts.reduce((a, p) => a + (p.cubic || 0), 0);
    usageCard(w, {
      title: '💧 Water used', subtitle: `Main meter, cubic meters · ${period}`,
      headline: d.water ? (_usage.view === 'year' ? `${cubic(pts.length ? pts[pts.length - 1].cubic : 0)} in ${pts.length ? pts[pts.length - 1].year : '—'}` : `${cubic(total)} in 12 months`) : '',
      empty: !d.water ? 'Water billing is off for this property.' : !pts.some(p => p.cubic) ? 'No water readings yet — they appear here after each water session.' : '',
      pts, key: 'cubic', color: CHART_COLORS.water, fmtVal: cubic, tick: n => compactNum(n),
      tipLines: p => [`Main bill ${'₱' + fmt(p.main_bill || 0)}`, `Billed to tenants ${'₱' + fmt(p.billed || 0)}`],
      cols: [['Used', p => cubic(p.cubic || 0)], ['Main bill', p => '₱' + fmt(p.main_bill || 0)], ['Billed to tenants', p => '₱' + fmt(p.billed || 0)]],
    });
  }
  const e = document.getElementById('chart-electricity');
  if (e) {
    const pts = usagePoints(d.electricity);
    const total = pts.reduce((a, p) => a + (p.billed || 0), 0);
    usageCard(e, {
      title: '⚡ Electricity billed', subtitle: `Amount billed to tenants · ${period}`,
      headline: d.electricity ? (_usage.view === 'year' ? `${peso0(pts.length ? pts[pts.length - 1].billed : 0)} in ${pts.length ? pts[pts.length - 1].year : '—'}` : `${peso0(total)} in 12 months`) : '',
      empty: !d.electricity ? 'Electricity billing is off for this property.' : !pts.some(p => p.billed) ? 'No electricity bills yet.' : '',
      pts, key: 'billed', color: CHART_COLORS.electricity, fmtVal: n => '₱' + fmt(n), tick: n => '₱' + compactNum(n),
      tipLines: p => [`${p.bills || 0} bill${p.bills === 1 ? '' : 's'}`],
      cols: [['Billed', p => '₱' + fmt(p.billed || 0)], ['Bills', p => String(p.bills || 0)]],
    });
  }
}
function compactNum(n) {
  if (n >= 1e6) return +(n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return +(n / 1e3).toFixed(1) + 'K';
  return String(+n.toFixed(1));
}
function niceStep(max, count) {
  const raw = max / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}
function usageCard(el, o) {
  el.innerHTML = `<div class="chart-head"><div><h3>${o.title}</h3><div class="muted-text small">${esc(o.subtitle)}</div></div>
      ${o.headline && !o.empty ? `<div class="chart-headline">${esc(o.headline)}</div>` : ''}</div>
    ${o.empty ? `<p class="muted-text" style="padding:18px 0">${esc(o.empty)}</p>` : `<div class="chart-wrap"></div>
    <details class="chart-table"><summary>Show as table</summary><div class="table-wrap"><table>
      <thead><tr><th>${_usage.view === 'year' ? 'Year' : 'Month'}</th>${o.cols.map(c => `<th>${esc(c[0])}</th>`).join('')}</tr></thead>
      <tbody>${o.pts.filter(p => !p.empty).slice().reverse().map(p => `<tr><td>${esc(_usage.view === 'year' ? p.label : SHORT_MONTHS[p.month - 1] + ' ' + p.year)}</td>${o.cols.map(c => `<td>${esc(c[1](p))}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div></details>`}`;
  if (!o.empty) columnChart(el.querySelector('.chart-wrap'), o);
}
// Single-series column chart: <=24px columns with 4px rounded tops on one baseline, hairline grid,
// value labels only on the latest and the highest column, a tooltip per column (hover + keyboard).
function columnChart(wrap, o) {
  const pts = o.pts, W = Math.max(280, wrap.clientWidth || 320), H = 200;
  const L = 44, R = 8, T = 20, B = 34, pw = W - L - R, ph = H - T - B;
  const vals = pts.map(p => p[o.key] || 0);
  const step = niceStep(Math.max(...vals, 1), 4), top = Math.ceil(Math.max(...vals, 1) / step) * step;
  const y = v => T + ph - (v / top) * ph;
  const band = pw / pts.length, bw = Math.max(6, Math.min(24, band - 8));
  const last = pts.map((p, i) => p.empty ? -1 : i).filter(i => i >= 0).pop();
  const maxI = vals.indexOf(Math.max(...vals));
  let g = '';
  for (let t = 0; t <= top + 1e-9; t += step) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? 'ch-base' : 'ch-grid'}"/>
      <text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" class="ch-tick">${esc(o.tick(t))}</text>`;
  }
  pts.forEach((p, i) => {
    const cx = L + band * i + band / 2, v = vals[i], h = (v / top) * ph;
    if (v > 0) {
      const r = Math.min(4, h, bw / 2), x0 = cx - bw / 2, yb = T + ph, yt = yb - h;
      g += `<path class="ch-bar" data-i="${i}" fill="${o.color}" d="M${x0},${yb} V${yt + r} Q${x0},${yt} ${x0 + r},${yt} H${x0 + bw - r} Q${x0 + bw},${yt} ${x0 + bw},${yt + r} V${yb} Z"/>`;
      if (i === last || i === maxI) g += `<text x="${cx}" y="${yt - 6}" text-anchor="middle" class="ch-val">${esc(o.tick(v))}</text>`;
    }
    g += `<text x="${cx}" y="${T + ph + 15}" text-anchor="middle" class="ch-x">${esc(p.label)}</text>`;
    if (p.sub) g += `<text x="${cx}" y="${T + ph + 28}" text-anchor="middle" class="ch-x ch-sub">${esc(p.sub)}</text>`;
    g += `<rect class="ch-hit" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${ph + 16}" tabindex="0"
      aria-label="${esc((p.sub || '') + ' ' + p.label + ': ' + (p.empty ? 'no data' : o.fmtVal(v)))}"/>`;
  });
  wrap.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title.replace(/^\S+\s/, ''))} chart">${g}</svg>
    <div class="chart-tip" hidden></div>`;
  const tip = wrap.querySelector('.chart-tip');
  const show = (i, rect) => {
    const p = pts[i]; tip.replaceChildren();
    const strong = document.createElement('strong'); strong.textContent = p.empty ? 'No data' : o.fmtVal(vals[i]);
    const when = document.createElement('div'); when.className = 'muted-text';
    when.textContent = _usage.view === 'year' ? p.label : `${SHORT_MONTHS[p.month - 1]} ${p.year}`;
    tip.append(strong, when);
    const lines = p.empty ? [] : o.tipLines(p);
    if (_usage.view === 'year' && p.months) lines.push(`${p.months} month${p.months === 1 ? '' : 's'} of data`);
    lines.forEach(t => { const d = document.createElement('div'); d.textContent = t; tip.append(d); });
    tip.hidden = false;
    const wr = wrap.getBoundingClientRect(), rr = rect.getBoundingClientRect();
    let left = rr.left - wr.left + rr.width / 2 - tip.offsetWidth / 2;
    tip.style.left = Math.max(0, Math.min(left, wr.width - tip.offsetWidth)) + 'px';
    tip.style.top = Math.max(0, y(vals[i]) - tip.offsetHeight - 10) + 'px';
    wrap.querySelectorAll('.ch-bar').forEach(b => b.classList.toggle('lift', b.dataset.i === String(i)));
  };
  const hide = () => { tip.hidden = true; wrap.querySelectorAll('.ch-bar.lift').forEach(b => b.classList.remove('lift')); };
  wrap.querySelectorAll('.ch-hit').forEach(h => {
    const i = parseInt(h.dataset.i);
    h.addEventListener('pointerenter', () => show(i, h)); h.addEventListener('focus', () => show(i, h));
    h.addEventListener('pointerleave', hide); h.addEventListener('blur', hide);
  });
}
let _usageResize;
window.addEventListener('resize', () => { clearTimeout(_usageResize); _usageResize = setTimeout(() => { if (document.getElementById('usage-section')) drawUsage(); }, 200); });

// ═══════════════════════════════════════════════
// PROPERTIES
// ═══════════════════════════════════════════════
let _props = [];
let _featureDefs = null;   // [{key, label, help, default}] from /property-features
async function featureDefs() {
  if (!_featureDefs) _featureDefs = await apiFetch('/property-features');
  return _featureDefs;
}
const hasFeature = (prop, key) => !!(prop && prop.features && prop.features[key]);
// Water Billing only shows in the menu when at least one property uses it
async function refreshPropertyFeatureNav(props) {
  try {
    if (!props) props = await apiFetch('/properties');
    _props = props;
    const water = document.getElementById('nav-water');
    if (water) water.hidden = props.length > 0 && !props.some(p => hasFeature(p, 'water_billing'));
  } catch (_) { }
}
async function loadProperties() {
  const pg = document.getElementById('page-properties'); pg.innerHTML = loadingHtml;
  try {
    const [props, defs, units] = await Promise.all([apiFetch('/properties'), featureDefs(), apiFetch('/units')]);
    refreshPropertyFeatureNav(props);
    window._units = units;
    const unitsOf = pid => units.filter(u => u.property_id === pid).sort(byUnit);
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Properties (${_props.length})</h3>
      <button class="btn btn-brand" onclick="showPropertySetup()">+ Add Property</button></div>
      <p class="muted-text">Tap a property to see and add its units.</p></div>
      ${!_props.length ? '<div class="card"><div class="empty-state"><div class="icon">🏢</div><p>No properties yet</p></div></div>' :
        _props.map(p => { const us = unitsOf(p.id); return `
        <details class="card group-card prop-card" data-prop="${parseInt(p.id)}" ${_openProps.has(p.id) ? 'open' : ''}
            ontoggle="this.open ? _openProps.add(${parseInt(p.id)}) : _openProps.delete(${parseInt(p.id)})">
          <summary class="group-head">
            <span style="min-width:0"><h3>🏢 ${esc(p.name)}</h3>
              <span class="muted-text small">${esc(p.address)}${p.city ? ', ' + esc(p.city) : ''}</span>
              <div class="feature-tags">${defs.filter(f => hasFeature(p, f.key)).map(f => `<span>${esc(f.label)}</span>`).join('')}</div></span>
            <span class="row-flags"><span class="muted-text small">${esc(p.occupied || 0)}/${esc(p.unit_count || 0)} occupied</span>${chevron}</span>
          </summary>
          ${us.length ? `<div class="unit-lines">${us.map(u => `<div class="unit-line">
              <span class="row-unit">Unit ${esc(u.unit_number)}</span>
              <span class="unit-facts">${u.bedrooms != null ? esc(u.bedrooms) + ' bed · ' : ''}₱${fmt(u.rent_amount)}/mo · ${u.lease_term_months ? (u.lease_term_months % 12 ? u.lease_term_months + ' mo' : u.lease_term_months / 12 + ' yr') + ' lease' : 'open contract'}</span>
              ${badge(u.status)}<button class="btn btn-sm btn-outline" onclick="showAddUnit(${parseInt(p.id)}, ${parseInt(u.id)})">Edit</button></div>`).join('')}</div>` : '<p class="muted-text">No units yet.</p>'}
          <div class="btn-group" style="margin-top:12px">
            <button class="btn btn-sm btn-brand" onclick="showAddUnit(${parseInt(p.id)})">+ Add Unit</button>
            <button class="btn btn-sm btn-outline" onclick="showPropertySetup(${parseInt(p.id)})">⚙️ Setup</button>
            <button class="btn btn-sm btn-red" onclick="deleteProperty(${parseInt(p.id)})">Delete</button>
          </div>
        </details>`; }).join('')}`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
const _openProps = new Set();   // which properties are expanded (kept while you move around)
// Add a property, or change one's details and which features it uses
async function showPropertySetup(propId) {
  let defs;
  try { defs = await featureDefs(); } catch (e) { alert(e.message); return; }
  const p = _props.find(x => x.id === propId) || { features: Object.fromEntries(defs.map(f => [f.key, f.default])), country: 'Philippines' };
  openModal(propId ? `Setup — ${p.name}` : 'Add Property', `
    <div class="form-group"><label>Name</label><input type="text" id="m-prop-name" maxlength="255" value="${esc(p.name || '')}"/></div>
    <div class="form-group"><label>Address</label><input type="text" id="m-prop-addr" value="${esc(p.address || '')}"/></div>
    <div class="grid-2"><div class="form-group"><label>City</label><input type="text" id="m-prop-city" value="${esc(p.city || '')}"/></div>
    <div class="form-group"><label>Country</label><input type="text" id="m-prop-country" value="${esc(p.country || '')}"/></div></div>
    <h4 class="section-title">What this property uses</h4>
    <p class="hint" style="margin:-4px 0 6px">Turn off what you don't need here — it's hidden for this property and its tenants' bills.</p>
    ${defs.map(f => `<div class="pref-row"><span class="pref-label"><strong>${esc(f.label)}</strong><small class="hint">${esc(f.help)}</small></span>
      <label class="toggle"><input type="checkbox" class="m-prop-feature" data-key="${esc(f.key)}" ${hasFeature(p, f.key) ? 'checked' : ''}/><span class="toggle-slider"></span></label></div>`).join('')}
    <p class="err-msg" id="m-prop-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="savePropertySetup(${propId ? parseInt(propId) : 'null'})">${propId ? 'Save' : 'Add Property'}</button>`);
}
async function savePropertySetup(propId) {
  const v = id => document.getElementById(id).value.trim();
  const body = { name: v('m-prop-name'), address: v('m-prop-addr'), city: v('m-prop-city'), country: v('m-prop-country'), features: {} };
  document.querySelectorAll('.m-prop-feature').forEach(cb => { body.features[cb.dataset.key] = cb.checked; });
  const errEl = document.getElementById('m-prop-err'); errEl.textContent = '';
  if (!body.name || !body.address) { errEl.textContent = 'Name and address are required'; return; }
  try {
    await apiFetch(propId ? '/properties/' + propId : '/properties', { method: propId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    closeModalDirect(); loadProperties();
  } catch (e) { errEl.textContent = e.message; }
}
async function deleteProperty(id) {
  try {
    const info = await apiFetch(`/properties/${id}/delete-preview`);
    if (!await confirmAction({ title: `Delete ${info.name}?`, effects: info.effects, blocked: info.blocked, typeToConfirm: info.name })) return;
    await apiFetch('/properties/' + id, { method: 'DELETE' }); loadProperties();
  } catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// UNITS
// ═══════════════════════════════════════════════
const LEASE_OPTIONS = [['', 'Open contract (no end date)'], ['6', '6 months'], ['12', '1 year'], ['24', '2 years'], ['other', 'Other…']];
function showAddUnit(propId, unitId) {
  if (!_props.length) { alert('Add a property first.'); return; }
  const u = (window._units || []).find(x => x.id === unitId) || {};
  const term = u.lease_term_months == null ? '' : String(u.lease_term_months);
  const known = LEASE_OPTIONS.some(([v]) => v === term);
  openModal(unitId ? `Edit Unit ${u.unit_number}` : 'Add Unit', `
    <div class="form-group"><label>Property</label><select id="m-unit-prop" ${unitId ? 'disabled' : ''}>${_props.map(p => `<option value="${parseInt(p.id)}" ${p.id === (u.property_id || propId) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <div class="form-group"><label>Unit Number</label><input type="text" id="m-unit-num" maxlength="20" placeholder="101, 2A…" value="${esc(u.unit_number || '')}"/></div>
    <div class="grid-2"><div class="form-group"><label>Floor</label><input type="number" id="m-unit-floor" value="${esc(u.floor_num ?? '')}"/></div>
    <div class="form-group"><label>Bedrooms</label><input type="number" id="m-unit-beds" min="0" value="${esc(u.bedrooms ?? '')}"/></div></div>
    <div class="grid-2"><div class="form-group"><label>Bathrooms</label><input type="number" id="m-unit-baths" min="0" value="${esc(u.bathrooms ?? '')}"/></div>
    <div class="form-group"><label>Area m²</label><input type="number" id="m-unit-area" min="0" value="${esc(u.area_sqm ?? '')}"/></div></div>
    <div class="form-group"><label>Monthly Rent ₱</label><input type="number" id="m-unit-rent" min="0" step="0.01" inputmode="decimal" value="${esc(u.rent_amount ?? '')}"/></div>
    <div class="form-group"><label>Usual lease</label>
      <select id="m-unit-lease" onchange="document.getElementById('m-unit-lease-other').hidden=this.value!=='other'">
        ${LEASE_OPTIONS.map(([v, l]) => `<option value="${v}" ${(known ? term === v : v === 'other') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="number" id="m-unit-lease-other" min="1" max="120" placeholder="Months" style="margin-top:8px" value="${known ? '' : esc(term)}" ${known ? 'hidden' : ''}/>
      <small class="hint">New contracts for this unit start with this.</small></div>
    <p class="err-msg" id="m-unit-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitAddUnit(${unitId ? parseInt(unitId) : 'null'})">${unitId ? 'Save' : 'Add'}</button>`);
}
async function submitAddUnit(unitId) {
  const v = id => document.getElementById(id).value;
  const lease = v('m-unit-lease') === 'other' ? v('m-unit-lease-other') : v('m-unit-lease');
  const body = {
    property_id: v('m-unit-prop'), unit_number: v('m-unit-num').trim(),
    floor_num: v('m-unit-floor') || null, bedrooms: v('m-unit-beds') || null,
    bathrooms: v('m-unit-baths') || null, area_sqm: v('m-unit-area') || null, rent_amount: v('m-unit-rent'),
    lease_term_months: lease || null
  };
  const errEl = document.getElementById('m-unit-err'); errEl.textContent = '';
  if (!body.unit_number || !body.rent_amount) { errEl.textContent = 'Unit number and rent are required'; return; }
  try {
    if (unitId) { delete body.property_id; await apiFetch('/units/' + unitId, { method: 'PATCH', body: JSON.stringify(body) }); }
    else await apiFetch('/units', { method: 'POST', body: JSON.stringify(body) });
    closeModalDirect(); _openProps.add(parseInt(v('m-unit-prop'))); loadProperties();
  } catch (e) { errEl.textContent = e.message; }
}

// ═══════════════════════════════════════════════
// TENANTS — by property, one line per unit with its current tenant; details on tap.
// Then tenants waiting for a unit, then past tenants (records only).
// ═══════════════════════════════════════════════
const byUnit = (a, b) => String(a.unit_number).localeCompare(String(b.unit_number), undefined, { numeric: true });
const chevron = '<span class="chev" aria-hidden="true">›</span>';
let _board = null;
async function loadTenants() {
  const pg = document.getElementById('page-tenants'); pg.innerHTML = loadingHtml;
  try {
    _board = await apiFetch('/landlord/tenant-board');
    renderTenantBoard();
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function renderTenantBoard() {
  const pg = document.getElementById('page-tenants');
  const { properties, unassigned, past } = _board;
  const q = (document.getElementById('tenant-search')?.value || '').trim().toLowerCase();
  const hit = (...xs) => !q || xs.some(x => String(x || '').toLowerCase().includes(q));
  const tenantLine = (c) => `
    <details class="row-toggle">
      <summary><span class="row-main"><span class="row-unit">${esc(c._unit)}</span><span class="row-name">${esc(c.full_name)}</span></span>
        <span class="row-flags">${c.payments_to_review > 0 ? `<span class="badge badge-yellow">💳 ${parseInt(c.payments_to_review)} to review</span>` : ''}${checklistFlag(c.checklist)}${c.status === 'move_out_pending' ? '<span class="badge badge-orange">Moving out</span>' : ''}
          ${c.overdue > 0 ? `<span class="badge badge-red">${parseInt(c.overdue)} overdue</span>` : ''}${chevron}</span></summary>
      <div class="row-body">
        <div class="field-grid">
          ${field('Contact', `${esc(c.email)}${c.phone ? '<br>' + esc(c.phone) : ''}`)}
          ${field('Rent', '₱' + fmt(c.monthly_rent) + '/mo')}
          ${field('Term', c.is_open_term ? 'Open term' : `${fmtDate(c.start_date)} → ${fmtDate(c.end_date)}`)}
          ${field('Unpaid', '₱' + fmt(c.unpaid))}
          ${field('Contract', c.contract_doc_url ? (c.tenant_ack ? 'Signed copy · acknowledged' : 'Signed copy · not yet acknowledged') : 'No document uploaded')}
        </div>
        <div class="btn-group" style="margin-top:12px">
          <button class="btn btn-sm btn-brand" onclick="openTenantProfile(${parseInt(c.tenant_id)})">👤 Profile &amp; history</button>
          <button class="btn btn-sm btn-outline" onclick="showNewThread(${parseInt(c.user_id)})">💬 Message</button>
        </div>
      </div>
    </details>`;
  const propHtml = properties.map(p => {
    const units = [...p.units].sort(byUnit);
    const lines = units.flatMap(u => u.contracts.length
      ? u.contracts.map(c => ({ ...c, _unit: 'Unit ' + u.unit_number }))
      : [{ _vacant: true, _unit: 'Unit ' + u.unit_number }]);
    const shown = lines.filter(l => l._vacant ? !q : hit(l.full_name, l._unit, l.email, l.phone));
    if (q && !shown.length) return '';
    const occupied = units.filter(u => u.contracts.length).length;
    return `<div class="card group-card">
      <div class="group-head"><h3>🏢 ${esc(p.name)}</h3><span class="muted-text">${occupied}/${units.length} occupied</span></div>
      ${!units.length ? '<p class="muted-text">No units yet.</p>' : shown.map(l => l._vacant
        ? `<div class="row-static"><span class="row-main"><span class="row-unit">${esc(l._unit)}</span><span class="row-name muted-text">Vacant</span></span></div>`
        : tenantLine(l)).join('')}
    </div>`;
  }).join('');
  const waiting = unassigned.filter(t => hit(t.full_name, t.email, t.phone));
  const gone = past.filter(t => hit(t.full_name, t.email, t.units));
  pg.innerHTML = `
    <div class="card"><div class="card-header"><h3>Tenants</h3>
      <button class="btn btn-brand" onclick="showLandlordInvite()">👋 Invite Tenants</button></div>
      <input type="search" id="tenant-search" class="search-input" placeholder="Search name, unit, email or phone"
        value="${esc(q)}" oninput="renderTenantBoard()"/></div>
    ${propHtml || (!q ? '<div class="card"><div class="empty-state"><div class="icon">🏢</div><p>Add a property and units first.</p></div></div>' : '')}
    ${waiting.length ? `<div class="card group-card">
      <div class="group-head"><h3>🕓 Joined — waiting for a unit</h3><span class="muted-text">${waiting.length}</span></div>
      ${waiting.map(t => `<details class="row-toggle">
        <summary><span class="row-main"><span class="row-name">${esc(t.full_name)}</span></span><span class="row-flags">${checklistFlag(t.checklist)}${chevron}</span></summary>
        <div class="row-body">
          <div class="field-grid">${field('Contact', `${esc(t.email)}${t.phone ? '<br>' + esc(t.phone) : ''}`)}${field('Joined', fmtDate(t.joined_at))}</div>
          <div class="btn-group" style="margin-top:12px">
            <button class="btn btn-sm btn-brand" onclick="showCreateContract(${parseInt(t.tenant_id)})">+ Give a Unit (Contract)</button>
            <button class="btn btn-sm btn-outline" onclick="showNewThread(${parseInt(t.user_id)})">💬 Message</button>
            <button class="btn btn-sm btn-outline" onclick="openTenantProfile(${parseInt(t.tenant_id)})">👤 Profile</button>
            <button class="btn btn-sm btn-outline" onclick="archiveTenant(${parseInt(t.tenant_id)})">Move to Past Tenants</button>
          </div></div></details>`).join('')}
    </div>` : ''}
    ${past.length ? `<details class="card group-card past-group">
      <summary class="group-head"><h3>🗂️ Past tenants</h3><span class="muted-text">${gone.length} ${chevron}</span></summary>
      <p class="hint" style="margin-bottom:8px">Moved out. Their contracts, bills, payments and messages are kept as records; they can't be messaged.</p>
      ${gone.map(t => `<details class="row-toggle">
        <summary><span class="row-main"><span class="row-name">${esc(t.full_name)}</span><span class="row-unit muted-text">${esc(t.units || '')}</span></span>
          <span class="row-flags"><span class="muted-text small">${t.moved_out ? 'Left ' + fmtDate(t.moved_out) : t.left_at ? 'Left ' + fmtDate(t.left_at) : ''}</span>${chevron}</span></summary>
        <div class="row-body">
          <div class="field-grid">${field('Contact', `${esc(t.email)}${t.phone ? '<br>' + esc(t.phone) : ''}`)}${field('Joined', fmtDate(t.joined_at))}${field('Moved out', fmtDate(t.moved_out || t.left_at))}</div>
          <button class="btn btn-sm btn-outline" style="margin-top:12px" onclick="openTenantProfile(${parseInt(t.tenant_id)})">🗂️ View records</button>
        </div></details>`).join('')}
    </details>` : ''}`;
  const s = document.getElementById('tenant-search');
  if (q && s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}
// "✓ 3/7" move-in checklist progress, plus how many items wait for the landlord's review
function checklistFlag(cl) {
  if (!cl || !cl.total) return '';
  const done = cl.done >= cl.total;
  return `${cl.to_review ? `<span class="badge badge-yellow">${cl.to_review} to review</span>` : ''}
    <span class="badge ${done ? 'badge-green' : 'badge-gray'}" title="Move-in checklist">✓ ${cl.done}/${cl.total}</span>`;
}
async function archiveTenant(tpId) {
  if (!await confirmAction({ title: 'Move to Past Tenants?', message: 'Their records stay; they can no longer be messaged. They can rejoin with your code.', okText: 'Move to Past Tenants' })) return;
  try { await apiFetch(`/landlord/tenants/${tpId}/archive`, { method: 'POST' }); loadTenants(); }
  catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// TENANT PROFILE (CRM) — everything about one tenant, in collapsible, sortable sections
// ═══════════════════════════════════════════════
let _profile = null;   // { data, sort: {section: 'desc'|'asc'}, billType }
function openTenantProfile(tpId) { showView('tenants', () => loadTenantProfile(tpId), 'tenant/' + tpId); }
async function loadTenantProfile(tpId) {
  const pg = document.getElementById('page-tenants'); pg.innerHTML = loadingHtml;
  try {
    const [data, checklist] = await Promise.all([apiFetch(`/landlord/tenants/${tpId}/profile`),
      apiFetch(`/landlord/tenants/${tpId}/checklist`).catch(() => null)]);
    data.checklist = checklist;
    _profile = { data, sort: { contracts: 'desc', bills: 'desc', payments: 'desc', water: 'desc', threads: 'desc', files: 'desc' }, billType: 'all', fileKind: 'all' };
    renderTenantProfile();
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function sortedBy(list, key, dir) {
  const v = x => { const d = x[key]; const t = d ? new Date(d).getTime() : 0; return isNaN(t) ? 0 : t; };
  return [...list].sort((a, b) => dir === 'asc' ? v(a) - v(b) : v(b) - v(a));
}
function sortControl(section) {
  const dir = _profile.sort[section];
  return `<button class="btn btn-sm btn-outline sort-btn" onclick="event.preventDefault();toggleProfileSort('${section}')">
    ${dir === 'desc' ? '↓ Newest first' : '↑ Oldest first'}</button>`;
}
function toggleProfileSort(section) {
  _profile.sort[section] = _profile.sort[section] === 'desc' ? 'asc' : 'desc';
  document.getElementById('ps-' + section).innerHTML = profileSection(section);
}
async function deleteBill(id) {
  const b = _profile.data.bills.find(x => x.id === id); if (!b) return;
  const effects = ['The tenant gets a notification that it was removed.'];
  if (b.bill_type === 'water') effects.unshift('Its water reading goes back to the water session, which reopens so you can fix the reading and generate the bill again.');
  if (b.payment_status === 'pending') {
    await confirmAction({ title: "This bill can't be deleted yet", blocked: 'A payment for it is waiting for your review. Reject the payment first, then delete the bill.' });
    return;
  }
  if (!await confirmAction({ title: 'Delete this bill?', okText: 'Delete bill', effects,
      message: `${b.description} — ₱${fmt(b.amount)}, due ${fmtDate(b.due_date)}. Use this for a bill made by mistake.` })) return;
  try { await apiFetch('/bills/' + id, { method: 'DELETE' }); refreshView(); }
  catch (e) { alert(e.message); }
}
function setBillType(t) { _profile.billType = t; document.getElementById('ps-bills').innerHTML = profileSection('bills'); }
const step = (label, d, done) => `<span class="tl-step ${done ? 'done' : ''}">${label}${d ? ' · ' + fmtDate(d) : ''}</span>`;
function profileSection(section) {
  const { data, sort } = _profile;
  if (section === 'checklist') return checklistReviewHtml();
  if (section === 'contracts') {
    const list = sortedBy(data.contracts, 'start_date', sort.contracts);
    _contracts = list.map(c => ({ ...c, tenant_name: data.tenant.full_name, tenant_id: data.tenant.tenant_id }));
    return list.length ? _contracts.map(c => contractCard(c, true)).join('') : '<p class="muted-text">No contracts.</p>';
  }
  if (section === 'files') return filesSectionHtml();
  if (section === 'bills') {
    const types = ['all', 'rent', 'water', 'electricity', 'other'];
    const list = sortedBy(data.bills.filter(b => _profile.billType === 'all' || b.bill_type === _profile.billType), 'due_date', sort.bills);
    return `${data.tenant.is_active ? `<button class="btn btn-sm btn-brand" style="margin-bottom:8px" onclick="showCreateBill(${parseInt(data.tenant.tenant_id)})">+ Add Bill</button>` : ''}
      <div class="chip-row">${types.map(t => `<button class="chip ${_profile.billType === t ? 'active' : ''}" onclick="setBillType('${t}')">${t === 'all' ? 'All' : t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      ${list.length ? list.map(b => {
        const approved = b.payment_status === 'approved';
        return `<div class="record">
          <div class="record-top"><strong>${esc(b.description)}</strong><span class="btn-group">${badge(b.bill_type)}${badge(b.status)}</span></div>
          <div class="record-meta">₱${fmt(b.amount)} · due ${fmtDate(b.due_date)} · ${esc(b.property_name)} Unit ${esc(b.unit_number)}</div>
          <div class="timeline">${step('Issued', b.created_at, true)}${step('Paid', b.paid_at, !!b.paid_at)}${step('Approved', approved ? b.reviewed_at : null, approved)}${step('Receipt sent', b.receipt_sent_at, !!b.receipt_sent_at)}</div>
          <div class="btn-group" style="margin-top:6px">
            <button class="btn btn-sm btn-outline" onclick="openPdf('/api/bills/${parseInt(b.id)}/pdf')">🧾 Statement PDF</button>
            ${approved ? `<button class="btn btn-sm btn-outline" onclick="openPdf('/api/payments/${parseInt(b.payment_id)}/receipt.pdf')">✅ Receipt ${esc(b.receipt_no || '')}</button>` : ''}
            ${b.status !== 'paid' && !approved ? `<button class="btn btn-sm btn-red" onclick="deleteBill(${parseInt(b.id)})">🗑 Delete</button>` : ''}
          </div></div>`; }).join('') : '<p class="muted-text">No bills of this type.</p>'}`;
  }
  if (section === 'payments') {
    const list = sortedBy(data.payments, 'paid_at', sort.payments);
    return list.length ? list.map(p => p.status === 'pending' && data.tenant.is_active ? reviewRecord(p, false) : `<div class="record">
        <div class="record-top"><strong>₱${fmt(p.amount_paid)}</strong>${badge(p.status)}</div>
        <div class="record-meta">For ${forBill(p)} · submitted ${fmtDateTime(p.paid_at)}
          ${p.reviewed_at ? ` · ${esc(p.status)} ${fmtDateTime(p.reviewed_at)}${p.reviewed_by_name ? ' by ' + esc(p.reviewed_by_name) : ''}` : ''}
          ${p.receipt_no ? ` · receipt ${esc(p.receipt_no)}${p.receipt_sent_at ? ' sent ' + fmtDateTime(p.receipt_sent_at) : ''}` : ''}
          ${p.notes ? `<br>Note: ${esc(p.notes)}` : ''}</div>
        <div class="btn-group" style="margin-top:6px">
          ${p.proof_url ? `<button class="btn btn-sm btn-outline" onclick="openDoc(${jsArg(p.proof_url)})">📎 Proof</button>` : ''}
          ${p.status === 'approved' ? `<button class="btn btn-sm btn-outline" onclick="openPdf('/api/payments/${parseInt(p.id)}/receipt.pdf')">✅ Receipt</button>
            <button class="btn btn-sm btn-outline" onclick="resendReceipt(${parseInt(p.id)})">✉️ Resend receipt</button>` : ''}
        </div></div>`).join('') : '<p class="muted-text">No payments yet.</p>';
  }
  if (section === 'water') {
    const list = [...data.water].sort((a, b) => {
      const d = (a.session_year * 12 + a.session_month) - (b.session_year * 12 + b.session_month);
      return sort.water === 'asc' ? d : -d;
    });
    return list.length ? `<div class="table-wrap"><table><thead><tr><th>Month</th><th>Unit</th><th>Previous</th><th>Current</th><th>Used</th><th>Amount</th><th>Status</th></tr></thead><tbody>
      ${list.map(w => `<tr><td>${MONTHS[w.session_month - 1]} ${esc(w.session_year)}</td><td>${esc(w.unit_number)}</td>
        <td>${fmt(w.prev_reading)}</td><td>${fmt(w.curr_reading)}</td><td>${fmt(w.consumption)} cu</td><td>₱${fmt(w.total_amount)}</td><td>${badge(w.bill_status)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted-text">No water readings.</p>';
  }
  if (section === 'threads') {
    const list = sortedBy(data.threads, 'last_reply_at', sort.threads);
    return list.length ? list.map(t => `<div class="record clickable" onclick="openThread(${parseInt(t.id)})">
        <div class="record-top"><strong>${esc(t.subject)}</strong><span class="muted-text small">${fmtDate(t.last_reply_at)}</span></div></div>`).join('')
      : '<p class="muted-text">No conversations.</p>';
  }
  return '';
}
function renderTenantProfile() {
  const { data } = _profile; const t = data.tenant; const s = data.summary;
  const current = !!t.is_active;
  const live = data.contracts.filter(c => c.status === 'active' || c.status === 'move_out_pending');
  const leaving = live.filter(c => c.status === 'move_out_pending');
  const sec = (key, title, count, open, noSort) => `<details class="card profile-section" ${open ? 'open' : ''}>
      <summary class="group-head"><h3>${title} <span class="muted-text">(${count})</span></h3><span class="row-flags">${noSort ? '' : sortControl(key)}${chevron}</span></summary>
      <div id="ps-${key}">${profileSection(key)}</div></details>`;
  const rentLine = c => `<div class="rent-line">
      <span>🏠 <strong>${esc(c.property_name)} — Unit ${esc(c.unit_number)}</strong>
        <small class="muted-text">since ${fmtDate(c.move_in_date || c.start_date)} · ₱${fmt(c.monthly_rent)}/mo · ${c.is_open_term ? 'open contract' : 'until ' + fmtDate(c.end_date)}</small></span>
      ${c.status === 'active' && current ? `<button class="btn btn-sm btn-red" onclick="showMoveOut(${parseInt(c.id)})">Move Out</button>` : badge(c.status)}
    </div>`;
  document.getElementById('page-tenants').innerHTML = `
    <div class="card profile-card">
      <div class="profile-head">
        <div class="thread-avatar big">${esc((t.full_name || '?')[0].toUpperCase())}</div>
        <div style="min-width:0;flex:1"><h2 class="profile-name">${esc(t.full_name)}</h2>
          <div class="muted-text">${esc(t.email)}${t.phone ? ' · ' + esc(t.phone) : ''}</div>
          <div class="btn-group" style="margin-top:6px">${current ? '<span class="badge badge-green">Current tenant</span>' : '<span class="badge badge-gray">Past tenant</span>'}
            <span class="muted-text small">Joined ${fmtDate(t.joined_at)}${t.left_at ? ' · left ' + fmtDate(t.left_at) : ''}</span></div></div>
      </div>
      ${live.length ? `<div class="rent-lines">${live.map(rentLine).join('')}</div>` : current ? '<p class="muted-text" style="margin-top:12px">No unit yet.</p>' : ''}
      ${current ? `<div class="btn-group" style="margin-top:12px">
          <button class="btn btn-sm btn-brand" onclick="showNewThread(${parseInt(t.user_id)})">💬 Message</button>
          <button class="btn btn-sm btn-outline" onclick="showCreateContract(${parseInt(t.tenant_id)})">+ New Contract</button></div>`
        : '<div class="info-box">Records only — this tenant has moved out and can\'t be messaged.</div>'}
      ${leaving.map(c => `<div class="leaving-facts">
          <div><span class="field-label">30-day notice</span>
            <strong>${c.notice_given_at ? '✓ Received ' + fmtDate(c.notice_given_at) : '✗ Not received yet'}</strong></div>
          <div><span class="field-label">Last day${leaving.length > 1 ? ' · Unit ' + esc(c.unit_number) : ''}</span>
            <strong>${fmtDate(c.move_out_date)}${daysLeft(c.move_out_date)}</strong></div>
        </div>`).join('')}
    </div>
    ${leaving.map(c => `<div class="card moveout-card" id="mo-card-${parseInt(c.id)}">${loadingHtml}</div>`).join('')}
    <div class="stats-grid">
      <div class="stat-card"><div class="value">₱${fmt(s.total_paid)}</div><div class="label">Total Paid</div></div>
      <div class="stat-card"><div class="value">₱${fmt(s.unpaid)}</div><div class="label">Unpaid</div></div>
      <div class="stat-card"><div class="value">${s.on_time_rate === null ? '—' : s.on_time_rate + '%'}</div><div class="label">Paid on Time</div></div>
      <div class="stat-card"><div class="value">${parseInt(s.overdue_bills)}</div><div class="label">Overdue Bills</div></div>
    </div>
    ${sec('bills', '💰 Bills', data.bills.length, true)}
    ${sec('payments', '💳 Payments', data.payments.length, data.payments.some(p => p.status === 'pending'))}
    ${sec('contracts', '📋 Contracts', data.contracts.length, false)}
    ${sec('files', '🗂️ Files', tenantFiles(data).length, false)}
    ${sec('water', '💧 Water readings', data.water.length, false)}
    ${sec('threads', '💬 Conversations', data.threads.length, false)}
    ${data.checklist ? sec('checklist', '✅ Move-in checklist', `${data.checklist.done}/${data.checklist.total}`, false, true) : ''}`;
  leaving.forEach(c => loadMoveOutCard(c.id));
}
const daysLeft = d => {
  if (!d) return '';
  const n = Math.round((new Date(String(d).replace(/ 00:00:00 GMT$/, '') + (String(d).length <= 10 ? 'T00:00:00' : '')) - new Date(new Date().toDateString())) / 86400000);
  return isNaN(n) ? '' : n > 0 ? ` <span class="muted-text small">(${n} day${n === 1 ? '' : 's'} left)</span>` : n === 0 ? ' <span class="badge badge-orange">today</span>' : '';
};
const isoDate = d => {
  if (!d) return '';
  const x = new Date(d);
  return isNaN(x) ? '' : x.toISOString().slice(0, 10);
};

// ═══════════════════════════════════════════════
// MOVE-OUT CARD (top of the tenant's profile while they're moving out):
// notice + last day, the move-out checklist, the deposit and its acknowledgement
// ═══════════════════════════════════════════════
const _moveOut = {};
async function loadMoveOutCard(cid) {
  const el = document.getElementById('mo-card-' + cid); if (!el) return;
  try { _moveOut[cid] = await apiFetch(`/contracts/${cid}/move-out`); el.innerHTML = moveOutCardHtml(cid); }
  catch (e) { el.innerHTML = errHtml(e); }
}
function moveOutCardHtml(cid) {
  const { contract: c, checklist: m, items, deposit } = _moveOut[cid];
  const id = parseInt(cid);
  const need = items.filter(i => i.required), done = need.filter(i => i.done).length;
  const returned = m.refund_amount ?? deposit.to_return;
  const methods = ['Cash', 'GCash', 'Maya', 'Bank transfer', 'Check'];
  return `
    <div class="card-header"><h3>🚚 Moving out — ${esc(c.property_name)} Unit ${esc(c.unit_number)}</h3>
      <span class="badge badge-orange">Last day ${fmtDate(c.move_out_date)}</span></div>

    <h4 class="section-title">Notice &amp; last day</h4>
    <div class="grid-2">
      <div class="form-group check-box"><label><input type="checkbox" id="mo-notice-${id}" ${c.notice_given_at ? 'checked' : ''}
          onchange="document.getElementById('mo-notice-date-${id}').disabled=!this.checked"/> <span>30-day notice received</span></label>
        <input type="date" id="mo-notice-date-${id}" style="margin-top:8px" value="${esc(isoDate(c.notice_given_at))}" ${c.notice_given_at ? '' : 'disabled'}/></div>
      <div class="form-group"><label>Last day</label><input type="date" id="mo-last-${id}" value="${esc(isoDate(c.move_out_date))}"/></div>
    </div>
    <button class="btn btn-sm btn-brand" onclick="saveMoveOutDates(${id})">Save</button>

    <h4 class="section-title">Move-out checklist</h4>
    ${progressBar(done, need.length)}
    <div class="offb-list">${items.map(i => `<div class="offb-item">
        <label class="offb-tick"><input type="checkbox" ${i.done ? 'checked' : ''} onchange="tickOffboarding(${id},${parseInt(i.id)},this.checked)"/>
          <span>${esc(i.label)}${i.required ? '' : ' <span class="muted-text small">(optional)</span>'}
            ${i.done && i.done_at ? `<small class="muted-text">done ${fmtDate(i.done_at)}</small>` : ''}</span></label>
        <span class="btn-group">
          ${i.file_url ? `<button class="btn btn-sm btn-outline" onclick="openDoc(${jsArg(i.file_url)})">📄</button>` : ''}
          <button class="btn btn-sm btn-outline" title="Add a photo or file" onclick="offboardingPhoto(${id},${parseInt(i.id)},this)">📎</button></span>
      </div>`).join('')}</div>

    <h4 class="section-title">Security deposit</h4>
    <div class="deposit-sum">
      <div><span class="field-label">Held</span><strong>₱${fmt(deposit.held)}</strong></div>
      <div><span class="field-label">Deductions</span><strong>₱${fmt(deposit.deducted)}</strong></div>
      <div><span class="field-label">To return</span><strong>₱${fmt(deposit.to_return)}</strong></div>
    </div>
    <div class="grid-2">
      <div class="form-group"><label>Deductions ₱</label><input type="number" id="mo-ded-${id}" min="0" step="0.01" inputmode="decimal" value="${esc(m.deposit_consumed_amount || 0)}"/></div>
      <div class="form-group"><label>Reason for deductions</label><input type="text" id="mo-reason-${id}" maxlength="500" value="${esc(m.repair_notes || '')}" placeholder="e.g. Broken screen, unpaid water bill"/></div>
    </div>
    <div class="btn-group" style="margin-bottom:12px">
      ${m.repair_proof_url ? `<button class="btn btn-sm btn-outline" onclick="openDoc(${jsArg(m.repair_proof_url)})">📄 Repair receipts/photos</button>` : ''}
      <button class="btn btn-sm btn-outline" onclick="moveOutUpload(${id},'repair_proof','repair_proof_url',this)">📎 ${m.repair_proof_url ? 'Replace' : 'Add'} repair receipts/photos</button></div>
    <div class="grid-2">
      <div class="form-group"><label>Deposit returned (surrendered) on</label><input type="date" id="mo-ref-date-${id}" value="${esc(isoDate(m.refunded_at))}"/></div>
      <div class="form-group"><label>Paid by</label><select id="mo-ref-method-${id}"><option value="">—</option>
        ${methods.map(x => `<option ${m.refund_method === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    </div>
    <div class="form-group"><label>Amount returned ₱</label><input type="number" id="mo-ref-amt-${id}" min="0" step="0.01" inputmode="decimal" value="${esc(returned)}"/></div>
    <button class="btn btn-sm btn-brand" onclick="saveDeposit(${id})">Save deposit</button>

    <h4 class="section-title">Acknowledgement of deposit received</h4>
    <p class="hint">Print the form, have the tenant sign it when they get their deposit, then upload the signed copy.</p>
    <div class="btn-group" style="margin-top:8px">
      <button class="btn btn-sm btn-outline" onclick="openPdf('/api/contracts/${id}/deposit-ack.pdf')">🖨️ Print form</button>
      <button class="btn btn-sm btn-outline" onclick="moveOutUpload(${id},'deposit_ack','ack_url',this)">📎 ${m.ack_url ? 'Replace' : 'Upload'} signed copy</button>
      ${m.ack_url ? `<button class="btn btn-sm btn-green" onclick="openDoc(${jsArg(m.ack_url)})">✓ View signed acknowledgement</button>` : ''}
    </div>

    <div class="moveout-done">
      ${done < need.length ? `<p class="warn-box">${need.length - done} required checklist item${need.length - done === 1 ? '' : 's'} not done yet.</p>` : ''}
      <button class="btn btn-green" onclick="completeMoveOut(${id})">✅ Complete Move-Out</button>
    </div>`;
}
async function saveMoveOutDates(cid) {
  const noticed = document.getElementById('mo-notice-' + cid).checked;
  const body = { move_out_date: document.getElementById('mo-last-' + cid).value,
    notice_given_at: noticed ? (document.getElementById('mo-notice-date-' + cid).value || new Date().toISOString().slice(0, 10)) : null };
  try { await apiFetch(`/contracts/${cid}/move-out`, { method: 'PATCH', body: JSON.stringify(body) }); refreshView(); }
  catch (e) { alert(e.message); }
}
async function tickOffboarding(cid, rid, done) {
  try { await apiFetch(`/contracts/${cid}/offboarding/${rid}`, { method: 'PATCH', body: JSON.stringify({ done }) }); loadMoveOutCard(cid); }
  catch (e) { alert(e.message); loadMoveOutCard(cid); }
}
async function offboardingPhoto(cid, rid, btn) {
  try {
    const up = await uploadFile('offboarding_photo', UPLOAD_ACCEPT, btn);
    if (!up) return;
    await apiFetch(`/contracts/${cid}/offboarding/${rid}`, { method: 'PATCH', body: JSON.stringify({ done: true, file_url: up.url }) });
    loadMoveOutCard(cid);
  } catch (e) { alert(e.message); }
}
async function moveOutUpload(cid, kind, field, btn) {
  try {
    const up = await uploadFile(kind, UPLOAD_ACCEPT, btn);
    if (!up) return;
    await apiFetch(`/contracts/${cid}/move-out`, { method: 'PATCH', body: JSON.stringify({ [field]: up.url }) });
    loadMoveOutCard(cid);
  } catch (e) { alert(e.message); }
}
async function saveDeposit(cid) {
  const v = k => document.getElementById(k + cid).value;
  const body = { deposit_consumed_amount: v('mo-ded-') || 0, repair_notes: v('mo-reason-'),
    refunded_at: v('mo-ref-date-') || null, refund_method: v('mo-ref-method-') || null, refund_amount: v('mo-ref-amt-') || null };
  try { await apiFetch(`/contracts/${cid}/move-out`, { method: 'PATCH', body: JSON.stringify(body) }); loadMoveOutCard(cid); }
  catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// CONTRACTS — by property and unit: the current contract, with the unit's history under it
// ═══════════════════════════════════════════════
let _contracts = [];
function contractCard(c, onProfile) {
  const id = parseInt(c.id);
  return `<div class="record">
    <div class="record-top">${onProfile ? `<strong>${esc(c.property_name)} — Unit ${esc(c.unit_number)}</strong>`
      : `<strong class="link" onclick="openTenantProfile(${parseInt(c.tenant_id)})">${esc(c.tenant_name)}</strong>`}${badge(c.status)}</div>
    <div class="record-meta">${c.is_open_term ? 'Open term from ' + fmtDate(c.start_date) : fmtDate(c.start_date) + ' → ' + fmtDate(c.end_date)}
      ${c.minimum_months ? ` · min ${esc(c.minimum_months)} mo` : ''} · ₱${fmt(c.monthly_rent)}/mo
      ${c.contract_doc_url ? ` · signed copy ${c.tenant_ack ? '(acknowledged)' : '(awaiting acknowledgement)'}` : ''}</div>
    <div class="btn-group" style="margin-top:6px">
      ${c.contract_doc_url ? `<button class="btn btn-sm btn-outline" onclick="openDoc(${jsArg(c.contract_doc_url)})">📄 View</button>` : ''}
      ${c.status === 'active' ? `
        <button class="btn btn-sm btn-outline" onclick="uploadContractDoc(${id})">📤 ${c.contract_doc_url ? 'Re-upload' : 'Upload signed copy'}</button>
        <button class="btn btn-sm btn-warn" onclick="showExtendContract(${id})">Extend</button>
` : ''}
      ${c.status === 'move_out_pending' ? `<span class="muted-text small">Moving out — see the card at the top.</span>` : ''}
    </div></div>`;
}

async function showCreateContract(tenantId) {
  let units, tenants;
  try { [units, tenants] = await Promise.all([apiFetch('/units'), apiFetch('/landlord/tenants')]); }
  catch (e) { alert(e.message); return; }
  const vacantUnits = units.filter(u => u.status === 'vacant');
  if (!vacantUnits.length) { alert('There are no vacant units. Add a unit or end a contract first.'); return; }
  if (!tenants.length) { alert('No tenants yet. Invite tenants with your join code first.'); return; }
  openModal('Create Contract', `
    <div class="form-group"><label>Tenant</label><select id="m-c-tenant"><option value="">— Select —</option>
      ${tenants.map(t => `<option value="${parseInt(t.id)}" ${t.id === tenantId ? 'selected' : ''}>${esc(t.full_name)} (${esc(t.email)})</option>`).join('')}</select></div>
    <div class="form-group"><label>Unit (vacant)</label><select id="m-c-unit" onchange="contractUnitPicked()"><option value="">— Select —</option>
      ${vacantUnits.map(u => `<option value="${parseInt(u.id)}" data-rent="${esc(u.rent_amount)}" data-lease="${esc(u.lease_term_months ?? '')}">${esc(u.property_name)} — Unit ${esc(u.unit_number)} (₱${fmt(u.rent_amount)}/mo)</option>`).join('')}</select></div>
    <div class="grid-2">
      <div class="form-group"><label>Contract Signed Date</label><input type="date" id="m-c-signed"/></div>
      <div class="form-group"><label>Lease Start Date</label><input type="date" id="m-c-start" onchange="applyLeaseTerm()"/></div>
    </div>
    <div class="form-group"><label>Move-In Date <span class="muted-text">(optional)</span></label><input type="date" id="m-c-movein"/></div>
    <div class="form-group check-box">
      <label><input type="checkbox" id="m-c-open" onchange="document.getElementById('m-c-fixed-fields').style.display=this.checked?'none':''"/>
        <span>Open Term (no fixed end date)</span></label>
    </div>
    <div id="m-c-fixed-fields">
      <div class="form-group"><label>End Date</label><input type="date" id="m-c-end"/></div>
      <div class="form-group"><label>Minimum Term (months)</label><input type="number" id="m-c-minmonths" min="1" max="36" placeholder="Leave blank if none"/></div>
    </div>
    <div class="grid-2">
      <div class="form-group"><label>Monthly Rent ₱</label><input type="number" id="m-c-rent" min="0" step="0.01" inputmode="decimal"/></div>
      <div class="form-group"><label>Deposit ₱</label><input type="number" id="m-c-dep" value="0" min="0" step="0.01" inputmode="decimal"/></div>
    </div>
    <p class="err-msg" id="m-c-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitCreateContract()">Create</button>`);
}
function contractUnitPicked() {
  const opt = document.getElementById('m-c-unit').selectedOptions[0];
  const rent = document.getElementById('m-c-rent');
  if (opt && opt.dataset.rent && !rent.value) rent.value = parseFloat(opt.dataset.rent);
  applyLeaseTerm();
}
// The unit's usual lease: open contract, or N months from the start date
function applyLeaseTerm() {
  const opt = document.getElementById('m-c-unit').selectedOptions[0];
  if (!opt || !opt.value) return;
  const months = parseInt(opt.dataset.lease);
  const open = document.getElementById('m-c-open');
  open.checked = !months;
  document.getElementById('m-c-fixed-fields').style.display = open.checked ? 'none' : '';
  const start = document.getElementById('m-c-start').value;
  if (months && start) {
    const d = new Date(start + 'T00:00:00'); d.setMonth(d.getMonth() + months); d.setDate(d.getDate() - 1);
    document.getElementById('m-c-end').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
async function submitCreateContract() {
  const v = id => document.getElementById(id).value;
  const is_open_term = document.getElementById('m-c-open').checked;
  const body = {
    unit_id: v('m-c-unit'), tenant_id: v('m-c-tenant'),
    contract_signed_date: v('m-c-signed') || null, start_date: v('m-c-start'), move_in_date: v('m-c-movein') || null,
    end_date: is_open_term ? null : v('m-c-end'), monthly_rent: v('m-c-rent'), deposit: v('m-c-dep') || 0,
    is_open_term, minimum_months: is_open_term ? null : (v('m-c-minmonths') || null)
  };
  const errEl = document.getElementById('m-c-err'); errEl.textContent = '';
  if (!body.unit_id || !body.tenant_id || !body.start_date || !body.monthly_rent) { errEl.textContent = 'Tenant, unit, start date and rent are required'; return; }
  if (!is_open_term && !body.end_date) { errEl.textContent = 'End date required for a fixed term'; return; }
  try { await apiFetch('/contracts', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); refreshView(); }
  catch (e) { errEl.textContent = e.message; }
}
async function uploadContractDoc(contractId) {
  try {
    const result = await uploadFile('contract', 'application/pdf,image/jpeg,image/png');
    if (!result) return;
    await apiFetch('/contracts/' + contractId + '/upload-doc', { method: 'POST', body: JSON.stringify({ contract_doc_url: result.url }) });
    alert('✅ Contract uploaded! Tenant has been notified.');
    refreshView();
  } catch (e) { if (e && e.message) alert('Upload failed: ' + e.message); }
}
function showMoveOut(contractId) {
  const c = _contracts.find(x => x.id === contractId) || (_profile ? _profile.data.contracts.find(x => x.id === contractId) : null) || {};
  const today = new Date(); const in30 = new Date(Date.now() + 30 * 86400000);
  const iso = d => d.toISOString().slice(0, 10);
  openModal(`Move out: ${c.property_name || ''} Unit ${c.unit_number || ''}`, `
    <div class="info-box">The tenant stays until their last day. You'll get a move-out card on their profile for the checklist and the deposit.</div>
    <div class="form-group check-box"><label><input type="checkbox" id="m-mo-notice" checked
        onchange="document.getElementById('m-mo-notice-date').disabled=!this.checked"/> <span>30-day notice received</span></label>
      <input type="date" id="m-mo-notice-date" style="margin-top:8px" value="${iso(today)}"/></div>
    <div class="form-group"><label>Last day</label><input type="date" id="m-mo-date" value="${iso(in30)}"/></div>
    <div class="form-group"><label>Notes (optional)</label><textarea id="m-mo-notes" rows="2"></textarea></div>
    <p class="err-msg" id="m-mo-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-red" onclick="submitMoveOut(${parseInt(contractId)})">Start Move-Out</button>`);
}
async function submitMoveOut(contractId) {
  const move_out_date = document.getElementById('m-mo-date').value;
  const notice_given_at = document.getElementById('m-mo-notice').checked ? document.getElementById('m-mo-notice-date').value : null;
  const notes = document.getElementById('m-mo-notes').value;
  if (!move_out_date) { document.getElementById('m-mo-err').textContent = 'Set their last day'; return; }
  try {
    await apiFetch('/contracts/' + contractId + '/terminate', { method: 'PATCH', body: JSON.stringify({ move_out_date, notice_given_at, notes }) });
    closeModalDirect(); refreshView();
  } catch (e) { document.getElementById('m-mo-err').textContent = e.message; }
}
async function completeMoveOut(contractId) {
  if (!await confirmAction({ title: 'Complete move-out?', message: 'The contract ends and the unit becomes vacant.', okText: 'Complete Move-Out' })) return;
  try {
    const d = await apiFetch('/contracts/' + contractId + '/complete-move-out', { method: 'POST', body: '{}' });
    closeModalDirect();
    alert('✅ Move-out complete. Unit is now vacant.' + (d && d.archived ? ' The tenant is now in Past Tenants — their records are kept.' : ''));
    refreshView();
  } catch (e) { alert(e.message); }
}
function showExtendContract(id) {
  openModal('Extend Contract', `<div class="form-group"><label>New End Date</label><input type="date" id="m-ext-date"/></div><p class="err-msg" id="m-ext-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button><button class="btn btn-brand" onclick="submitExtend(${parseInt(id)})">Extend</button>`);
}
async function submitExtend(id) {
  const end_date = document.getElementById('m-ext-date').value;
  if (!end_date) { document.getElementById('m-ext-err').textContent = 'Required'; return; }
  try { await apiFetch('/contracts/' + id + '/extend', { method: 'PATCH', body: JSON.stringify({ end_date }) }); closeModalDirect(); refreshView(); }
  catch (e) { document.getElementById('m-ext-err').textContent = e.message; }
}

// ═══════════════════════════════════════════════
// BILLS
// ═══════════════════════════════════════════════
async function showCreateBill(tenantId) {
  let contracts;
  try { [contracts, _props] = await Promise.all([apiFetch('/contracts'), apiFetch('/properties')]); } catch (e) { alert(e.message); return; }
  const active = contracts.filter(c => (c.status === 'active' || c.status === 'move_out_pending') && (!tenantId || c.tenant_id === tenantId));
  if (!active.length) { alert('Give this tenant a unit (contract) first.'); return; }
  const now = new Date();
  openModal('Create Bill', `
    <div class="form-group"><label>Contract</label><select id="m-b-contract" onchange="billTypesForContract()"><option value="">— Select —</option>
      ${active.map(c => `<option value="${parseInt(c.id)}" data-prop="${parseInt(c.property_id)}" ${active.length === 1 ? 'selected' : ''}>${esc(c.tenant_name)} — ${esc(c.property_name)} Unit ${esc(c.unit_number)}</option>`).join('')}</select></div>
    <div class="form-group"><label>Bill Type</label><select id="m-b-type">
      <option value="rent">Rent</option><option value="electricity">Electricity</option><option value="water">Water</option><option value="other">Other</option></select></div>
    <div class="grid-2"><div class="form-group"><label>Month</label><select id="m-b-month">
      ${MONTHS.map((m, i) => `<option value="${i + 1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
    <div class="form-group"><label>Year</label><input type="number" id="m-b-year" value="${now.getFullYear()}"/></div></div>
    <div class="form-group"><label>Description</label><input type="text" id="m-b-desc" maxlength="255"/></div>
    <div class="form-group"><label>Amount ₱</label><input type="number" id="m-b-amt" min="0" step="0.01" inputmode="decimal"/></div>
    <div class="form-group"><label>Due Date</label><input type="date" id="m-b-due"/></div>
    <p class="err-msg" id="m-b-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitCreateBill()">Create</button>`);
}
const BILL_TYPES = [['rent', 'Rent', null], ['electricity', 'Electricity', 'electricity_billing'], ['water', 'Water', 'water_billing'], ['other', 'Other', 'other_charges']];
function billTypesForContract() {
  const opt = document.getElementById('m-b-contract').selectedOptions[0];
  const prop = _props.find(p => p.id === parseInt(opt && opt.dataset.prop));
  const sel = document.getElementById('m-b-type'); const cur = sel.value;
  sel.innerHTML = BILL_TYPES.filter(([, , need]) => !need || !prop || hasFeature(prop, need))
    .map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
}
async function submitCreateBill() {
  const v = id => document.getElementById(id).value;
  const body = {
    contract_id: v('m-b-contract'), description: v('m-b-desc').trim(), bill_type: v('m-b-type'),
    bill_month: v('m-b-month'), bill_year: v('m-b-year'), amount: v('m-b-amt'), due_date: v('m-b-due')
  };
  try {
    const d = await apiFetch('/bills', { method: 'POST', body: JSON.stringify(body) });
    refreshView();
    openModal('Bill created', `<div class="info-box">The tenant has been notified. You can open the billing statement as a PDF to print or send.</div>`,
      `<button class="btn btn-outline" onclick="closeModalDirect()">Done</button>
       <button class="btn btn-brand" onclick="openPdf('/api/bills/${parseInt(d.bill_id)}/pdf')">🧾 Open / Print PDF</button>`);
  } catch (e) { document.getElementById('m-b-err').textContent = e.message; }
}

// ═══════════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════════
async function reviewPayment(id, action) {
  try {
    const d = await apiFetch('/payments/' + id + '/' + action, { method: 'PATCH', body: '{}' });
    if (d && d.receipt_no) alert(`✅ Approved. Receipt ${d.receipt_no} was sent to the tenant.`);
  } catch (e) { alert(e.message); }
  refreshView();
}
function rejectPaymentModal(id) {
  openModal('Reject Payment', `<div class="form-group"><label>Reason</label><textarea id="m-reject-notes" rows="3"></textarea></div>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-red" onclick="submitReject(${parseInt(id)})">Reject</button>`);
}
async function submitReject(id) {
  const notes = document.getElementById('m-reject-notes').value;
  try { await apiFetch('/payments/' + id + '/reject', { method: 'PATCH', body: JSON.stringify({ notes }) }); } catch (e) { alert(e.message); }
  closeModalDirect(); refreshView();
}

// ═══════════════════════════════════════════════
// ANNOUNCEMENTS — LANDLORD
// ═══════════════════════════════════════════════
async function loadLandlordAnnouncements() {
  const pg = document.getElementById('page-announcements'); pg.innerHTML = loadingHtml;
  try {
    const [announcements, props, rules] = await Promise.all([apiFetch('/announcements'), apiFetch('/properties'), apiFetch('/tenant-reminders')]);
    _props = props; _tenantRules = rules;
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>📣 Announcements (${announcements.length})</h3>
      <button class="btn btn-brand" onclick="showCreateAnnouncement()">+ New Announcement</button></div>
      <div class="info-box">Send announcements to tenants — maintenance updates, payment reminders, or general notices. Tenants get a phone notification if they turned them on.</div>
      ${!announcements.length ? '<div class="empty-state"><div class="icon">📣</div><p>No announcements yet</p></div>' :
        announcements.map(a => `
          <div class="announcement-card">
            <div class="ann-top">
              <div class="ann-subject">📣 ${esc(a.subject)}</div>
              <div>${a.is_active ? `<button class="btn btn-sm btn-red" onclick="deleteAnnouncement(${parseInt(a.id)})">Remove</button>` : '<span class="badge badge-gray">Removed</span>'}</div>
            </div>
            <div class="ann-body">${esc(a.body)}</div>
            <div class="ann-meta">
              <span>${a.target_all ? '📡 All Properties' : '🏢 Selected Properties'}</span>
              ${a.expires_at ? `<span>⏰ Expires ${fmtDate(a.expires_at)}</span>` : ''}
              <span>📅 ${fmtDate(a.created_at)}</span>
            </div>
          </div>`).join('')}
    </div>
    ${tenantRemindersCardHtml(rules)}`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}

// ── Bill reminders to tenants (per property, per bill type) ──
let _tenantRules = [];
const RULE_TYPES = { rent: 'Rent', water: 'Water', electricity: 'Electricity', other: 'Other charges' };
const daysOpt = (list, cur, word) => `<option value="">Off</option>` + list.map(n =>
  `<option value="${n}" ${cur === n ? 'selected' : ''}>${n} ${word}${n === 1 ? '' : 's'}</option>`).join('');
function ruleSummary(t) {
  const parts = [];
  if (t.days_before) parts.push(`${t.days_before}d before`);
  if (t.on_due_day) parts.push('on due date');
  if (t.overdue_every) parts.push(t.overdue_every === 1 ? 'daily if late' : `every ${t.overdue_every}d if late`);
  return parts.length ? parts.join(', ') : 'off';
}
function tenantRemindersCardHtml(rules) {
  return `<div class="card"><div class="card-header"><h3>🔔 Bill Reminders to Tenants</h3></div>
    <p class="muted-text">Tenants get a phone notification about unpaid bills — set it for each property and type of bill.
      Reminders go out from 8 AM. Bills with a payment waiting for your review are skipped.</p>
    ${!rules.length ? '<p class="muted-text">Add a property first.</p>' : rules.map((p, i) => `
      <details class="rem-prop" id="rem-prop-${parseInt(p.property_id)}" ${i === 0 ? 'open' : ''}>
        <summary><strong>🏢 ${esc(p.name)}</strong>
          <span class="muted-text small">${p.types.map(t => `${RULE_TYPES[t.bill_type]}: ${ruleSummary(t)}`).join(' · ') || 'No bills turned on'}</span></summary>
        ${!p.types.length ? '<p class="muted-text">No bill types are turned on in this property\'s Setup.</p>' : p.types.map(t => `
          <div class="rem-row" data-type="${esc(t.bill_type)}">
            <div class="rem-type">${RULE_TYPES[t.bill_type]}</div>
            <label>Before the due date<select class="rr-before">${daysOpt([1, 2, 3, 5, 7, 10], t.days_before, 'day')}</select></label>
            <label class="rem-check"><input type="checkbox" class="rr-due" ${t.on_due_day ? 'checked' : ''}/> On the due date</label>
            <label>If still unpaid, every<select class="rr-every">${daysOpt([1, 2, 3, 7, 14], t.overdue_every, 'day')}</select></label>
          </div>`).join('')}
        ${p.types.length ? `<div class="btn-group" style="margin-top:10px">
          <button class="btn btn-sm btn-brand" onclick="saveTenantRules(${parseInt(p.property_id)})">Save</button>
          ${rules.length > 1 ? `<button class="btn btn-sm btn-outline" onclick="copyTenantRules(${parseInt(p.property_id)})">Use for all properties</button>` : ''}
          <span class="small-msg" id="rem-msg-${parseInt(p.property_id)}"></span></div>` : ''}
      </details>`).join('')}
  </div>`;
}
function readTenantRules(pid) {
  return [...document.querySelectorAll(`#rem-prop-${pid} .rem-row`)].map(r => ({
    bill_type: r.dataset.type, days_before: r.querySelector('.rr-before').value || null,
    on_due_day: r.querySelector('.rr-due').checked, overdue_every: r.querySelector('.rr-every').value || null }));
}
async function saveTenantRules(pid) {
  const msg = document.getElementById('rem-msg-' + pid);
  try {
    await apiFetch('/tenant-reminders/' + pid, { method: 'PUT', body: JSON.stringify({ types: readTenantRules(pid) }) });
    msg.className = 'small-msg ok'; msg.textContent = '✅ Saved';
    _tenantRules = await apiFetch('/tenant-reminders');
    const p = _tenantRules.find(x => x.property_id === pid);
    if (p) document.querySelector(`#rem-prop-${pid} summary .muted-text`).textContent =
      p.types.map(t => `${RULE_TYPES[t.bill_type]}: ${ruleSummary(t)}`).join(' · ');
  } catch (e) { msg.className = 'small-msg bad'; msg.textContent = e.message; }
}
async function copyTenantRules(pid) {
  const src = readTenantRules(pid); const from = _tenantRules.find(p => p.property_id === pid);
  const others = _tenantRules.filter(p => p.property_id !== pid);
  if (!await confirmAction({ title: 'Use these reminders for all properties?', danger: false, okText: 'Apply to all',
      message: `The reminder settings of ${from.name} replace those of:`, effects: others.map(p => p.name) })) return;
  try {
    for (const p of others) {
      const types = p.types.map(t => src.find(x => x.bill_type === t.bill_type)).filter(Boolean);
      if (types.length) await apiFetch('/tenant-reminders/' + p.property_id, { method: 'PUT', body: JSON.stringify({ types }) });
    }
    await saveTenantRules(pid);
    loadLandlordAnnouncements();
  } catch (e) { alert(e.message); }
}
function showCreateAnnouncement() {
  openModal('New Announcement', `
    <div class="form-group"><label>Subject</label><input type="text" id="m-ann-subject" maxlength="255" placeholder="e.g. Water interruption this Saturday"/></div>
    <div class="form-group"><label>Message</label><textarea id="m-ann-body" rows="5" placeholder="Write your announcement here…"></textarea></div>
    <div class="form-group check-box"><label>
        <input type="checkbox" id="m-ann-all" onchange="document.getElementById('m-ann-props-wrap').style.display=this.checked?'none':''" checked/>
        <span><strong>Send to ALL properties</strong></span></label></div>
    <div id="m-ann-props-wrap" style="display:none">
      <div class="form-group"><label>Select Properties</label>
        <div class="check-list">
          ${_props.map(p => `<label><input type="checkbox" class="ann-prop-cb" value="${parseInt(p.id)}"/>${esc(p.name)}</label>`).join('')}
        </div></div></div>
    <div class="form-group"><label>Expiry Date (optional)</label><input type="date" id="m-ann-expires"/>
      <small class="hint">Announcement will be hidden after this date.</small></div>
    <p class="err-msg" id="m-ann-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitCreateAnnouncement()">Send Announcement</button>`);
}
async function submitCreateAnnouncement() {
  const subject = document.getElementById('m-ann-subject').value.trim();
  const body = document.getElementById('m-ann-body').value.trim();
  const target_all = document.getElementById('m-ann-all').checked;
  const property_ids = [...document.querySelectorAll('.ann-prop-cb:checked')].map(cb => parseInt(cb.value));
  const expires_at = document.getElementById('m-ann-expires').value || null;
  const errEl = document.getElementById('m-ann-err'); errEl.textContent = '';
  if (!subject || !body) { errEl.textContent = 'Subject and message are required'; return; }
  if (!target_all && !property_ids.length) { errEl.textContent = 'Select at least one property'; return; }
  try {
    await apiFetch('/announcements', { method: 'POST', body: JSON.stringify({ subject, body, target_all, property_ids, expires_at }) });
    closeModalDirect(); alert('✅ Announcement sent!'); loadLandlordAnnouncements();
  } catch (e) { errEl.textContent = e.message; }
}
async function deleteAnnouncement(id) {
  if (!await confirmAction({ title: 'Remove this announcement?', message: 'Tenants will no longer see it.', okText: 'Remove' })) return;
  try { await apiFetch('/announcements/' + id, { method: 'DELETE' }); } catch (e) { alert(e.message); }
  loadLandlordAnnouncements();
}

// ═══════════════════════════════════════════════
// MESSAGES (both roles)
// ═══════════════════════════════════════════════
const LANDLORD_SUBJECTS = ['Payment Reminder', 'Lease Renewal', 'Maintenance Notice', 'Unit Inspection', 'Contract Update', 'Rent Increase Notice', 'Welcome', 'Others'];
const TENANT_SUBJECTS = ['Maintenance Request', 'Late Payment Notice', 'Lease Question', 'Moving Out Notice', 'General Inquiry', 'Emergency', 'Others'];

function threadListHtml(threads, unreadKey) {
  return threads.map(t => `<div class="thread-list-item ${!t[unreadKey] ? 'unread' : ''}" onclick="openThread(${parseInt(t.id)})">
      <div class="thread-avatar">${esc((t.other_name || '?')[0].toUpperCase())}</div>
      <div class="thread-info">
        <div class="tname">${esc(t.other_name)} ${!t[unreadKey] ? '🔵' : ''}</div>
        <div class="tsubject"><strong>${esc(t.subject)}</strong></div>
        <div class="tlast">${esc((t.last_message || '').substring(0, 80))}</div>
      </div>
      <div class="thread-time">${fmtDate(t.last_reply_at)}</div>
    </div>`).join('');
}
async function loadMessages() {
  const pg = document.getElementById('page-messages'); pg.innerHTML = loadingHtml;
  try {
    const threads = await apiFetch('/threads');
    const unread = threads.filter(t => !t.is_read_landlord).length;
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Messages ${unread > 0 ? `<span class="badge badge-red">${unread} unread</span>` : ''}</h3>
      <button class="btn btn-brand" onclick="showNewThread()">+ New Message</button></div>
      ${!threads.length ? '<div class="empty-state"><div class="icon">💬</div><p>No messages yet</p></div>' : threadListHtml(threads, 'is_read_landlord')}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function showNewThread(tenantUserId) {
  let tenants;
  try { tenants = await apiFetch('/landlord/tenants'); } catch (e) { alert(e.message); return; }
  if (!tenants.length) { alert('No tenants yet.'); return; }
  openModal('New Message to Tenant', `
    <div class="form-group"><label>To (Tenant)</label><select id="m-nt-tenant"><option value="">— Select tenant —</option>
      ${tenants.map(t => `<option value="${parseInt(t.user_id)}" ${t.user_id === tenantUserId ? 'selected' : ''}>${esc(t.full_name)}${t.unit_number ? ' — Unit ' + esc(t.unit_number) : ''}</option>`).join('')}</select></div>
    <div class="form-group"><label>Subject</label>
      <select id="m-nt-subject">${LANDLORD_SUBJECTS.map(s => `<option>${esc(s)}</option>`).join('')}</select></div>
    <div class="form-group"><label>Message</label><textarea id="m-nt-body" rows="4" placeholder="Type your message…"></textarea></div>
    <p class="err-msg" id="m-nt-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitNewThreadLandlord()">Send</button>`);
}
async function submitNewThreadLandlord() {
  const tenant_user_id = parseInt(document.getElementById('m-nt-tenant').value);
  const subject = document.getElementById('m-nt-subject').value.trim();
  const body = document.getElementById('m-nt-body').value.trim();
  const errEl = document.getElementById('m-nt-err'); errEl.textContent = '';
  if (!tenant_user_id || !subject || !body) { errEl.textContent = 'All fields required'; return; }
  try { await apiFetch('/threads', { method: 'POST', body: JSON.stringify({ subject, body, tenant_user_id }) }); closeModalDirect(); goPage('messages'); }
  catch (e) { errEl.textContent = e.message; }
}
async function openThread(tid) {
  let d;
  try { d = await apiFetch('/threads/' + tid); } catch (e) { alert(e.message); return; }
  const t = d.thread; const replies = d.replies || [];
  openModal(t.subject, `
    <div class="muted-text" style="margin-bottom:12px">Conversation with ${esc(t.other_name)}</div>
    <div class="chat-wrap" id="chat-wrap">
      ${replies.map(r => { const mine = r.sender_id === currentUser.id; return `<div class="bubble ${mine ? 'mine' : 'theirs'}">
        <div class="bname">${mine ? 'You' : esc(r.sender_name)}</div>
        <div class="btext">${esc(r.body)}</div><div class="btime">${fmtDateTime(r.sent_at)}</div></div>`; }).join('')}
    </div>
    ${t.read_only ? '<div class="info-box" style="margin-top:12px">This tenant has moved out. The conversation is kept as a record.</div>'
      : '<div style="margin-top:12px"><textarea id="reply-body" rows="3" placeholder="Type your reply…"></textarea></div>'}`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Close</button>
     ${t.read_only ? '' : `<button class="btn btn-brand" onclick="submitReplyThread(${parseInt(tid)})">Send Reply</button>`}`);
  setTimeout(() => { const cw = document.getElementById('chat-wrap'); if (cw) cw.scrollTop = cw.scrollHeight; }, 50);
  loadNotifications();
}
async function submitReplyThread(tid) {
  const body = document.getElementById('reply-body').value.trim();
  if (!body) { alert('Please type a message'); return; }
  try {
    await apiFetch('/threads/' + tid + '/reply', { method: 'POST', body: JSON.stringify({ body }) });
    closeModalDirect();
    goPage(currentUser.role === 'landlord' ? 'messages' : 't-messages');
  } catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// WATER BILLING
// ═══════════════════════════════════════════════
async function loadWaterBilling() {
  const pg = document.getElementById('page-water'); pg.innerHTML = loadingHtml;
  try {
    const [sessions, props] = await Promise.all([apiFetch('/water/sessions'), apiFetch('/properties')]);
    _props = props;
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Water Billing Sessions</h3>
      <button class="btn btn-brand" onclick="showNewWaterSession()">+ New Session</button></div>
      <div class="info-box">Enter monthly water meter readings per property. The app calculates each unit's bill. Only properties with Water billing turned on in their Setup are listed.</div>
      ${!sessions.length ? '<div class="empty-state"><div class="icon">💧</div><p>No sessions yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Property</th><th>Month</th><th>Main Bill</th><th>Rate/Cubic</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        ${sessions.map(s => `<tr><td><strong>${esc(s.property_name)}</strong></td>
          <td>${MONTHS[s.session_month - 1]} ${esc(s.session_year)}</td>
          <td>₱${fmt(s.total_bill)}</td><td>₱${fmt(s.price_per_cubic)}</td><td>${badge(s.status)}</td>
          <td><div class="btn-group"><button class="btn btn-sm btn-brand" onclick="viewWaterSession(${parseInt(s.id)})">${s.status === 'draft' ? 'Enter Readings' : 'View'}</button>
            ${s.status === 'billed' ? `<button class="btn btn-sm btn-outline" onclick="openPdf('/api/water/sessions/${parseInt(s.id)}/bills.pdf')">🖨 Print bills</button>` : ''}</div></td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function showNewWaterSession() {
  if (!_props.length) { alert('Add a property first.'); return; }
  if (!_props.some(p => hasFeature(p, 'water_billing'))) { alert("No property has Water billing turned on. Turn it on in a property's Setup."); return; }
  const now = new Date();
  openModal('New Water Billing Session', `
    <div class="form-group"><label>Property</label><select id="m-w-prop">${_props.filter(p => hasFeature(p, 'water_billing')).map(p => `<option value="${parseInt(p.id)}">${esc(p.name)}</option>`).join('')}</select></div>
    <div class="grid-2"><div class="form-group"><label>Month</label><select id="m-w-month">
      ${MONTHS.map((m, i) => `<option value="${i + 1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
    <div class="form-group"><label>Year</label><input type="number" id="m-w-year" value="${now.getFullYear()}"/></div></div>
    <div class="grid-2"><div class="form-group"><label>Previous Reading Date</label><input type="date" id="m-w-prev-date"/></div>
    <div class="form-group"><label>Present Reading Date</label><input type="date" id="m-w-curr-date"/></div></div>
    <div class="grid-2"><div class="form-group"><label>Total Main Bill ₱</label><input type="number" id="m-w-bill" step="0.01" inputmode="decimal" oninput="calcWaterRate()"/></div>
    <div class="form-group"><label>Overall Consumption cu</label><input type="number" id="m-w-cons" inputmode="decimal" oninput="calcWaterRate()"/></div></div>
    <div class="grid-2"><div class="form-group"><label>Water Pump Total ₱</label><input type="number" id="m-w-pump" step="0.01" inputmode="decimal" oninput="calcWaterRate()"/></div>
    <div class="form-group"><label>Number of Units</label><input type="number" id="m-w-units" oninput="calcWaterRate()"/></div></div>
    <div id="water-rate-preview" class="water-calc" style="display:none">
      <div class="row"><span>Price per cubic meter</span><span id="w-rate-val">—</span></div>
      <div class="row"><span>Pump fee per unit</span><span id="w-pump-val">—</span></div>
    </div><p class="err-msg" id="m-w-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitNewWaterSession()">Create Session</button>`);
}
function calcWaterRate() {
  const num = id => parseFloat(document.getElementById(id)?.value || 0);
  const bill = num('m-w-bill'), cons = num('m-w-cons'), pump = num('m-w-pump'), units = parseInt(document.getElementById('m-w-units')?.value || 1);
  if (bill > 0 && cons > 0) {
    document.getElementById('water-rate-preview').style.display = 'block';
    document.getElementById('w-rate-val').textContent = '₱' + (bill / cons).toFixed(4);
    document.getElementById('w-pump-val').textContent = '₱' + (units > 0 ? pump / units : 0).toFixed(4);
  }
}
async function submitNewWaterSession() {
  const v = id => document.getElementById(id).value;
  const body = {
    property_id: v('m-w-prop'), session_month: v('m-w-month'), session_year: v('m-w-year'),
    prev_reading_date: v('m-w-prev-date'), curr_reading_date: v('m-w-curr-date'), total_bill: v('m-w-bill'),
    overall_consumption: v('m-w-cons'), pump_total: v('m-w-pump') || 0, number_of_units: v('m-w-units') || 1
  };
  const errEl = document.getElementById('m-w-err'); errEl.textContent = '';
  if (!body.prev_reading_date || !body.curr_reading_date || !body.total_bill || !body.overall_consumption) { errEl.textContent = 'All fields required'; return; }
  try { const d = await apiFetch('/water/sessions', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); viewWaterSession(d.session_id); }
  catch (e) { errEl.textContent = e.message; }
}
let _water = null;   // { session, units }
function viewWaterSession(sid) { showView('water', () => openWaterSession(sid), 'water/' + sid); }
async function openWaterSession(sid) {
  const pg = document.getElementById('page-water'); pg.innerHTML = loadingHtml;
  try {
    const d = await apiFetch('/water/sessions/' + sid); const s = d.session; const readings = d.readings || [];
    const units = await apiFetch('/units?property_id=' + s.property_id);
    _water = { session: s, units };
    const billed = s.status === 'billed';
    const readingMap = {}; readings.forEach(r => readingMap[r.unit_id] = r);
    const anyBill = readings.some(r => r.bill_id);
    pg.innerHTML = `<div class="card">
      <div class="card-header"><div><h3>💧 ${esc(s.property_name)} — ${MONTHS[s.session_month - 1]} ${esc(s.session_year)}</h3>
        <div class="muted-text" style="margin-top:4px">${fmtDate(s.prev_reading_date)} → ${fmtDate(s.curr_reading_date)}</div></div>
        ${anyBill ? `<button class="btn btn-sm btn-outline" onclick="openPdf('/api/water/sessions/${parseInt(sid)}/bills.pdf')">🖨 Print all bills</button>` : ''}
      </div>
      <div class="water-calc">
        <div class="row"><span>Total Main Bill</span><span>₱${fmt(s.total_bill)}</span></div>
        <div class="row"><span>Overall Consumption</span><span>${esc(s.overall_consumption)} cu</span></div>
        <div class="row"><span>Price per Cubic</span><span>₱${parseFloat(s.price_per_cubic).toFixed(4)}</span></div>
        <div class="row"><span>Pump Fee per Unit</span><span>₱${parseFloat(s.pump_per_unit).toFixed(4)}</span></div>
      </div></div>
      <div class="card"><div class="card-header"><h3>Unit Readings</h3></div>
      ${billed ? `<div class="info-box">Bills generated and sent to the tenants. “Print all bills” gives one page per unit.
          To fix a wrong bill, delete it on the tenant's profile — this session reopens so you can correct the reading.</div>`
        : anyBill ? '<div class="info-box">Units marked 🔒 are already billed. Fix the others, then Generate Bills for the rest.</div>' : ''}
      <div class="table-wrap"><table><thead><tr><th>Unit</th><th>Owner?</th><th>Previous cu</th><th>Current cu</th><th>Consumption</th><th>Water Bill</th><th>Pump</th><th>Total</th></tr></thead><tbody>
      ${units.map(u => { const r = readingMap[u.id] || {}; const id = parseInt(u.id); const dis = billed || r.bill_id ? 'disabled' : ''; return `<tr>
        <td><strong>${esc(u.unit_number)}</strong>${r.bill_id ? ' 🔒' : ''}</td>
        <td><input type="checkbox" id="owner-${id}" ${r.is_owner_unit ? 'checked' : ''} ${dis}/></td>
        <td><input type="number" class="cell-input" inputmode="decimal" id="prev-${id}" value="${esc(r.prev_reading ?? '')}" oninput="recalcRow(${id})" ${dis}/></td>
        <td><input type="number" class="cell-input" inputmode="decimal" id="curr-${id}" value="${esc(r.curr_reading ?? '')}" oninput="recalcRow(${id})" ${dis}/></td>
        <td id="cons-${id}">${r.consumption != null ? esc(r.consumption) + ' cu' : '—'}</td>
        <td id="wb-${id}">${r.water_bill != null ? '₱' + fmt(r.water_bill) : '—'}</td>
        <td id="pf-${id}">${r.pump_fee != null ? '₱' + fmt(r.pump_fee) : '—'}</td>
        <td id="tot-${id}" style="font-weight:600;color:var(--brand)">${r.total_amount != null ? '₱' + fmt(r.total_amount) : '—'}</td>
      </tr>`; }).join('')}
      </tbody></table></div>
      ${!billed ? `<div class="btn-group" style="margin-top:16px">
        <button class="btn btn-outline" onclick="saveWaterReadings(${parseInt(sid)})">💾 Save Readings</button>
        <button class="btn btn-brand" onclick="showGenerateWaterBills(${parseInt(sid)})">⚡ Generate Bills</button></div>` : ''}
      </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function recalcRow(unitId) {
  const s = _water && _water.session; if (!s) return;
  const prev = parseFloat(document.getElementById('prev-' + unitId)?.value || 0);
  const curr = parseFloat(document.getElementById('curr-' + unitId)?.value || 0);
  if (curr >= prev && (prev > 0 || curr > 0)) {
    const cons = curr - prev; const wb = parseFloat(s.price_per_cubic) * cons;
    const pf = parseFloat(s.pump_per_unit); const tot = wb + pf;
    document.getElementById('cons-' + unitId).textContent = cons.toFixed(2) + ' cu';
    document.getElementById('wb-' + unitId).textContent = '₱' + fmt(wb);
    document.getElementById('pf-' + unitId).textContent = '₱' + fmt(pf);
    document.getElementById('tot-' + unitId).textContent = '₱' + fmt(tot);
  }
}
async function saveWaterReadings(sid) {
  const readings = _water.units.filter(u => !document.getElementById('curr-' + u.id)?.disabled).map(u => ({
    unit_id: u.id, prev_reading: parseFloat(document.getElementById('prev-' + u.id)?.value || 0),
    curr_reading: parseFloat(document.getElementById('curr-' + u.id)?.value || 0),
    is_owner_unit: document.getElementById('owner-' + u.id)?.checked ? 1 : 0
  })).filter(r => r.curr_reading > 0 || r.prev_reading > 0);
  if (!readings.length) { alert('Enter at least one reading.'); return; }
  try { await apiFetch('/water/sessions/' + sid + '/readings', { method: 'POST', body: JSON.stringify({ readings }) }); alert('Readings saved!'); openWaterSession(sid); }
  catch (e) { alert(e.message); }
}
function showGenerateWaterBills(sid) {
  const now = new Date(); const defaultDue = new Date(now.getFullYear(), now.getMonth(), 15).toISOString().split('T')[0];
  openModal('Generate Water Bills', `<div class="info-box">This creates water bills for all non-owner units and notifies the tenants. Save all readings first.</div>
    <div class="form-group"><label>Due Date</label><input type="date" id="m-wbill-due" value="${defaultDue}"/></div>
    <p class="err-msg" id="m-wbill-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitGenerateWaterBills(${parseInt(sid)})">Generate Bills</button>`);
}
async function submitGenerateWaterBills(sid) {
  const due_date = document.getElementById('m-wbill-due').value;
  if (!due_date) { document.getElementById('m-wbill-err').textContent = 'Required'; return; }
  try { const d = await apiFetch('/water/sessions/' + sid + '/generate-bills', { method: 'POST', body: JSON.stringify({ due_date }) }); closeModalDirect(); alert(`✅ ${d.bills_created} water bills generated!`); loadWaterBilling(); }
  catch (e) { document.getElementById('m-wbill-err').textContent = e.message; }
}

// ═══════════════════════════════════════════════
// MY REMINDERS (landlord, in Settings)
// ═══════════════════════════════════════════════
// Monthly reminders to yourself: a phone notification on the day (from 8 AM) and a Dashboard banner.
const MY_REMINDERS = [
  { type: 'water_reading', label: 'Read the water meters', day: 25 },
  { type: 'water_bills', label: 'Generate water bills', day: 27 },
  { type: 'bill_generation', label: 'Generate monthly rent', day: 1 },
];
let _myRems = [];
function myRemindersHtml() {
  const preset = t => _myRems.find(r => r.reminder_type === t);
  const custom = _myRems.filter(r => !MY_REMINDERS.some(m => m.type === r.reminder_type));
  return MY_REMINDERS.map(m => { const r = preset(m.type) || {}; const on = r.id && r.is_active; return `
      <div class="myrem-row">
        <label class="rem-check"><input type="checkbox" id="myrem-on-${m.type}" ${on ? 'checked' : ''} onchange="saveMyReminder('${m.type}')"/> <strong>${m.label}</strong></label>
        <label class="myrem-day">every month on day <input type="number" min="1" max="28" id="myrem-day-${m.type}" value="${esc(r.day_of_month || m.day)}" onchange="saveMyReminder('${m.type}')"/></label>
      </div>`; }).join('') + custom.map(r => `
      <div class="myrem-row">
        <label class="rem-check"><input type="checkbox" ${r.is_active ? 'checked' : ''} onchange="toggleMyReminder(${parseInt(r.id)}, this.checked)"/> <strong>${esc(r.title)}</strong></label>
        <span class="myrem-day">every month on day ${esc(r.day_of_month)}
          <button class="btn btn-sm btn-red" onclick="deleteReminder(${parseInt(r.id)})">Delete</button></span>
      </div>`).join('');
}
async function reloadMyReminders() {
  _myRems = await apiFetch('/reminders');
  document.getElementById('myrem-list').innerHTML = myRemindersHtml();
}
function myRemMsg(text, good) {
  const m = document.getElementById('myrem-msg'); if (!m) return;
  m.className = 'small-msg ' + (good ? 'ok' : 'bad'); m.textContent = text;
}
async function saveMyReminder(type) {
  const on = document.getElementById('myrem-on-' + type).checked;
  const day = document.getElementById('myrem-day-' + type).value;
  const r = _myRems.find(x => x.reminder_type === type);
  try {
    if (r) await apiFetch('/reminders/' + r.id, { method: 'PATCH', body: JSON.stringify({ is_active: on, day_of_month: day }) });
    else if (on) await apiFetch('/reminders', { method: 'POST', body: JSON.stringify({ reminder_type: type, day_of_month: day }) });
    else return;
    await reloadMyReminders(); myRemMsg('✅ Saved', true);
  } catch (e) { myRemMsg(e.message, false); }
}
async function toggleMyReminder(id, on) {
  try { await apiFetch('/reminders/' + id, { method: 'PATCH', body: JSON.stringify({ is_active: on }) }); myRemMsg('✅ Saved', true); }
  catch (e) { myRemMsg(e.message, false); }
}
function showAddReminder() {
  openModal('Add a Reminder', `
    <div class="form-group"><label>Remind me to</label><input type="text" id="m-rem-title" maxlength="255" placeholder="e.g. Pay the main water bill"/></div>
    <div class="form-group"><label>Day of the month (1–28)</label><input type="number" id="m-rem-day" min="1" max="28" placeholder="1"/>
      <small class="hint">You get a phone notification on this day every month, and it shows on your Dashboard.</small></div>
    <p class="err-msg" id="m-rem-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitAddReminder()">Add</button>`);
}
async function submitAddReminder() {
  const body = { title: document.getElementById('m-rem-title').value.trim(), reminder_type: 'custom', day_of_month: document.getElementById('m-rem-day').value };
  const errEl = document.getElementById('m-rem-err'); errEl.textContent = '';
  if (!body.title || !body.day_of_month) { errEl.textContent = 'Both fields are required'; return; }
  try { await apiFetch('/reminders', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); reloadMyReminders(); }
  catch (e) { errEl.textContent = e.message; }
}
async function deleteReminder(id) {
  if (!await confirmAction({ title: 'Delete this reminder?', okText: 'Delete' })) return;
  try { await apiFetch('/reminders/' + id, { method: 'DELETE' }); } catch (e) { alert(e.message); }
  reloadMyReminders();
}
const supportCardHtml = page => `<div class="card"><div class="card-header"><h3>🎫 Help &amp; Support</h3></div>
    <p class="muted-text">Questions, or something not working? Chat with us or open a support ticket.</p>
    <button class="btn btn-brand" style="margin-top:10px" onclick="goPage('${page}')">Open Help &amp; Support</button></div>`;

// ═══════════════════════════════════════════════
// SUPPORT (Landlord & Tenant)
// ═══════════════════════════════════════════════
let _support = { chats: [], tickets: [], pageId: 'support', tab: 'chat' };
async function loadSupport(role) {
  const pageId = role === 'tenant' ? 't-support' : 'support';
  const pg = document.getElementById('page-' + pageId);
  pg.innerHTML = loadingHtml;
  let chats = [], tickets = [];
  try { chats = await apiFetch('/support-chat'); } catch (_) { }
  try { tickets = await apiFetch('/tickets'); } catch (_) { }
  _support = { chats, tickets, pageId, tab: _support.tab || 'chat' };
  renderSupportTab(_support.tab);
}
function renderSupportTab(tab) {
  _support.tab = tab;
  const { chats, tickets, pageId } = _support;
  const pg = document.getElementById('page-' + pageId);
  const openChat = chats.find(c => c.status === 'open');
  const unreadTickets = tickets.filter(t => t.unread_count > 0).length;
  pg.innerHTML = `
    <div class="seg-tabs">
      <button class="${tab === 'chat' ? 'active' : ''}" onclick="renderSupportTab('chat')">💬 Live Chat</button>
      <button class="${tab === 'tickets' ? 'active' : ''}" onclick="renderSupportTab('tickets')">🎫 Tickets ${unreadTickets > 0 ? `<span class="count-dot">${unreadTickets}</span>` : ''}</button>
    </div>
    <div id="support-tab-content"></div>`;
  const tc = document.getElementById('support-tab-content');
  if (tab === 'chat') {
    if (openChat) { loadSupportChat(openChat.id); return; }
    const old = chats.filter(c => c.status !== 'open');
    tc.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>💬 Chat with Support</h3></div>
        <div class="info-box">Start a conversation with our support team.</div>
        <div class="form-group" style="margin-top:14px"><label>Subject</label>
          <select id="chat-subject"><option>Billing Issue</option><option>Technical Problem</option>
            <option>Account Help</option><option>Contract Question</option><option>Feature Request</option><option>Other</option></select></div>
        <div class="form-group"><label>Message</label><textarea id="chat-body" rows="4" placeholder="Describe your issue…"></textarea></div>
        <button class="btn btn-brand" onclick="startSupportChat()">Start Chat</button>
        <p class="err-msg" id="chat-err"></p>
      </div>
      ${old.length ? `<div class="card"><div class="card-header"><h3>Previous Chats</h3></div>
        ${old.map(c => `<div class="ticket-item" onclick="loadSupportChat(${parseInt(c.id)})">
          <div class="ttitle">${esc(c.subject)} ${badge(c.status)}</div>
          <div class="tmeta"><span>📅 ${fmtDate(c.last_message_at)}</span></div></div>`).join('')}
      </div>` : ''}`;
  } else {
    tc.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>My Support Tickets</h3>
          <button class="btn btn-brand" onclick="showNewTicket()">+ New Ticket</button></div>
        ${!tickets.length ? '<div class="empty-state"><div class="icon">🎫</div><p>No tickets yet</p></div>' : ticketListHtml(tickets, false)}
      </div>`;
  }
}
function ticketListHtml(tickets, admin) {
  return tickets.map(t => `<div class="ticket-item" onclick="openTicket(${parseInt(t.id)})">
      <div class="ticket-top">
        <div class="ttitle">#${parseInt(t.id)} ${esc(t.title)} ${t.unread_count > 0 ? `<span class="badge badge-red">${parseInt(t.unread_count)} new</span>` : ''}</div>
        <div class="btn-group">${badge(t.priority)}${badge(t.status)}</div>
      </div>
      <div class="tmeta">${admin ? `<span>👤 ${esc(t.opener_name)} (${esc(t.opener_role)})</span>` : ''}
        <span>📁 ${esc(t.category)}</span><span>💬 ${parseInt(t.reply_count)} replies</span><span>📅 ${fmtDate(t.created_at)}</span></div>
    </div>`).join('');
}
async function startSupportChat() {
  const subject = document.getElementById('chat-subject').value;
  const body = document.getElementById('chat-body').value.trim();
  const errEl = document.getElementById('chat-err'); errEl.textContent = '';
  if (!body) { errEl.textContent = 'Please describe your issue'; return; }
  try { const d = await apiFetch('/support-chat', { method: 'POST', body: JSON.stringify({ subject, body }) }); await loadSupportChat(d.chat_id); }
  catch (e) { errEl.textContent = e.message; }
}
function chatBubbles(msgs, adminView) {
  return msgs.map(m => {
    const mine = adminView ? m.sender_role === 'admin' : m.sender_id === currentUser.id;
    const who = mine ? (adminView ? 'You (Support)' : 'You') : (m.sender_role === 'admin' ? '🛡️ Support' : esc(m.sender_name));
    return `<div class="bubble ${mine ? 'mine' : 'theirs'}"><div class="bname">${who}</div>
      <div class="btext">${esc(m.body)}</div><div class="btime">${fmtDateTime(m.sent_at)}</div></div>`;
  }).join('');
}
async function loadSupportChat(chatId) {
  const pg = document.getElementById('support-tab-content') || document.getElementById('page-' + _support.pageId);
  pg.innerHTML = loadingHtml;
  try {
    const d = await apiFetch('/support-chat/' + chatId);
    const chat = d.chat; const msgs = d.messages || []; const closed = chat.status !== 'open';
    pg.innerHTML = `
      <div class="card">
        <div class="card-header"><div><h3>💬 ${esc(chat.subject)}</h3><div class="muted-text" style="margin-top:2px">Support Chat ${badge(chat.status)}</div></div></div>
        <div class="chat-wrap" id="support-chat-wrap">
          ${chatBubbles(msgs, false)}
          ${msgs.length === 0 ? '<div class="notif-empty">Waiting for support to respond…</div>' : ''}
        </div>
        ${!closed ? `<div class="chat-compose">
          <textarea id="support-reply-body" rows="2" placeholder="Type your message…"></textarea>
          <button id="support-send-btn" class="btn btn-brand" onclick="sendSupportReply(${parseInt(chatId)})">Send</button>
        </div>` : `<div class="info-box" style="margin-top:10px">This chat has been ${esc(chat.status)}. <button class="btn btn-sm btn-brand" onclick="_support.tab='chat';loadSupport(currentUser.role)">Start New Chat</button></div>`}
      </div>`;
    setTimeout(() => { const w = document.getElementById('support-chat-wrap'); if (w) w.scrollTop = w.scrollHeight; }, 50);
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function sendSupportReply(chatId) {
  const body = document.getElementById('support-reply-body').value.trim();
  if (!body) return;
  const btn = document.getElementById('support-send-btn');
  btn.disabled = true; btn.textContent = '…';
  try { await apiFetch('/support-chat/' + chatId + '/reply', { method: 'POST', body: JSON.stringify({ body }) }); await loadSupportChat(chatId); }
  catch (e) { alert(e.message); btn.disabled = false; btn.textContent = 'Send'; }
}
function showNewTicket() {
  openModal('Open Support Ticket', `
    <div class="form-group"><label>Title / Subject</label><input type="text" id="m-tk-title" maxlength="255" placeholder="Brief description of your issue"/></div>
    <div class="grid-2"><div class="form-group"><label>Category</label><select id="m-tk-cat">
      <option value="billing">Billing</option><option value="technical">Technical</option>
      <option value="account">Account</option><option value="contract">Contract</option><option value="other">Other</option></select></div>
    <div class="form-group"><label>Priority</label><select id="m-tk-pri">
      <option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></div></div>
    <div class="form-group"><label>Describe your issue</label><textarea id="m-tk-body" rows="5" placeholder="Please provide as much detail as possible…"></textarea></div>
    <p class="err-msg" id="m-tk-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitNewTicket()">Submit Ticket</button>`);
}
async function submitNewTicket() {
  const v = id => document.getElementById(id).value;
  const body = { title: v('m-tk-title').trim(), category: v('m-tk-cat'), priority: v('m-tk-pri'), body: v('m-tk-body').trim() };
  const errEl = document.getElementById('m-tk-err'); errEl.textContent = '';
  if (!body.title || !body.body) { errEl.textContent = 'Title and description required'; return; }
  try { await apiFetch('/tickets', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); alert('✅ Ticket submitted!'); _support.tab = 'tickets'; loadSupport(currentUser.role); }
  catch (e) { errEl.textContent = e.message; }
}
function afterTicketChange() {
  if (currentUser.role === 'admin') loadAdminTickets(); else loadSupport(currentUser.role);
}
async function openTicket(tid) {
  let d;
  try { d = await apiFetch('/tickets/' + tid); } catch (e) { alert(e.message); return; }
  const t = d.ticket; const replies = d.replies || []; const isAdmin = currentUser.role === 'admin';
  openModal(`#${t.id} — ${t.title}`, `
    <div class="btn-group" style="margin-bottom:14px">
      ${badge(t.status)}${badge(t.priority)}${badge(t.category)}
      ${isAdmin && t.status !== 'resolved' ? `<button class="btn btn-sm btn-green" onclick="resolveTicket(${parseInt(t.id)})">✓ Mark Resolved</button>` : ''}
    </div>
    <div class="chat-wrap" id="ticket-chat">
      ${replies.map(r => `<div class="bubble ${r.sender_role === 'admin' ? 'mine' : 'theirs'}">
          <div class="bname">${r.sender_role === 'admin' ? 'Support Team' : esc(r.sender_name)}</div>
          <div class="btext">${esc(r.body)}</div><div class="btime">${fmtDateTime(r.sent_at)}</div></div>`).join('')}
    </div>
    ${t.status !== 'resolved' ? `<div style="margin-top:12px"><textarea id="ticket-reply-body" rows="3" placeholder="Type your reply…"></textarea></div>`
      : `<div class="info-box" style="margin-top:12px">This ticket has been resolved.</div>`}`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Close</button>
     ${t.status !== 'resolved' ? `<button class="btn btn-brand" onclick="submitTicketReply(${parseInt(t.id)})">Send Reply</button>` : ''}`);
  setTimeout(() => { const cw = document.getElementById('ticket-chat'); if (cw) cw.scrollTop = cw.scrollHeight; }, 50);
}
async function submitTicketReply(tid) {
  const body = document.getElementById('ticket-reply-body').value.trim();
  if (!body) { alert('Please type a reply'); return; }
  try { await apiFetch('/tickets/' + tid + '/reply', { method: 'POST', body: JSON.stringify({ body }) }); closeModalDirect(); afterTicketChange(); }
  catch (e) { alert(e.message); }
}
async function resolveTicket(tid) {
  if (!await confirmAction({ title: 'Mark this ticket as resolved?', okText: 'Resolve', danger: false })) return;
  try { await apiFetch('/tickets/' + tid + '/resolve', { method: 'PATCH' }); closeModalDirect(); afterTicketChange(); }
  catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// TENANT HOME — one card per landlord the tenant joined
// ═══════════════════════════════════════════════
const field = (label, value) => `<div class="field"><div class="field-label">${label}</div><div class="field-value">${value}</div></div>`;
function payButton(b, label) {
  if (b.status === 'paid') return '<span class="badge badge-green">Paid</span>';
  if (b.payment_id) return badge(b.payment_status);
  return `<button class="btn btn-sm btn-brand" onclick="showSubmitPayment(${parseInt(b.id)})">${label || 'Pay'}</button>`;
}
let _bills = [];
async function loadTenantDashboard() {
  const pg = document.getElementById('page-t-dashboard'); pg.innerHTML = loadingHtml;
  try {
    const [d, lists] = await Promise.all([apiFetch('/tenant/dashboard'), apiFetch('/tenant/checklist').catch(() => [])]);
    const landlords = d.landlords || []; _bills = d.bills || []; const unreadAnn = d.unread_announcements || 0;
    const todo = lists.filter(l => l.done < l.total);
    const due = _bills.filter(b => b.status !== 'paid' && !b.payment_id);
    pg.innerHTML = `
      ${todo.map(l => `<div class="reminder-banner"><span style="font-size:20px">✅</span>
        <div style="flex:1"><strong>Move-in checklist for ${esc(l.landlord)}</strong>${progressBar(l.done, l.total)}
        <div style="margin-top:6px"><button class="btn btn-sm btn-brand" onclick="goPage('t-checklist')">Open checklist</button></div></div></div>`).join('')}
      ${unreadAnn > 0 ? `<div class="reminder-banner"><span style="font-size:20px">📣</span>
        <div><strong>${unreadAnn} unread announcement${unreadAnn > 1 ? 's' : ''}</strong>
        <div style="margin-top:6px"><button class="btn btn-sm btn-brand" onclick="goPage('t-announcements')">View</button></div></div></div>` : ''}
      ${due.length ? `<div class="stats-grid">
        <div class="stat-card" onclick="goPage('t-bills')" role="button"><div class="value">₱${fmt(due.reduce((s, b) => s + Number(b.amount), 0))}</div><div class="label">To Pay (${due.length} bill${due.length > 1 ? 's' : ''})</div></div>
        <div class="stat-card"><div class="value">${fmtDate(due.map(b => b.due_date).sort((a, b) => new Date(a) - new Date(b))[0])}</div><div class="label">Next Due</div></div></div>` : ''}
      ${landlords.map(l => `
        <div class="card">
          <div class="card-header"><h3>🏠 ${esc(l.business_name || l.landlord_name)}</h3>
            <button class="btn btn-sm btn-brand" onclick="sendTenantMessage(${parseInt(l.landlord_user_id)})">💬 Message</button></div>
          ${l.business_name ? `<p class="muted-text" style="margin-top:-8px;margin-bottom:10px">${esc(l.landlord_name)}</p>` : ''}
          ${l.contracts.length ? l.contracts.map(c => `
            <div class="contract-block">
              <div class="field-grid">
                ${field('Property', esc(c.property_name))}
                ${field('Unit', esc(c.unit_number))}
                ${field('Monthly Rent', '₱' + fmt(c.monthly_rent))}
                ${field('Term', c.is_open_term ? 'Open Term' : fmtDate(c.end_date))}
              </div>
              ${c.contract_status === 'move_out_pending' ? `<div class="warn-box">Moving out — your last day is <strong>${fmtDate(c.move_out_date)}</strong>.</div>` : ''}
              ${c.contract_doc_url ? `
                <div class="doc-row"><span>📄 Signed contract available</span>
                  <div class="btn-group">
                    <button class="btn btn-sm btn-outline" onclick="openDoc(${jsArg(c.contract_doc_url)})">View Contract</button>
                    ${!c.tenant_ack ? `<button class="btn btn-sm btn-green" onclick="acknowledgeContract(${parseInt(c.contract_id)})">✓ Acknowledge</button>` : '<span class="badge badge-green">Acknowledged</span>'}
                  </div></div>` : ''}
            </div>`).join('')
          : `<p class="muted-text">Your landlord hasn't assigned you a unit yet.</p>`}
        </div>`).join('')}
      ${!landlords.length ? `<div class="card"><div class="empty-state"><div class="icon">🏠</div>
        <p>You haven't joined a landlord yet.</p>
        <button class="btn btn-brand" onclick="showJoinLandlord()" style="margin-top:12px">🔑 Enter a Join Code</button></div></div>`
        : `<div style="margin-bottom:16px"><button class="btn btn-outline btn-sm" onclick="showJoinLandlord()">+ Join Another Landlord</button></div>`}
      <div class="card"><div class="card-header"><h3>Recent Bills</h3><button class="btn btn-sm btn-outline" onclick="goPage('t-bills')">View All</button></div>
        ${!_bills.length ? '<p class="muted-text">No bills yet</p>' :
          `<div class="table-wrap"><table><thead><tr><th>Description</th><th>Property</th><th>Amount</th><th>Due</th><th>Status</th><th>Action</th></tr></thead><tbody>
          ${_bills.map(b => `<tr><td>${esc(b.description)}</td><td>${esc(b.property_name)} · ${esc(b.unit_number)}</td>
            <td>₱${fmt(b.amount)}</td><td>${fmtDate(b.due_date)}</td><td>${badge(b.status)}</td><td>${payButton(b)}</td></tr>`).join('')}
          </tbody></table></div>`}
      </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function acknowledgeContract(contractId) {
  try { await apiFetch('/contracts/' + contractId + '/acknowledge', { method: 'POST' }); alert('✅ Contract acknowledged!'); goPage('t-dashboard'); }
  catch (e) { alert(e.message); }
}
function showJoinLandlord() {
  openModal('Join a Landlord', `
    <div class="info-box">Enter the code from your landlord, or scan their QR code with your phone camera.</div>
    <div class="form-group"><label>Join Code</label><input type="text" id="m-join-code" maxlength="8" class="code-input" placeholder="e.g. L3KX9MFA"/></div>
    <p class="err-msg" id="m-join-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitJoinLandlord()">Join</button>`);
}
async function submitJoinLandlord(code) {
  const landlord_code = (code || document.getElementById('m-join-code').value).trim().toUpperCase();
  const errEl = document.getElementById('m-join-err'); errEl.textContent = '';
  if (!landlord_code) { errEl.textContent = 'Enter a join code'; return; }
  try {
    const d = await apiFetch('/auth/join-landlord', { method: 'POST', body: JSON.stringify({ landlord_code }) });
    closeModalDirect(); alert('✅ ' + d.message); goPage('t-dashboard');
  } catch (e) { errEl.textContent = e.message; }
}
function showSubmitPayment(billId) {
  const b = _bills.find(x => x.id === billId);
  if (!b) return;
  openModal('Submit Payment', `<div class="info-box">Bill: <strong>${esc(b.description)}</strong> — ₱${fmt(b.amount)}<br><small>${esc(b.property_name)} · Unit ${esc(b.unit_number)}</small></div>
    <div class="form-group"><label>Amount Paid ₱</label><input type="number" id="m-pay-amt" value="${esc(b.amount)}" min="0" step="0.01" inputmode="decimal"/></div>
    <div class="form-group"><label>Proof of Payment</label>
      <div class="upload-area" id="m-pay-proof-box">
        <div id="m-pay-proof-placeholder">
          <div style="font-size:24px;margin-bottom:8px">📸</div>
          <div class="muted-text" style="margin-bottom:10px">Upload a screenshot, photo or PDF of your payment receipt</div>
          <button class="btn btn-outline" type="button" onclick="uploadPaymentProof()">Choose File</button>
        </div>
        <div id="m-pay-proof-done" style="display:none">
          <div style="font-size:20px;color:var(--success)">✅</div>
          <div style="font-size:13px;margin-top:6px">Proof uploaded</div>
          <button class="btn btn-sm btn-outline" style="margin-top:8px" type="button" onclick="uploadPaymentProof()">Change</button>
        </div>
      </div>
      <input type="hidden" id="m-pay-proof-url"/>
    </div>
    <p class="err-msg" id="m-pay-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" id="m-pay-btn" onclick="submitTenantPayment(${parseInt(billId)})">Submit Payment</button>`);
}
async function uploadPaymentProof() {
  try {
    const box = document.getElementById('m-pay-proof-placeholder').querySelector('.muted-text');
    const result = await uploadFile('payment_proof', UPLOAD_ACCEPT, box);
    if (!result) return;
    document.getElementById('m-pay-proof-url').value = result.url;
    document.getElementById('m-pay-proof-placeholder').style.display = 'none';
    document.getElementById('m-pay-proof-done').style.display = 'block';
  } catch (e) { if (e && e.message) alert('Upload failed: ' + e.message); }
}
async function submitTenantPayment(billId) {
  const proof_url = document.getElementById('m-pay-proof-url').value || '';
  const body = { bill_id: billId, amount_paid: document.getElementById('m-pay-amt').value, proof_url };
  const errEl = document.getElementById('m-pay-err'); errEl.textContent = '';
  if (!body.amount_paid) { errEl.textContent = 'Amount required'; return; }
  if (!proof_url) { errEl.textContent = 'Please upload proof of payment'; return; }
  const btn = document.getElementById('m-pay-btn'); btn.disabled = true;
  try {
    await apiFetch('/payments', { method: 'POST', body: JSON.stringify(body) });
    closeModalDirect();
    const active = document.querySelector('.page.active');
    goPage(active && active.id === 'page-t-bills' ? 't-bills' : 't-dashboard');
  } catch (e) { errEl.textContent = e.message; btn.disabled = false; }
}

// ═══════════════════════════════════════════════
// TENANT — CONTRACTS
// ═══════════════════════════════════════════════
async function loadTenantContracts() {
  const pg = document.getElementById('page-t-contract'); pg.innerHTML = loadingHtml;
  try {
    const contracts = await apiFetch('/contracts');
    pg.innerHTML = !contracts.length ? '<div class="card"><div class="empty-state"><p>No contracts yet</p></div></div>' :
      contracts.map(c => `<div class="card">
        <div class="card-header"><h3>${esc(c.property_name)} — Unit ${esc(c.unit_number)}</h3>${badge(c.status)}</div>
        <p class="muted-text" style="margin-top:-8px;margin-bottom:12px">Landlord: ${esc(c.landlord_name)}</p>
        <div class="field-grid">
          ${field('Monthly Rent', '₱' + fmt(c.monthly_rent))}
          ${field('Deposit', '₱' + fmt(c.deposit))}
          ${field('Term', c.is_open_term ? '<span class="badge badge-blue">Open Term</span>' : fmtDate(c.start_date) + ' → ' + fmtDate(c.end_date))}
          ${c.minimum_months ? field('Minimum Stay', esc(c.minimum_months) + ' months') : ''}
        </div>
        ${c.contract_doc_url ? `
          <div class="doc-row"><span>📄 Signed Contract Document</span>
            <div class="btn-group">
              <button class="btn btn-outline btn-sm" onclick="openDoc(${jsArg(c.contract_doc_url)})">📥 View Contract</button>
              ${!c.tenant_ack ? `<button class="btn btn-green btn-sm" onclick="acknowledgeContract(${parseInt(c.id)})">✓ Acknowledge Receipt</button>` : '<span class="badge badge-green">✓ Acknowledged</span>'}
            </div></div>` : `<div class="warn-box">No contract document uploaded yet.</div>`}
      </div>`).join('');
  } catch (e) { pg.innerHTML = errHtml(e); }
}

// ═══════════════════════════════════════════════
// TENANT — BILLS
// ═══════════════════════════════════════════════
async function loadTenantBills() {
  const pg = document.getElementById('page-t-bills'); pg.innerHTML = loadingHtml;
  try {
    _bills = await apiFetch('/bills');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>My Bills</h3></div>
      ${!_bills.length ? '<div class="empty-state"><p>No bills yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Description</th><th>Property</th><th>Type</th><th>Amount</th><th>Due</th><th>Status</th><th>Action</th></tr></thead><tbody>
        ${_bills.map(b => `<tr><td>${esc(b.description)}</td><td>${esc(b.property_name)} · ${esc(b.unit_number)}<br><small class="muted-text">${esc(b.landlord_name)}</small></td>
          <td>${badge(b.bill_type || 'rent')}</td><td>₱${fmt(b.amount)}</td><td>${fmtDate(b.due_date)}</td><td>${badge(b.status)}</td>
          <td><div class="btn-group">${payButton(b, 'Pay Now')}
            <button class="btn btn-sm btn-outline" onclick="openPdf('/api/bills/${parseInt(b.id)}/pdf')">🧾 Statement</button>
            ${b.payment_status === 'approved' ? `<button class="btn btn-sm btn-outline" onclick="openPdf('/api/payments/${parseInt(b.payment_id)}/receipt.pdf')">✅ Receipt</button>` : ''}</div></td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}

// ═══════════════════════════════════════════════
// TENANT — ANNOUNCEMENTS
// ═══════════════════════════════════════════════
async function loadTenantAnnouncements() {
  const pg = document.getElementById('page-t-announcements'); pg.innerHTML = loadingHtml;
  try {
    const announcements = await apiFetch('/announcements');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Announcements</h3></div>
      ${!announcements.length ? '<div class="empty-state"><div class="icon">📣</div><p>No announcements yet</p></div>' :
        announcements.map(a => `
          <div class="announcement-card ${!a.read_at ? 'unread' : ''}" onclick="markAnnouncementRead(${parseInt(a.id)},this)">
            ${!a.read_at ? '<div style="margin-bottom:8px"><span class="badge badge-blue">New</span></div>' : ''}
            <div class="ann-subject">📣 ${esc(a.subject)}</div>
            <div class="ann-body">${esc(a.body)}</div>
            <div class="ann-meta">
              <span>From: ${esc(a.landlord_name)}</span>
              <span>📅 ${fmtDate(a.created_at)}</span>
              ${a.expires_at ? `<span>⏰ Expires ${fmtDate(a.expires_at)}</span>` : ''}
              ${a.read_at ? `<span>✓ Read ${fmtDate(a.read_at)}</span>` : ''}
            </div>
          </div>`).join('')}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function markAnnouncementRead(id, el) {
  if (!el.classList.contains('unread')) return;
  try {
    await apiFetch('/announcements/' + id + '/read', { method: 'POST' });
    el.classList.remove('unread'); const b = el.querySelector('.badge-blue'); if (b) b.remove();
  } catch (e) { }
}

// ═══════════════════════════════════════════════
// TENANT — MESSAGES
// ═══════════════════════════════════════════════
let _myLandlords = [];
async function loadTenantMessages() {
  const pg = document.getElementById('page-t-messages'); pg.innerHTML = loadingHtml;
  try {
    const threads = await apiFetch('/threads');
    const unread = threads.filter(t => !t.is_read_tenant).length;
    pg.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Messages ${unread > 0 ? `<span class="badge badge-red">${unread} unread</span>` : ''}</h3>
          <button class="btn btn-brand" onclick="sendTenantMessage()">+ New Message</button></div>
        ${!threads.length ? '<div class="empty-state"><div class="icon">💬</div><p>No conversations yet</p></div>' : threadListHtml(threads, 'is_read_tenant')}
      </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function sendTenantMessage(landlordUserId) {
  try { _myLandlords = ((await apiFetch('/auth/me')).profile || {}).landlords || []; } catch (e) { alert(e.message); return; }
  if (!_myLandlords.length) { alert('Join a landlord first.'); return; }
  openModal('Message your landlord', `
    <div class="form-group"><label>To</label><select id="msg-to">
      ${_myLandlords.map(l => `<option value="${parseInt(l.landlord_user_id)}" ${l.landlord_user_id === landlordUserId ? 'selected' : ''}>${esc(l.landlord_name)}</option>`).join('')}</select></div>
    <div class="form-group"><label>Subject</label>
      <select id="msg-subject">${TENANT_SUBJECTS.map(s => `<option>${esc(s)}</option>`).join('')}</select></div>
    <div class="form-group"><label>Message</label><textarea id="msg-body" rows="4" placeholder="Describe your concern…"></textarea></div>
    <p class="err-msg" id="msg-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="doSendTenantMessage()">Send</button>`);
}
async function doSendTenantMessage() {
  const landlord_user_id = parseInt(document.getElementById('msg-to').value);
  const subject = document.getElementById('msg-subject').value;
  const body = document.getElementById('msg-body').value.trim();
  const errEl = document.getElementById('msg-err'); errEl.textContent = '';
  if (!body) { errEl.textContent = 'Please write a message'; return; }
  try {
    await apiFetch('/threads', { method: 'POST', body: JSON.stringify({ subject, body, landlord_user_id }) });
    closeModalDirect(); goPage('t-messages');
  } catch (e) { errEl.textContent = e.message; }
}

// ═══════════════════════════════════════════════
// SETTINGS (both roles)
// ═══════════════════════════════════════════════
function prefRowsHtml(rows, prefs) {
  return rows.map(row => `
    <div class="pref-row"><span class="pref-label">${esc(row.label)}</span>
      <label class="toggle"><input type="checkbox" ${prefs[row.key] || prefs[row.key] === undefined ? 'checked' : ''}
          onchange="saveSinglePref('${row.key}', this.checked)"/><span class="toggle-slider"></span></label></div>`).join('');
}
function showChangePassword() {
  openModal('Change Password', `
    <form onsubmit="event.preventDefault();submitChangePassword()">
      <div class="form-group"><label>Current Password</label><input type="password" id="m-cp-current" autocomplete="current-password"/></div>
      <div class="form-group"><label>New Password</label><input type="password" id="m-cp-new" autocomplete="new-password"/>
        <small class="hint">At least 8 characters with uppercase, lowercase, a number and a symbol.</small></div>
      <div class="form-group"><label>Confirm New Password</label><input type="password" id="m-cp-confirm" autocomplete="new-password"/></div>
      <button type="submit" hidden></button>
    </form>
    <p class="err-msg" id="m-cp-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" id="m-cp-btn" onclick="submitChangePassword()">Change Password</button>`);
}
async function submitChangePassword() {
  const v = id => document.getElementById(id).value;
  const errEl = document.getElementById('m-cp-err'); errEl.textContent = '';
  const pwErr = validatePasswordStrength(v('m-cp-new'));
  if (!v('m-cp-current')) { errEl.textContent = 'Enter your current password'; return; }
  if (pwErr) { errEl.textContent = pwErr; return; }
  if (v('m-cp-new') !== v('m-cp-confirm')) { errEl.textContent = 'New passwords do not match'; return; }
  const btn = document.getElementById('m-cp-btn'); btn.disabled = true;
  try {
    const d = await apiFetch('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: v('m-cp-current'), new_password: v('m-cp-new') }) });
    saveSession({ token: d.token, user: currentUser });   // this device stays signed in
    closeModalDirect();
    alert('✅ Password changed. You were signed out on your other devices.');
  } catch (e) { errEl.textContent = e.message; btn.disabled = false; }
}
async function signOutOthers() {
  if (!await confirmAction({ title: 'Sign out other devices?', message: 'All your other phones and computers are signed out. This device stays signed in.', okText: 'Sign Out Others', danger: false })) return;
  try {
    const d = await apiFetch('/auth/sign-out-others', { method: 'POST' });
    saveSession({ token: d.token, user: currentUser });
    alert('✅ Signed out on your other devices.');
  } catch (e) { alert(e.message); }
}
// ═══════════════════════════════════════════════
// GENERATE BILLS → MONTHLY RENT — pick a month, see who gets billed, then create the bills
// ═══════════════════════════════════════════════
let _rentMonth = null;   // { month, year }
async function loadGenerateRent() {
  const pg = document.getElementById('page-gen-rent'); pg.innerHTML = loadingHtml;
  const now = new Date();
  if (!_rentMonth) _rentMonth = { month: now.getMonth() + 1, year: now.getFullYear() };
  try {
    const d = await apiFetch(`/bills/monthly-preview?month=${_rentMonth.month}&year=${_rentMonth.year}`);
    const todo = d.contracts.filter(c => !c.billed && c.rent_billing);
    const monthOpts = [-1, 0, 1, 2].map(k => {
      const x = new Date(now.getFullYear(), now.getMonth() + k, 1);
      const m = x.getMonth() + 1, y = x.getFullYear();
      return `<option value="${y}-${m}" ${m === d.month && y === d.year ? 'selected' : ''}>${MONTHS[m - 1]} ${y}</option>`;
    }).join('');
    pg.innerHTML = `<div class="card">
        <div class="card-header"><h3>🏠 Monthly Rent</h3>
          <select class="month-select" onchange="const [y,m]=this.value.split('-');_rentMonth={year:+y,month:+m};loadGenerateRent()">${monthOpts}</select></div>
        <p class="muted-text">Creates the rent bill for each tenant below and notifies them. Due on <strong>${fmtDate(d.due_date + 'T00:00:00')}</strong>
          (day ${esc(d.rent_due_day)} — change it in <a href="#" onclick="event.preventDefault();goPage('l-settings')">Settings</a>).
          A month is never billed twice.</p>
      </div>
      <div class="card">
        ${!d.contracts.length ? '<div class="empty-state"><p>No active contracts for this month.</p></div>' : `
        <div class="rent-list">
          ${d.contracts.map(c => `<label class="rent-row ${c.billed || !c.rent_billing ? 'muted-row' : ''}">
              <input type="checkbox" class="rent-pick" value="${parseInt(c.contract_id)}" ${!c.billed && c.rent_billing ? 'checked' : 'disabled'} onchange="rentPickCount()"/>
              <span class="rent-who"><strong>${esc(c.tenant_name)}</strong><small class="muted-text">${esc(c.property_name)} · Unit ${esc(c.unit_number)}</small></span>
              <span class="rent-amt">₱${fmt(c.monthly_rent)}
                ${c.billed ? '<span class="badge badge-green">Billed</span>' : !c.rent_billing ? '<span class="badge badge-gray">Rent billing off</span>' : ''}</span>
            </label>`).join('')}
        </div>
        <div class="btn-group" style="margin-top:14px">
          <button class="btn btn-brand" id="rent-go" onclick="submitGenerateRent()" ${todo.length ? '' : 'disabled'}>⚡ Generate <span id="rent-count">${todo.length}</span> bill(s)</button>
          <button class="btn btn-outline" onclick="goPage('tenants')">View Tenants</button>
        </div>`}
      </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function rentPickCount() {
  const n = document.querySelectorAll('.rent-pick:checked').length;
  document.getElementById('rent-count').textContent = n;
  document.getElementById('rent-go').disabled = !n;
}
async function submitGenerateRent() {
  const ids = [...document.querySelectorAll('.rent-pick:checked')].map(cb => parseInt(cb.value));
  if (!ids.length) return;
  if (!await confirmAction({ title: `Create ${ids.length} rent bill(s)?`, message: `For ${MONTHS[_rentMonth.month - 1]} ${_rentMonth.year}. Tenants are notified right away.`, okText: 'Generate', danger: false })) return;
  try {
    const d = await apiFetch('/bills/generate-monthly', { method: 'POST', body: JSON.stringify({ ..._rentMonth, contract_ids: ids }) });
    alert(`✅ ${d.bills_generated} rent bill(s) created. Tenants were notified.`);
    loadGenerateRent();
  } catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// ACCOUNT — the person's own details, email, password, sign-out (both roles)
// ═══════════════════════════════════════════════
async function loadAccount() {
  const pg = document.getElementById('page-account'); pg.innerHTML = loadingHtml;
  try {
    const me = await apiFetch('/auth/me');
    currentUser = Object.assign({}, currentUser, me);
    const landlord = me.role === 'landlord';
    pg.innerHTML = `
      <div class="card"><div class="card-header"><h3>👤 Profile</h3></div>
        <div class="form-group"><label>Full Name</label><input type="text" id="acc-name" maxlength="150" value="${esc(me.full_name)}" autocomplete="name"/></div>
        <div class="form-group"><label>Phone</label><input type="tel" id="acc-phone" maxlength="30" value="${esc(me.phone || '')}" autocomplete="tel"/></div>
        ${landlord ? `<div class="form-group"><label>Business Name</label><input type="text" id="acc-biz" maxlength="255" value="${esc((me.profile || {}).business_name || '')}" autocomplete="organization"/>
          <small class="hint">Shown to tenants and on bills and receipts.</small></div>` : ''}
        <button class="btn btn-brand" onclick="saveAccount()">Save</button>
        <p class="small-msg" id="acc-msg"></p>
      </div>
      <div class="card"><div class="card-header"><h3>✉️ Email</h3></div>
        <div class="pref-row"><span class="pref-label">Sign-in email</span><strong class="break">${esc(me.email)}</strong></div>
        <button class="btn btn-outline" style="margin-top:12px" onclick="showChangeEmail()">Change Email Address</button>
      </div>
      <div class="card">
        <div class="card-header"><h3>🔒 Password &amp; Security</h3></div>
        <p class="muted-text">Changing your password signs you out on every other phone or computer.</p>
        <div class="btn-group" style="margin-top:12px">
          <button class="btn btn-brand" onclick="showChangePassword()">Change Password</button>
          <button class="btn btn-outline" onclick="signOutOthers()">Sign Out Other Devices</button>
        </div>
        <p class="hint" style="margin-top:10px">Forgot it? Sign out and tap <em>Forgot your password?</em> to get a reset link by email.</p>
      </div>
      <div class="card"><button class="btn btn-outline" onclick="logout()">Sign Out</button></div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function saveAccount() {
  const msg = document.getElementById('acc-msg');
  const body = { full_name: document.getElementById('acc-name').value.trim(), phone: document.getElementById('acc-phone').value.trim() };
  const biz = document.getElementById('acc-biz'); if (biz) body.business_name = biz.value.trim();
  try {
    await apiFetch('/auth/profile', { method: 'PATCH', body: JSON.stringify(body) });
    currentUser.full_name = body.full_name;
    localStorage.setItem('shiloh_user', JSON.stringify(currentUser));
    document.getElementById('sidebar-name').textContent = body.full_name;
    document.getElementById('sidebar-avatar').textContent = (body.full_name || 'U')[0].toUpperCase();
    msg.className = 'small-msg ok'; msg.textContent = '✅ Saved';
  } catch (e) { msg.className = 'small-msg bad'; msg.textContent = e.message; }
}

// ═══════════════════════════════════════════════
// BILLING & PLAN — the landlord's own Shiloh Living plan (charging is off until configured)
// ═══════════════════════════════════════════════
async function loadBillingPlan() {
  const pg = document.getElementById('page-billing'); pg.innerHTML = loadingHtml;
  try {
    const me = await apiFetch('/auth/me');
    const sub = (me.profile || {}).subscription || {};
    const days = n => `${esc(n)} day${n === 1 ? '' : 's'}`;
    let plan;
    if (!sub.enforced) plan = `<div class="plan-state"><span class="badge badge-green">Early access</span>
        <p>Shiloh Living is free while we're in early access — you won't be charged.</p>
        <p class="muted-text">When paid plans start, your plan, how to pay and your receipts will show up here. We'll tell you well before anything changes.</p></div>`;
    else if (sub.state === 'exempt') plan = `<div class="plan-state"><span class="badge badge-blue">Free forever</span><p>Your account is free — nothing to pay.</p></div>`;
    else if (sub.state === 'paid') plan = `<div class="plan-state"><span class="badge badge-green">Paid</span><p>Paid until <strong>${fmtDate(sub.paid_until)}</strong> (${days(sub.days_left)} left).</p></div>`;
    else if (sub.state === 'trial') plan = `<div class="plan-state"><span class="badge badge-yellow">Free trial</span><p><strong>${days(sub.days_left)} left</strong> — ends ${fmtDateTime(sub.trial_ends_at)}.</p></div>`;
    else plan = `<div class="plan-state"><span class="badge badge-red">Trial ended</span><p>You can still view everything, but changes are paused until you subscribe.</p></div>`;
    pg.innerHTML = `
      <div class="card"><div class="card-header"><h3>💳 Your Plan</h3></div>${plan}</div>
      ${sub.enforced && sub.state !== 'exempt' ? `<div class="card"><div class="card-header"><h3>How to pay</h3></div>
        <p>${esc(sub.pay_info)}</p>
        <button class="btn btn-brand" style="margin-top:10px" onclick="goPage('support')">💬 Send your payment screenshot to Support</button></div>` : ''}
      <div class="card"><div class="card-header"><h3>🧾 Payment History</h3></div>
        <div class="empty-state"><p>No payments yet.</p></div></div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}

// ═══════════════════════════════════════════════
// SETTINGS (landlord) — notifications, invite, rent due day, move-in checklist
// ═══════════════════════════════════════════════
const REQ_KIND = { document: '📎 Tenant uploads a file', info: '✍️ Tenant answers', landlord: '✔️ You tick it off' };
async function loadLandlordSettings() {
  const pg = document.getElementById('page-l-settings'); pg.innerHTML = loadingHtml;
  try {
    const [prefs, st, reqs, outReqs, rems] = await Promise.all([apiFetch('/notification-preferences'), apiFetch('/landlord/settings'),
      apiFetch('/landlord/requirements?phase=move_in'), apiFetch('/landlord/requirements?phase=move_out'), apiFetch('/reminders')]);
    _myRems = rems;
    pg.innerHTML = `
      ${pushCardHtml()}
      <div class="card"><div class="card-header"><h3>⏰ My Reminders</h3>
          <button class="btn btn-sm btn-brand" onclick="showAddReminder()">+ Add</button></div>
        <p class="muted-text">Reminders to yourself every month — a phone notification on the day (from 8 AM) and a note on your Dashboard.
          Reminders to tenants about their bills are on <a href="#" onclick="event.preventDefault();goPage('announcements')">Announcements &amp; Reminders</a>.</p>
        <div id="myrem-list">${myRemindersHtml()}</div>
        <span class="small-msg" id="myrem-msg"></span>
      </div>
      <div class="card"><div class="card-header"><h3>👋 Invite Tenants</h3></div>
        <p class="muted-text">Your join code, link and QR code. Make a new code there if the old one got shared too widely.</p>
        <button class="btn btn-brand" style="margin-top:10px" onclick="showLandlordInvite()">Open Invite</button></div>
      <div class="card"><div class="card-header"><h3>💰 Billing</h3></div>
        <div class="form-group" style="max-width:260px"><label>Rent is due on day</label>
          <input type="number" id="set-due-day" min="1" max="28" value="${esc(st.rent_due_day)}"/>
          <small class="hint">Of each month (1–28). Used by Generate Bills → Monthly Rent.</small></div>
        <button class="btn btn-brand" onclick="saveDueDay()">Save</button> <span class="small-msg" id="due-msg"></span>
      </div>
      <div class="card"><div class="card-header"><h3>📋 Move-in Checklist</h3>
          <button class="btn btn-sm btn-brand" onclick="editRequirement('move_in')">+ Add Item</button></div>
        <p class="muted-text">What every new tenant needs to give you or finish before moving in. Tenants see it in their app; you review it on their profile.</p>
        <div id="req-list-move_in">${requirementsHtml(reqs, 'move_in')}</div>
      </div>
      <div class="card"><div class="card-header"><h3>🚚 Move-out Checklist</h3>
          <button class="btn btn-sm btn-brand" onclick="editRequirement('move_out')">+ Add Item</button></div>
        <p class="muted-text">What you check off when a tenant leaves. It shows on their profile once you tap Move Out, with the deposit return.</p>
        <div id="req-list-move_out">${requirementsHtml(outReqs, 'move_out')}</div>
      </div>
      <div class="card"><div class="card-header"><h3>📧 Email Notifications</h3></div>
        ${prefRowsHtml([
          { key: 'email_tenant_message', label: 'Message received from a tenant' },
          { key: 'email_contract_acknowledged', label: 'Tenant acknowledges a signed contract' },
          { key: 'email_payment_submitted', label: 'Tenant submits a payment proof' },
          { key: 'email_new_tenant_joined', label: 'New tenant joins using your code' },
        ], prefs)}
        <div id="pref-save-msg" class="small-msg ok" style="display:none">✅ Saved</div>
      </div>
      ${supportCardHtml('support')}
      <p class="hint center">Your name, email and password are on the <a href="#" onclick="event.preventDefault();goPage('account')">Account</a> page.</p>`;
    window._reqs = { move_in: reqs, move_out: outReqs };
    wirePushCard();
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function requirementsHtml(reqs, phase) {
  return reqs.length ? reqs.map((r, i) => `<div class="req-row">
      <div class="req-main"><strong>${esc(r.label)}</strong> ${r.required ? '' : '<span class="badge badge-gray">Optional</span>'}
        <small class="muted-text">${phase === 'move_out' ? '' : REQ_KIND[r.kind]}${r.description ? (phase === 'move_out' ? '' : ' · ') + esc(r.description) : ''}</small></div>
      <div class="btn-group req-actions">
        <button class="btn btn-sm btn-outline" title="Move up" onclick="moveRequirement('${phase}',${parseInt(r.id)},-1)" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-sm btn-outline" title="Move down" onclick="moveRequirement('${phase}',${parseInt(r.id)},1)" ${i === reqs.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn-sm btn-outline" onclick="editRequirement('${phase}',${parseInt(r.id)})">Edit</button>
        <button class="btn btn-sm btn-red" onclick="removeRequirement('${phase}',${parseInt(r.id)})">Remove</button>
      </div></div>`).join('') : '<p class="muted-text">No items. Tap “+ Add Item”.</p>';
}
async function reloadRequirements(phase) {
  window._reqs[phase] = await apiFetch('/landlord/requirements?phase=' + phase);
  document.getElementById('req-list-' + phase).innerHTML = requirementsHtml(window._reqs[phase], phase);
}
function editRequirement(phase, id) {
  const r = ((window._reqs || {})[phase] || []).find(x => x.id === id) || { kind: phase === 'move_out' ? 'landlord' : 'document', required: 1 };
  openModal(id ? 'Edit Checklist Item' : `Add ${phase === 'move_out' ? 'Move-out' : 'Move-in'} Item`, `
    <div class="form-group"><label>${phase === 'move_out' ? 'What to check' : 'What you need'}</label><input type="text" id="rq-label" maxlength="255" value="${esc(r.label || '')}"
      placeholder="${phase === 'move_out' ? 'e.g. Keys returned' : 'e.g. Valid government ID'}"/></div>
    <div class="form-group"><label>Details (optional)</label><input type="text" id="rq-desc" maxlength="500" value="${esc(r.description || '')}"/></div>
    ${phase === 'move_out' ? '' : `<div class="form-group"><label>How it's done</label><select id="rq-kind">
      ${Object.entries(REQ_KIND).map(([k, l]) => `<option value="${k}" ${r.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`}
    <div class="form-group check-box"><label><input type="checkbox" id="rq-req" ${r.required ? 'checked' : ''}/> <span>Required</span></label></div>
    <p class="err-msg" id="rq-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="saveRequirement('${phase}',${id ? parseInt(id) : 'null'})">Save</button>`);
}
async function saveRequirement(phase, id) {
  const kind = document.getElementById('rq-kind');
  const body = { label: document.getElementById('rq-label').value.trim(), description: document.getElementById('rq-desc').value.trim(),
    required: document.getElementById('rq-req').checked, phase };
  if (kind) body.kind = kind.value;
  try {
    await apiFetch(id ? `/landlord/requirements/${id}` : '/landlord/requirements', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    closeModalDirect(); reloadRequirements(phase);
  } catch (e) { document.getElementById('rq-err').textContent = e.message; }
}
async function moveRequirement(phase, id, dir) {
  try { await apiFetch(`/landlord/requirements/${id}`, { method: 'PATCH', body: JSON.stringify({ move: dir }) }); reloadRequirements(phase); }
  catch (e) { alert(e.message); }
}
async function removeRequirement(phase, id) {
  if (!await confirmAction({ title: 'Remove this checklist item?', message: phase === 'move_out' ? 'It won\'t be on future move-outs. Past move-outs keep their records.'
      : 'New tenants won\'t be asked for it. Tenants who already sent it keep their records.', okText: 'Remove' })) return;
  try { await apiFetch(`/landlord/requirements/${id}`, { method: 'DELETE' }); reloadRequirements(phase); }
  catch (e) { alert(e.message); }
}
async function saveDueDay() {
  const msg = document.getElementById('due-msg');
  try {
    await apiFetch('/landlord/settings', { method: 'PATCH', body: JSON.stringify({ rent_due_day: document.getElementById('set-due-day').value }) });
    msg.className = 'small-msg ok'; msg.textContent = '✅ Saved';
  } catch (e) { msg.className = 'small-msg bad'; msg.textContent = e.message; }
}

// ═══════════════════════════════════════════════
// SETTINGS (tenant)
// ═══════════════════════════════════════════════
async function loadTenantSettings() {
  const pg = document.getElementById('page-t-settings'); pg.innerHTML = loadingHtml;
  try {
    const prefs = await apiFetch('/notification-preferences');
    pg.innerHTML = `
      ${pushCardHtml()}
      <div class="card"><div class="card-header"><h3>🔑 Join Another Landlord</h3></div>
        <p class="muted-text">Renting from more than one landlord? Enter the new landlord's join code.</p>
        <button class="btn btn-brand" style="margin-top:10px" onclick="showJoinLandlord()">Enter a Join Code</button></div>
      <div class="card"><div class="card-header"><h3>📧 Email Notifications</h3></div>
        ${prefRowsHtml([
          { key: 'email_new_bill', label: 'New bill created' },
          { key: 'email_payment_approved', label: 'Payment approved' },
          { key: 'email_payment_rejected', label: 'Payment rejected' },
          { key: 'email_new_announcement', label: 'New announcement from landlord' },
          { key: 'email_contract_uploaded', label: 'Signed contract uploaded' },
          { key: 'email_new_message', label: 'New message from landlord' },
          { key: 'email_ticket_reply', label: 'Support ticket reply' },
        ], prefs)}
        <div id="pref-save-msg" class="small-msg ok" style="display:none">✅ Saved</div>
      </div>
      ${supportCardHtml('t-support')}
      <p class="hint center">Your name, email and password are on the <a href="#" onclick="event.preventDefault();goPage('account')">Account</a> page.</p>`;
    wirePushCard();
  } catch (e) { pg.innerHTML = errHtml(e); }
}

// ═══════════════════════════════════════════════
// MOVE-IN CHECKLIST — tenant side
// ═══════════════════════════════════════════════
const REQ_STATUS = { pending: ['To do', 'gray'], submitted: ['Sent — waiting for review', 'yellow'], approved: ['Done', 'green'],
  rejected: ['Please redo', 'red'], waived: ['Not needed', 'blue'] };
const reqBadge = s => `<span class="badge badge-${REQ_STATUS[s][1]}">${REQ_STATUS[s][0]}</span>`;
const progressBar = (done, total) => `<div class="progress"><span style="width:${total ? Math.round(100 * done / total) : 100}%"></span></div>
  <div class="muted-text small">${done} of ${total} required item${total === 1 ? '' : 's'} done</div>`;
async function loadTenantChecklist() {
  const pg = document.getElementById('page-t-checklist'); pg.innerHTML = loadingHtml;
  try {
    const lists = await apiFetch('/tenant/checklist');
    pg.innerHTML = !lists.length ? '<div class="card"><div class="empty-state"><p>Join a landlord to see their move-in checklist.</p></div></div>'
      : lists.map(l => `<div class="card">
        <div class="card-header"><h3>📋 ${esc(l.landlord)}</h3></div>
        ${progressBar(l.done, l.total)}
        ${l.items.map(i => {
          const open = i.status !== 'approved' && i.status !== 'waived';
          return `<div class="record">
            <div class="record-top"><strong>${esc(i.label)}${i.required ? '' : ' <span class="muted-text small">(optional)</span>'}</strong>${reqBadge(i.status)}</div>
            ${i.description ? `<div class="record-meta">${esc(i.description)}</div>` : ''}
            ${i.status === 'rejected' && i.note ? `<div class="warn-box">Your landlord: ${esc(i.note)}</div>` : ''}
            ${i.kind === 'document' ? `<div class="btn-group" style="margin-top:8px">
                ${i.file_url ? `<button class="btn btn-sm btn-outline" onclick="openDoc(${jsArg(i.file_url)})">📄 View what you sent</button>` : ''}
                ${open ? `<button class="btn btn-sm btn-brand" onclick="sendChecklistFile(${parseInt(i.id)}, this)">📎 ${i.file_url ? 'Send a new file' : 'Upload'}</button>` : ''}
              </div>`
            : i.kind === 'info' ? (open ? `<textarea id="ans-${parseInt(i.id)}" rows="2" style="margin-top:8px" placeholder="Type here…">${esc(i.answer || '')}</textarea>
                <button class="btn btn-sm btn-brand" style="margin-top:6px" onclick="sendChecklistAnswer(${parseInt(i.id)})">Send</button>`
                : `<div class="record-meta" style="white-space:pre-wrap">${esc(i.answer || '')}</div>`)
            : `<div class="record-meta">Your landlord checks this one off${i.file_url ? ` · <a href="#" onclick="event.preventDefault();openDoc(${jsArg(i.file_url)})">view</a>` : ''}.</div>`}
          </div>`; }).join('')}
      </div>`).join('');
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function sendChecklistFile(rid, btn) {
  try {
    const up = await uploadFile('tenant_document', UPLOAD_ACCEPT, btn);
    if (!up) return;
    await apiFetch(`/tenant/checklist/${rid}`, { method: 'POST', body: JSON.stringify({ file_url: up.url }) });
    loadTenantChecklist();
  } catch (e) { alert(e.message); loadTenantChecklist(); }
}
async function sendChecklistAnswer(rid) {
  const answer = document.getElementById('ans-' + rid).value.trim();
  if (!answer) { alert('Please fill this in first.'); return; }
  try { await apiFetch(`/tenant/checklist/${rid}`, { method: 'POST', body: JSON.stringify({ answer }) }); loadTenantChecklist(); }
  catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// MOVE-IN CHECKLIST — landlord reviews it on the tenant's profile
// ═══════════════════════════════════════════════
function checklistReviewHtml() {
  const cl = _profile.data.checklist;
  if (!cl) return '<p class="muted-text">—</p>';
  const tp = parseInt(_profile.data.tenant.tenant_id);
  const current = !!_profile.data.tenant.is_active;
  return progressBar(cl.done, cl.total) + cl.items.map(i => {
    const id = parseInt(i.id);
    const act = (s, label, cls) => `<button class="btn btn-sm ${cls}" onclick="reviewChecklist(${tp},${id},'${s}')">${label}</button>`;
    let actions = '';
    if (current) {
      if (i.kind === 'landlord') actions = i.status === 'approved' ? act('pending', 'Undo', 'btn-outline')
        : act('approved', '✓ Mark done', 'btn-green') + `<button class="btn btn-sm btn-outline" onclick="checklistPhoto(${tp},${id},this)">📎 Add photo/file &amp; mark done</button>` + act('waived', 'Not needed', 'btn-outline');
      else if (i.status === 'submitted') actions = act('approved', '✓ Approve', 'btn-green') + act('rejected', 'Ask to redo', 'btn-warn') + act('waived', 'Not needed', 'btn-outline');
      else if (i.status === 'pending' || i.status === 'rejected') actions = act('waived', 'Not needed', 'btn-outline');
      else actions = act('pending', 'Undo', 'btn-outline');
    }
    return `<div class="record">
      <div class="record-top"><strong>${esc(i.label)}${i.required ? '' : ' <span class="muted-text small">(optional)</span>'}</strong>${reqBadge(i.status)}</div>
      <div class="record-meta">${REQ_KIND[i.kind]}${i.submitted_at ? ' · sent ' + fmtDateTime(i.submitted_at) : ''}${i.reviewed_at ? ' · reviewed ' + fmtDateTime(i.reviewed_at) : ''}
        ${i.note ? `<br>Note: ${esc(i.note)}` : ''}</div>
      ${i.answer ? `<div class="answer-box">${esc(i.answer)}</div>` : ''}
      <div class="btn-group" style="margin-top:6px">
        ${i.file_url ? `<button class="btn btn-sm btn-outline" onclick="openDoc(${jsArg(i.file_url)})">📄 View file</button>` : ''}${actions}</div>
    </div>`;
  }).join('');
}
async function refreshProfileChecklist(tp) {
  _profile.data.checklist = await apiFetch(`/landlord/tenants/${tp}/checklist`);
  document.getElementById('ps-checklist').innerHTML = checklistReviewHtml();
  const head = document.querySelector('#ps-checklist')?.closest('details')?.querySelector('h3 .muted-text');
  if (head) head.textContent = `(${_profile.data.checklist.done}/${_profile.data.checklist.total})`;
}
async function reviewChecklist(tp, rid, status) {
  let note = '';
  if (status === 'rejected') {
    note = prompt('What should the tenant fix or send again?', '');
    if (note === null) return;
  }
  try { await apiFetch(`/landlord/tenants/${tp}/checklist/${rid}`, { method: 'PATCH', body: JSON.stringify({ status, note }) }); refreshProfileChecklist(tp); }
  catch (e) { alert(e.message); }
}
async function checklistPhoto(tp, rid, btn) {
  try {
    const up = await uploadFile('onboarding_photo', UPLOAD_ACCEPT, btn);
    if (!up) return;
    await apiFetch(`/landlord/tenants/${tp}/checklist/${rid}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved', file_url: up.url }) });
    refreshProfileChecklist(tp);
  } catch (e) { alert(e.message); }
}

async function saveSinglePref(key, value) {
  try {
    await apiFetch('/notification-preferences', { method: 'PATCH', body: JSON.stringify({ [key]: value ? 1 : 0 }) });
    const msg = document.getElementById('pref-save-msg');
    if (msg) { msg.style.display = 'block'; setTimeout(() => msg.style.display = 'none', 2000); }
  } catch (e) { alert('Failed to save: ' + e.message); }
}

// ═══════════════════════════════════════════════
// CHANGE EMAIL
// ═══════════════════════════════════════════════
function showChangeEmail() {
  openModal('Change Email Address', `
    <div class="info-box">Enter your new email. We'll send a verification link before updating.</div>
    <div class="form-group"><label>New Email Address</label><input type="email" id="m-ce-email"/></div>
    <div class="form-group"><label>Current Password (to confirm)</label><input type="password" id="m-ce-pass" autocomplete="current-password"/></div>
    <p class="err-msg" id="m-ce-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitChangeEmail()">Send Verification</button>`);
}
async function submitChangeEmail() {
  const email = document.getElementById('m-ce-email').value.trim();
  const password = document.getElementById('m-ce-pass').value;
  const errEl = document.getElementById('m-ce-err'); errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Both fields required'; return; }
  try { const d = await apiFetch('/auth/change-email', { method: 'POST', body: JSON.stringify({ email, password }) }); closeModalDirect(); alert('✅ ' + (d.message || 'Verification email sent.')); }
  catch (e) { errEl.textContent = e.message; }
}

// ═══════════════════════════════════════════════
// ADMIN PAGES
// ═══════════════════════════════════════════════
async function loadAdminStats() {
  const pg = document.getElementById('page-admin-stats'); pg.innerHTML = loadingHtml;
  try {
    const s = await apiFetch('/admin/stats');
    const st = (v, l) => `<div class="stat-card"><div class="value">${esc(v)}</div><div class="label">${l}</div></div>`;
    pg.innerHTML = `<div class="stats-grid">
      ${st(s.total_landlords, 'Landlords')}${st(s.total_tenants, 'Tenants')}${st(s.total_properties, 'Properties')}
      ${st(s.total_units, 'Units')}${st(s.active_contracts, 'Active Contracts')}${st(s.pending_payments, 'Pending Payments')}
      ${st(s.open_tickets, 'Open Tickets')}</div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function adminUserActions(r, role) {
  const id = parseInt(r.id);
  return `<div class="btn-group"><button class="btn btn-sm btn-info" onclick="adminEditUser(${id},'${role}')">✏️ Edit</button>
    ${r.is_active ? `<button class="btn btn-sm btn-warn" onclick="adminToggleUser(${id},'suspend','${role}')">Suspend</button>`
      : `<button class="btn btn-sm btn-green" onclick="adminToggleUser(${id},'activate','${role}')">Activate</button>`}
    <button class="btn btn-sm btn-red" onclick="adminDeleteUser(${id})">Delete</button></div>`;
}
async function loadAdminLandlords() {
  const pg = document.getElementById('page-admin-landlords'); pg.innerHTML = loadingHtml;
  try {
    const rows = await apiFetch('/admin/landlords');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Landlords (${rows.length})</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Code</th><th>Props</th><th>Tenants</th><th>Plan</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td><strong>${esc(r.full_name)}</strong><br><small class="muted-text">${esc(r.business_name || '')}</small></td>
        <td style="font-size:12px">${esc(r.email)}</td><td><code>${esc(r.landlord_code)}</code></td>
        <td>${esc(r.properties)}</td><td>${esc(r.tenants)}</td>
        <td>${planLabel(r.plan)}<br><button class="btn btn-sm btn-outline" style="margin-top:4px" onclick="adminEditPlan(${parseInt(r.id)}, ${jsArg(r.full_name)}, ${jsArg(r.plan)})">Change</button></td>
        <td>${r.is_active ? badge('active') : badge('suspended')}</td><td>${adminUserActions(r, 'landlord')}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function planLabel(p) {
  if (!p) return '—';
  const cls = { exempt: 'blue', paid: 'green', trial: 'yellow', expired: 'red' }[p.state] || 'gray';
  const name = { exempt: 'free', paid: 'paid', trial: 'trial', expired: 'trial ended' }[p.state] || p.state;
  const when = p.state === 'paid' ? ` to ${fmtDate(p.paid_until)}` : p.state === 'trial' ? ` · ${p.days_left}d left` : '';
  return `<span class="badge badge-${cls}">${esc(name + when)}</span>`;
}
function adminEditPlan(uid, name, plan) {
  plan = plan || {};
  openModal('Plan: ' + name, `
    <p class="muted-text" style="margin-bottom:10px">Now: ${planLabel(plan)}</p>
    <div class="form-group"><label>Paid until</label>
      <input type="date" id="ap-paid" value="${esc((plan.paid_until || '').slice(0, 10))}"/>
      <small class="hint">After they pay you, set the last day their payment covers. Clear it to remove.</small></div>
    <div class="form-group"><label>Give more trial days</label>
      <input type="number" id="ap-extend" min="0" max="365" placeholder="e.g. 7"/></div>
    <div class="form-group"><label><input type="checkbox" id="ap-exempt" ${plan.state === 'exempt' ? 'checked' : ''}/> Free forever (family, friends, early testers)</label></div>
    <p class="err-msg" id="ap-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitAdminPlan(${parseInt(uid)})">Save</button>`);
}
async function submitAdminPlan(uid) {
  const errEl = document.getElementById('ap-err'); errEl.textContent = '';
  const body = {
    paid_until: document.getElementById('ap-paid').value || null,
    billing_exempt: document.getElementById('ap-exempt').checked,
  };
  const extend = parseInt(document.getElementById('ap-extend').value);
  if (extend > 0) body.extend_trial_days = extend;
  try {
    await apiFetch('/admin/landlords/' + uid + '/subscription', { method: 'PATCH', body: JSON.stringify(body) });
    closeModalDirect(); loadAdminLandlords();
  } catch (e) { errEl.textContent = e.message; }
}

async function loadAdminInvites() {
  const pg = document.getElementById('page-admin-invites'); pg.innerHTML = loadingHtml;
  try {
    const rows = await apiFetch('/admin/invites');
    const status = r => r.used_at ? `<span class="badge badge-green">used</span><br><small>${esc(r.used_by_name || '')} ${esc(r.used_by_email || '')}</small>`
      : r.revoked_at ? badge('revoked') : badge('open');
    const link = code => location.origin + '/invite/' + code;
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Invite a landlord</h3></div>
      <div class="info-box">Landlord sign-up is invite-only. Each code works once. "Free forever" skips the trial clock — use it for family and early testers.</div>
      <div class="grid-2">
        <div class="form-group"><label>Email (optional — only this email can use it)</label><input type="email" id="inv-email"/></div>
        <div class="form-group"><label>Note (who it's for)</label><input type="text" id="inv-note" maxlength="255" placeholder="e.g. Mom"/></div>
      </div>
      <div class="form-group"><label><input type="checkbox" id="inv-free"/> Free forever</label>
        <label style="margin-left:16px"><input type="checkbox" id="inv-send"/> Email them the link</label></div>
      <button class="btn btn-brand" onclick="createInvite()">Create Invite</button>
      <p class="err-msg" id="inv-err"></p>
    </div>
    <div class="card"><div class="card-header"><h3>Invites (${rows.length})</h3></div>
      ${!rows.length ? '<div class="empty-state"><p>No invites yet</p></div>' : `
      <div class="table-wrap"><table><thead><tr><th>Code</th><th>For</th><th>Plan</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td><code>${esc(r.code)}</code></td>
        <td>${esc(r.note || '')}<br><small class="muted-text">${esc(r.email || 'any email')}</small></td>
        <td>${r.free_forever ? '<span class="badge badge-blue">free forever</span>' : '<span class="badge badge-yellow">trial</span>'}</td>
        <td>${status(r)}</td>
        <td>${r.used_at || r.revoked_at ? '' : `<div class="btn-group">
          <button class="btn btn-sm btn-outline" onclick="copyText(${jsArg(link(r.code))}, 'Invite link copied!')">📋 Copy Link</button>
          <button class="btn btn-sm btn-red" onclick="revokeInvite(${parseInt(r.id)})">Revoke</button></div>`}</td></tr>`).join('')}
      </tbody></table></div>`}</div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function createInvite() {
  const errEl = document.getElementById('inv-err'); errEl.textContent = '';
  const body = {
    email: document.getElementById('inv-email').value.trim(),
    note: document.getElementById('inv-note').value.trim(),
    free_forever: document.getElementById('inv-free').checked,
    send_email: document.getElementById('inv-send').checked,
  };
  try {
    const d = await apiFetch('/admin/invites', { method: 'POST', body: JSON.stringify(body) });
    await copyText(d.link, `Invite ${d.code} created — link copied!${d.emailed ? ' Email sent.' : ''}`);
    loadAdminInvites();
  } catch (e) { errEl.textContent = e.message; }
}
async function revokeInvite(id) {
  if (!await confirmAction({ title: 'Revoke this invite?', message: 'The code will stop working.', okText: 'Revoke' })) return;
  try { await apiFetch('/admin/invites/' + id, { method: 'DELETE' }); } catch (e) { alert(e.message); }
  loadAdminInvites();
}
async function loadAdminTenants() {
  const pg = document.getElementById('page-admin-tenants'); pg.innerHTML = loadingHtml;
  try {
    const rows = await apiFetch('/admin/tenants');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Tenants (${rows.length})</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Landlords</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td><strong>${esc(r.full_name)}</strong></td><td style="font-size:12px">${esc(r.email)}</td>
        <td style="font-size:12px">${esc(r.landlord_names || '—')} <span class="badge badge-blue">${esc(r.landlord_count)}</span></td>
        <td>${r.is_active ? badge('active') : badge('suspended')}</td><td>${adminUserActions(r, 'tenant')}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function adminToggleUser(id, action, role) {
  if (!await confirmAction({ title: `${action === 'suspend' ? 'Suspend' : 'Activate'} this user?`, message: action === 'suspend' ? 'They can\'t sign in until activated again.' : '', okText: action === 'suspend' ? 'Suspend' : 'Activate', danger: action === 'suspend' })) return;
  try { await apiFetch('/admin/users/' + id + '/' + action, { method: 'PATCH' }); } catch (e) { alert(e.message); }
  if (role === 'landlord') loadAdminLandlords(); else loadAdminTenants();
}
async function loadAdminTickets() {
  const pg = document.getElementById('page-admin-tickets'); pg.innerHTML = loadingHtml;
  try {
    const tickets = await apiFetch('/tickets');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Support Tickets</h3></div>
      ${!tickets.length ? '<div class="empty-state"><div class="icon">🎫</div><p>No tickets yet</p></div>' : ticketListHtml(tickets, true)}</div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function loadAdminChat() {
  const pg = document.getElementById('page-admin-chat'); pg.innerHTML = loadingHtml;
  try {
    const chats = await apiFetch('/support-chat');
    const open = chats.filter(c => c.status === 'open');
    const other = chats.filter(c => c.status !== 'open');
    const item = c => `<div class="thread-list-item ${c.unread_count > 0 ? 'unread' : ''}" onclick="openAdminChat(${parseInt(c.id)})">
        <div class="thread-avatar">${esc((c.user_name || '?')[0].toUpperCase())}</div>
        <div class="thread-info">
          <div class="tname">${esc(c.user_name)} <span class="badge badge-gray">${esc(c.user_role)}</span> ${c.status !== 'open' ? badge(c.status) : ''} ${c.unread_count > 0 ? `<span class="badge badge-red">${parseInt(c.unread_count)}</span>` : ''}</div>
          <div class="tsubject"><strong>${esc(c.subject)}</strong></div>
          <div class="tlast">${esc((c.last_message || '').substring(0, 80))}</div>
        </div>
        <div class="thread-time">${fmtDate(c.last_message_at)}</div></div>`;
    pg.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="value">${open.length}</div><div class="label">Open Chats</div></div>
        <div class="stat-card"><div class="value">${chats.reduce((s, c) => s + (Number(c.unread_count) || 0), 0)}</div><div class="label">Unread</div></div>
      </div>
      ${!chats.length ? '<div class="card"><div class="empty-state"><div class="icon">💬</div><p>No support chats yet</p></div></div>' : ''}
      ${open.length ? `<div class="card"><div class="card-header"><h3>🟢 Open Chats</h3></div>${open.map(item).join('')}</div>` : ''}
      ${other.length ? `<div class="card"><div class="card-header"><h3>Closed / Converted</h3></div>${other.map(item).join('')}</div>` : ''}`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function openAdminChat(chatId) { showView('admin-chat', () => adminOpenChat(chatId), 'chat/' + chatId); }
async function adminOpenChat(chatId) {
  const pg = document.getElementById('page-admin-chat'); pg.innerHTML = loadingHtml;
  try {
    const d = await apiFetch('/support-chat/' + chatId);
    const chat = d.chat; const msgs = d.messages || []; const closed = chat.status !== 'open';
    pg.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div><h3>💬 ${esc(chat.subject)}</h3><div class="muted-text" style="margin-top:2px">From: <strong>${esc(chat.user_name)}</strong> (${esc(chat.user_email)}) ${badge(chat.status)}</div></div>
          <div class="btn-group">
            ${!closed ? `<button class="btn btn-sm btn-warn" onclick="showConvertToTicket(${parseInt(chatId)})">→ Make Ticket</button>
            <button class="btn btn-sm btn-red" onclick="adminCloseChat(${parseInt(chatId)})">Close Chat</button>` : ''}
          </div>
        </div>
        <div class="chat-wrap" id="admin-chat-wrap">${chatBubbles(msgs, true)}</div>
        ${!closed ? `<div class="chat-compose">
          <textarea id="admin-reply-body" rows="2" placeholder="Type your reply…"></textarea>
          <button class="btn btn-brand" onclick="adminSendChatReply(${parseInt(chatId)})">Send</button>
        </div>` : `<div class="info-box" style="margin-top:10px">This chat is ${esc(chat.status)}.</div>`}
      </div>`;
    setTimeout(() => { const w = document.getElementById('admin-chat-wrap'); if (w) w.scrollTop = w.scrollHeight; }, 50);
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function adminSendChatReply(chatId) {
  const body = document.getElementById('admin-reply-body').value.trim();
  if (!body) return;
  try { await apiFetch('/support-chat/' + chatId + '/reply', { method: 'POST', body: JSON.stringify({ body }) }); adminOpenChat(chatId); }
  catch (e) { alert(e.message); }
}
function showConvertToTicket(chatId) {
  openModal('Convert to Support Ticket', `
    <div class="info-box">This will create a formal ticket from this chat conversation.</div>
    <div class="form-group"><label>Category</label><select id="m-ct-cat">
      <option value="billing">Billing</option><option value="technical">Technical</option>
      <option value="account">Account</option><option value="contract">Contract</option><option value="other">Other</option></select></div>
    <div class="form-group"><label>Priority</label><select id="m-ct-pri">
      <option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></div>
    <p class="err-msg" id="m-ct-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitConvertToTicket(${parseInt(chatId)})">Convert</button>`);
}
async function submitConvertToTicket(chatId) {
  try {
    const d = await apiFetch('/support-chat/' + chatId + '/convert-ticket', { method: 'POST', body: JSON.stringify({ category: document.getElementById('m-ct-cat').value, priority: document.getElementById('m-ct-pri').value }) });
    closeModalDirect(); alert('✅ Converted to ticket #' + d.ticket_id); loadAdminChat();
  } catch (e) { document.getElementById('m-ct-err').textContent = e.message; }
}
async function adminCloseChat(chatId) {
  if (!await confirmAction({ title: 'Close this chat?', okText: 'Close Chat', danger: false })) return;
  try { await apiFetch('/support-chat/' + chatId + '/close', { method: 'PATCH' }); loadAdminChat(); }
  catch (e) { alert(e.message); }
}
async function loadAdminAudit() {
  const pg = document.getElementById('page-admin-audit'); pg.innerHTML = loadingHtml;
  try {
    const logs = await apiFetch('/admin/audit-logs');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Audit Log</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Action</th><th>User</th><th>Description</th><th>IP</th><th>Time</th></tr></thead><tbody>
      ${logs.map(l => `<tr><td><code>${esc(l.action)}</code></td><td style="font-size:12px">${esc(l.email || 'system')}</td>
        <td style="font-size:12px" class="clip">${esc(l.description || '—')}</td>
        <td style="font-size:11px" class="muted-text">${esc(l.ip_address || '—')}</td>
        <td style="font-size:11px" class="muted-text">${fmtDateTime(l.created_at)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function adminEditUser(uid, role) {
  try {
    const d = await apiFetch('/admin/users/' + uid);
    const u = d.user;
    openModal(`Edit ${role === 'landlord' ? 'Landlord' : 'Tenant'}: ${u.full_name}`, `
      <div class="grid-2">
        <div class="form-group"><label>Full Name</label><input type="text" id="ae-name" value="${esc(u.full_name || '')}"/></div>
        <div class="form-group"><label>Email</label><input type="email" id="ae-email" value="${esc(u.email || '')}"/></div>
      </div>
      <div class="form-group"><label>Phone</label><input type="text" id="ae-phone" value="${esc(u.phone || '')}"/></div>
      <div class="grid-2">
        <div class="form-group"><label>Account Status</label>
          <select id="ae-active"><option value="1" ${u.is_active ? 'selected' : ''}>Active</option><option value="0" ${!u.is_active ? 'selected' : ''}>Suspended</option></select></div>
        <div class="form-group"><label>Email Verified</label>
          <select id="ae-verified"><option value="1" ${u.email_verified ? 'selected' : ''}>Verified</option><option value="0" ${!u.email_verified ? 'selected' : ''}>Not Verified</option></select></div>
      </div>
      <div class="form-group"><label>New Password (leave blank to keep current)</label><input type="password" id="ae-password" autocomplete="new-password"/></div>
      <p class="err-msg" id="ae-err"></p>`,
      `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
       <button class="btn btn-brand" onclick="submitAdminEditUser(${parseInt(uid)},'${role === 'landlord' ? 'landlord' : 'tenant'}')">Save Changes</button>`);
  } catch (e) { alert('Could not load user: ' + e.message); }
}
async function submitAdminEditUser(uid, role) {
  const v = id => document.getElementById(id).value;
  const errEl = document.getElementById('ae-err'); errEl.textContent = '';
  const full_name = v('ae-name').trim(), email = v('ae-email').trim(), password = v('ae-password');
  if (!full_name || !email) { errEl.textContent = 'Name and email required'; return; }
  if (password) { const pwErr = validatePasswordStrength(password); if (pwErr) { errEl.textContent = pwErr; return; } }
  try {
    await apiFetch('/admin/users/' + uid, { method: 'PATCH', body: JSON.stringify({ full_name, email, phone: v('ae-phone').trim(), is_active: parseInt(v('ae-active')), email_verified: parseInt(v('ae-verified')) }) });
    if (password) await apiFetch('/admin/users/' + uid + '/reset-password', { method: 'POST', body: JSON.stringify({ password }) });
    closeModalDirect();
    if (role === 'landlord') loadAdminLandlords(); else loadAdminTenants();
  } catch (e) { errEl.textContent = e.message; }
}

// ═══════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════
(async function boot() {
  const params = new URLSearchParams(location.search);
  const linkType = params.get('type');   // 'verify' or 'reset' (links in emails)
  const linkToken = params.get('token');

  if (linkType === 'verify' && linkToken) {
    history.replaceState(null, '', '/');
    authCard('<div class="center" style="padding:20px 0"><div style="font-size:40px;margin-bottom:12px">⏳</div><p class="muted-text">Verifying your email…</p></div>');
    try {
      const r = await fetch('/api/auth/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: linkToken }) });
      const d = await r.json();
      if (d.status === 'ok') {
        if (token && currentUser) { initApp(); return; }
        showLogin('Email verified! You can now sign in.');
      } else {
        authCard(`<div class="center" style="padding:20px 0"><div style="font-size:48px;margin-bottom:12px">❌</div>
          <h2 style="color:var(--danger);margin-bottom:10px">Verification Failed</h2>
          <p class="muted-text" style="margin-bottom:20px">${esc(d.message || 'Invalid or expired link.')}</p>
          <button class="btn-primary" onclick="showLogin()">Back to Sign In</button></div>`);
      }
    } catch (_) { showLogin(); }
    return;
  }
  if (linkType === 'reset' && linkToken) {
    history.replaceState(null, '', '/');
    showResetPasswordScreen(linkToken);
    return;
  }

  if (token && currentUser) { initApp(); return; }

  // A landlord invite link opened while signed out: straight to landlord sign-up, code filled in
  if (PENDING_INVITE_CODE || PENDING_LANDLORD_SIGNUP) { showLandlordRegister(); return; }

  // A tenant join link / QR opened while signed out: show who it's for, then sign up
  if (PENDING_JOIN_CODE) {
    authCard(loadingHtml);
    if (await lookupJoinCode(PENDING_JOIN_CODE)) showTenantRegister();
    return;
  }
  showLogin();
})();
