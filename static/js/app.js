// ═══════════════════════════════════════════════
// GLOBALS & API
// ═══════════════════════════════════════════════
const API = '/api';
const CLOUDINARY_CLOUD = 'dyyi3mtm0';
const CLOUDINARY_PRESET = 'UploadPresetShiloh';

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
  if (!res.ok) throw new Error(json.message || 'Request failed');
  return json.data !== undefined ? json.data : json;
}

// ═══════════════════════════════════════════════
// ENTRY LINKS — /join/CODE (tenant join link / QR), old ?register=tenant&code=X links,
// and ?open=page from a tapped phone notification
// ═══════════════════════════════════════════════
let PENDING_JOIN_CODE = null;
let PENDING_OPEN_PAGE = null;
(function captureEntryIntent() {
  const params = new URLSearchParams(location.search);
  const m = location.pathname.match(/^\/join\/([A-Za-z0-9]{8})\/?$/);
  if (m) PENDING_JOIN_CODE = m[1].toUpperCase();
  else if (params.get('register') === 'tenant' && params.get('code')) PENDING_JOIN_CODE = params.get('code').toUpperCase();
  if (params.get('open')) PENDING_OPEN_PAGE = params.get('open');
  if (params.get('notif')) apiFetchQuiet('/notifications/' + parseInt(params.get('notif')) + '/read', { method: 'PATCH' });
  if (m || params.get('register') || params.get('open') || params.get('source')) history.replaceState(null, '', '/');
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
  const what = info.property_name ? `<strong>${esc(info.property_name)}</strong><br><span>by ${esc(info.business_name || info.landlord_name)}</span>`
    : `<strong>${esc(info.business_name || info.landlord_name)}</strong>`;
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
    <button class="btn-secondary" onclick="showJoinCode()">🔑 I'm a tenant — I have a join code</button>
    <button class="btn-secondary" style="margin-top:8px" onclick="showLandlordRegister()">🏠 Register as a Landlord</button>`}`);
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
    <form onsubmit="event.preventDefault();doRegister('landlord')">
      ${registerFields('<div class="form-group"><label>Business Name (optional)</label><input type="text" id="reg-biz" autocomplete="organization"/></div>')}
      <button class="btn-primary" type="submit" id="reg-btn">Create Landlord Account</button>
    </form>
    <p class="err-msg" id="reg-err"></p>
    <button class="btn-link" onclick="showLogin()">← Back to Sign In</button>`);
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
  };
  if (!body.full_name || !body.email) { errEl.textContent = 'Name and email are required'; return; }
  const btn = document.getElementById('reg-btn'); btn.disabled = true;
  try {
    saveSession(await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(body) }));
    PENDING_JOIN_CODE = null; _joinInfo = null;   // the account is already linked to the landlord
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
function launchApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  document.getElementById('sidebar-name').textContent = currentUser.full_name;
  document.getElementById('sidebar-role').textContent = currentUser.role;
  document.getElementById('sidebar-avatar').textContent = (currentUser.full_name || 'U')[0].toUpperCase();
  buildNav();
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
    { id: 'properties', icon: '🏢', label: 'Properties', fn: loadProperties },
    { id: 'units', icon: '🚪', label: 'Units', fn: loadUnits },
    { id: 'tenants', icon: '👥', label: 'Tenants', fn: loadTenants },
    { id: 'contracts', icon: '📋', label: 'Contracts', fn: loadContracts },
    { id: 'bills', icon: '💰', label: 'Bills', fn: loadBills },
    { id: 'water', icon: '💧', label: 'Water Billing', fn: loadWaterBilling },
    { id: 'payments', icon: '💳', label: 'Payments', fn: loadPayments },
    { id: 'announcements', icon: '📣', label: 'Announcements', fn: loadLandlordAnnouncements },
    { id: 'messages', icon: '💬', label: 'Messages', fn: loadMessages },
    { id: 'reminders', icon: '🔔', label: 'Reminders', fn: loadReminders },
    { id: 'support', icon: '🎫', label: 'Support', fn: () => loadSupport('landlord') },
    { id: 'l-settings', icon: '⚙️', label: 'Settings', fn: loadLandlordSettings },
  ];
  else if (role === 'tenant') items = [
    { id: 't-dashboard', icon: '📊', label: 'My Home', fn: loadTenantDashboard },
    { id: 't-contract', icon: '📋', label: 'My Contracts', fn: loadTenantContracts },
    { id: 't-bills', icon: '💰', label: 'My Bills', fn: loadTenantBills },
    { id: 't-announcements', icon: '📣', label: 'Announcements', fn: loadTenantAnnouncements },
    { id: 't-messages', icon: '💬', label: 'Messages', fn: loadTenantMessages },
    { id: 't-settings', icon: '⚙️', label: 'Settings', fn: loadTenantSettings },
    { id: 't-support', icon: '🎫', label: 'Support', fn: () => loadSupport('tenant') },
  ];
  else if (role === 'admin') items = [
    { id: 'admin-stats', icon: '📊', label: 'Overview', fn: loadAdminStats },
    { id: 'admin-landlords', icon: '🏠', label: 'Landlords', fn: loadAdminLandlords },
    { id: 'admin-tenants', icon: '👥', label: 'Tenants', fn: loadAdminTenants },
    { id: 'admin-tickets', icon: '🎫', label: 'Support Tickets', fn: loadAdminTickets },
    { id: 'admin-chat', icon: '💬', label: 'Live Chat', fn: loadAdminChat },
    { id: 'admin-audit', icon: '📝', label: 'Audit Log', fn: loadAdminAudit },
  ];
  NAV = {};
  items.forEach(item => {
    NAV[item.id] = item;
    const el = document.createElement('div');
    el.className = 'nav-item'; el.id = 'nav-' + item.id;
    el.innerHTML = `<span class="nav-icon">${item.icon}</span><span>${esc(item.label)}</span>`;
    el.onclick = () => { goPage(item.id); closeSidebar(); };
    nav.appendChild(el);
  });
  const first = PENDING_OPEN_PAGE && NAV[PENDING_OPEN_PAGE] ? PENDING_OPEN_PAGE : items[0] && items[0].id;
  PENDING_OPEN_PAGE = null;
  if (first) goPage(first);
}
// Opens a page by id (sidebar, notifications, quick actions)
function goPage(id) {
  const item = NAV[id];
  if (!item) return;
  setPage(id);
  item.fn();
  window.scrollTo(0, 0);
}
function setPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pg = document.getElementById('page-' + id); if (pg) pg.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const ni = document.getElementById('nav-' + id); if (ni) ni.classList.add('active');
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
  const name = info.property_name ? `${info.property_name} (${info.business_name || info.landlord_name})` : (info.business_name || info.landlord_name);
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
  document.getElementById('modal-overlay').classList.add('open');
  document.body.classList.add('modal-open');
}
function closeModal(e) { if (!e || e.target === document.getElementById('modal-overlay')) closeModalDirect(); }
function closeModalDirect() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.body.classList.remove('modal-open');
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
function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '—'; }
function fmtDateTime(d) { return d ? new Date(d).toLocaleString() : '—'; }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const loadingHtml = '<p class="loading">Loading…</p>';
const errHtml = e => `<p class="err-msg">${esc(e.message)}</p>`;

function openDoc(url) {
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
// CLOUDINARY UPLOAD
// ═══════════════════════════════════════════════
function cloudinaryUpload(opts = {}) {
  return new Promise((resolve, reject) => {
    if (typeof cloudinary === 'undefined') { reject(new Error('The upload tool could not load. Check your connection.')); return; }
    const widget = cloudinary.createUploadWidget({
      cloudName: CLOUDINARY_CLOUD, uploadPreset: CLOUDINARY_PRESET,
      sources: ['local', 'camera'], multiple: false, maxFileSize: 10000000, resourceType: 'auto', ...opts
    }, (error, result) => {
      if (error) { reject(error); return; }
      if (result && result.event === 'success') resolve({ url: result.info.secure_url, public_id: result.info.public_id });
    });
    widget.open();
  });
}

// ═══════════════════════════════════════════════
// INVITE TENANTS — join code, link, QR (tap to share), printable poster
// ═══════════════════════════════════════════════
const joinUrl = code => `${location.origin}/join/${code}`;
const qrSrc = code => `/api/join/${encodeURIComponent(code)}/qr.png`;
let _invite = null;   // { code, title, kind: 'landlord' | 'property', propertyId }

async function showLandlordInvite() {
  try {
    const d = await apiFetch('/landlord/join-code');
    _invite = { code: d.code, title: d.business_name || currentUser.full_name, kind: 'landlord' };
    renderInvite();
  } catch (e) { alert(e.message); }
}
async function showPropertyInvite(propertyId) {
  try {
    const d = await apiFetch('/properties/' + propertyId + '/join-code', { method: 'POST', body: '{}' });
    _invite = { code: d.code, title: d.property_name, kind: 'property', propertyId };
    renderInvite();
  } catch (e) { alert(e.message); }
}
function renderInvite() {
  const { code, title, kind } = _invite;
  openModal(kind === 'property' ? `Invite tenants to ${title}` : 'Invite tenants', `
    <p class="muted-text center" style="margin-bottom:10px">${kind === 'property'
      ? 'Tenants who join with this code are linked to you and this property.'
      : 'Tenants who join with this code are linked to you. A tenant can join more than one landlord or property.'}</p>
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
      <button class="btn btn-outline" onclick="shareLoginLink()">🔐 Share Sign-in Link</button>
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
async function shareLoginLink() {
  const url = location.origin + '/';
  const text = 'Sign in to Shiloh Living to see your bills and messages:';
  if (!navigator.share) { copyText(url, 'Sign-in link copied!'); return; }
  try { await navigator.share({ title: 'Shiloh Living', text, url }); } catch (e) { if (e.name !== 'AbortError') copyText(url); }
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
  if (!confirm('Make a new code? The current code, link and any printed QR codes will stop working.')) return;
  try {
    const d = _invite.kind === 'property'
      ? await apiFetch('/properties/' + _invite.propertyId + '/join-code', { method: 'POST', body: JSON.stringify({ regenerate: true }) })
      : await apiFetch('/landlord/join-code', { method: 'POST', body: JSON.stringify({ regenerate: true }) });
    _invite.code = d.code;
    renderInvite();
    if (_invite.kind === 'landlord' && document.getElementById('page-dashboard').classList.contains('active')) loadLandlordDashboard();
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
      `<div class="reminder-banner"><span style="font-size:20px">🔔</span>
        <div><strong>${esc(r.title)}</strong><div style="font-size:12px;color:var(--warn);margin-top:2px">Due today</div></div></div>`).join('');
    const stat = (v, label, page) => `<div class="stat-card"${page ? ` onclick="goPage('${page}')" role="button"` : ''}><div class="value">${esc(v)}</div><div class="label">${label}</div></div>`;
    pg.innerHTML = `${remBanners}
      <div class="stats-grid">
        ${stat(s.total_properties || 0, 'Properties', 'properties')}
        ${stat(s.total_units || 0, 'Units', 'units')}
        ${stat(s.occupied_units || 0, 'Occupied', 'units')}
        ${stat(s.vacant_units || 0, 'Vacant', 'units')}
        ${stat(s.total_tenants || 0, 'Tenants', 'tenants')}
        ${stat(s.pending_payments || 0, 'Payments to Review', 'payments')}
        ${stat('₱' + fmt(s.outstanding_amount || 0), 'Unpaid Bills', 'bills')}
        ${stat(d.unread_threads || 0, 'Unread Messages', 'messages')}
      </div>
      <div class="card invite-card"><div class="card-header"><h3>👋 Invite Tenants</h3></div>
        <p class="muted-text">Tenants join you with your code, link or QR code — they can't register on their own.</p>
        <div class="code-card">${esc(d.landlord_code || '—')}</div>
        <div class="btn-group">
          <button class="btn btn-brand" onclick="showLandlordInvite()">📱 QR Code &amp; Share Link</button>
          <button class="btn btn-outline" onclick="copyText(joinUrl(${jsArg(d.landlord_code)}), 'Join link copied!')">📋 Copy Join Link</button>
        </div>
        <p class="hint" style="margin-top:8px">Want tenants linked to a specific building? Use <a href="#" onclick="event.preventDefault();goPage('properties')">a property's own invite</a>.</p>
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
            <button class="btn btn-outline" onclick="goPage('bills')">💰 Manage Bills</button>
            <button class="btn btn-outline" onclick="goPage('payments')">💳 Review Payments</button>
          </div>
        </div>
      </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}

// ═══════════════════════════════════════════════
// PROPERTIES
// ═══════════════════════════════════════════════
let _props = [];
async function loadProperties() {
  const pg = document.getElementById('page-properties'); pg.innerHTML = loadingHtml;
  try {
    _props = await apiFetch('/properties');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Properties (${_props.length})</h3>
      <button class="btn btn-brand" onclick="showAddProperty()">+ Add Property</button></div>
      ${!_props.length ? '<div class="empty-state"><div class="icon">🏢</div><p>No properties yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Address</th><th>Units</th><th>Occupied</th><th>Actions</th></tr></thead><tbody>
        ${_props.map(p => `<tr><td><strong>${esc(p.name)}</strong></td><td>${esc(p.address)}${p.city ? ', ' + esc(p.city) : ''}</td><td>${esc(p.unit_count || 0)}</td><td>${esc(p.occupied || 0)}/${esc(p.unit_count || 0)}</td>
          <td><div class="btn-group"><button class="btn btn-sm btn-brand" onclick="showPropertyInvite(${parseInt(p.id)})">👋 Invite</button>
          <button class="btn btn-sm btn-outline" onclick="loadUnitsForProperty(${parseInt(p.id)})">Units</button>
          <button class="btn btn-sm btn-red" onclick="deleteProperty(${parseInt(p.id)})">Delete</button></div></td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function showAddProperty() {
  openModal('Add Property', `
    <div class="form-group"><label>Name</label><input type="text" id="m-prop-name"/></div>
    <div class="form-group"><label>Address</label><input type="text" id="m-prop-addr"/></div>
    <div class="grid-2"><div class="form-group"><label>City</label><input type="text" id="m-prop-city"/></div>
    <div class="form-group"><label>Country</label><input type="text" id="m-prop-country" value="Philippines"/></div></div>
    <p class="err-msg" id="m-prop-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitAddProperty()">Add</button>`);
}
async function submitAddProperty() {
  const name = document.getElementById('m-prop-name').value.trim();
  const address = document.getElementById('m-prop-addr').value.trim();
  document.getElementById('m-prop-err').textContent = '';
  if (!name || !address) { document.getElementById('m-prop-err').textContent = 'Name and address are required'; return; }
  try {
    await apiFetch('/properties', { method: 'POST', body: JSON.stringify({ name, address, city: document.getElementById('m-prop-city').value, country: document.getElementById('m-prop-country').value }) });
    closeModalDirect(); loadProperties();
  } catch (e) { document.getElementById('m-prop-err').textContent = e.message; }
}
async function deleteProperty(id) {
  if (!confirm('Delete this property? Its units will be hidden and its invite code will stop working.')) return;
  try { await apiFetch('/properties/' + id, { method: 'DELETE' }); loadProperties(); } catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// UNITS
// ═══════════════════════════════════════════════
const unitRow = (u, withProp) => `<tr>${withProp ? `<td>${esc(u.property_name || '—')}</td>` : ''}<td><strong>${esc(u.unit_number)}</strong></td>
  ${withProp ? '' : `<td>${esc(u.floor_num ?? '—')}</td>`}<td>${esc(u.bedrooms ?? '—')}</td><td>₱${fmt(u.rent_amount)}/mo</td><td>${badge(u.status)}</td></tr>`;
async function loadUnits() {
  const pg = document.getElementById('page-units'); pg.innerHTML = loadingHtml;
  try {
    const [units, props] = await Promise.all([apiFetch('/units'), apiFetch('/properties')]);
    _props = props;
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>All Units (${units.length})</h3>
      <button class="btn btn-brand" onclick="showAddUnit()">+ Add Unit</button></div>
      ${!units.length ? '<div class="empty-state"><p>No units yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Property</th><th>Unit</th><th>Beds</th><th>Rent</th><th>Status</th></tr></thead><tbody>
        ${units.map(u => unitRow(u, true)).join('')}</tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function loadUnitsForProperty(propId) {
  setPage('units'); const pg = document.getElementById('page-units'); pg.innerHTML = loadingHtml;
  try {
    const [units, props] = await Promise.all([apiFetch('/units?property_id=' + propId), apiFetch('/properties')]);
    _props = props;
    const prop = props.find(p => p.id === propId) || {};
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Units — ${esc(prop.name)}</h3>
      <div class="btn-group"><button class="btn btn-outline" onclick="loadUnits()">← All</button>
      <button class="btn btn-brand" onclick="showAddUnit(${parseInt(propId)})">+ Add Unit</button></div></div>
      ${!units.length ? '<div class="empty-state"><p>No units</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Unit</th><th>Floor</th><th>Beds</th><th>Rent</th><th>Status</th></tr></thead><tbody>
        ${units.map(u => unitRow(u, false)).join('')}</tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function showAddUnit(propId) {
  if (!_props.length) { alert('Add a property first.'); return; }
  openModal('Add Unit', `
    <div class="form-group"><label>Property</label><select id="m-unit-prop">${_props.map(p => `<option value="${parseInt(p.id)}" ${p.id === propId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <div class="form-group"><label>Unit Number</label><input type="text" id="m-unit-num" maxlength="20" placeholder="101, 2A…"/></div>
    <div class="grid-2"><div class="form-group"><label>Floor</label><input type="number" id="m-unit-floor"/></div>
    <div class="form-group"><label>Bedrooms</label><input type="number" id="m-unit-beds" min="0"/></div></div>
    <div class="grid-2"><div class="form-group"><label>Bathrooms</label><input type="number" id="m-unit-baths" min="0"/></div>
    <div class="form-group"><label>Area m²</label><input type="number" id="m-unit-area" min="0"/></div></div>
    <div class="form-group"><label>Monthly Rent ₱</label><input type="number" id="m-unit-rent" min="0" step="0.01" inputmode="decimal"/></div>
    <p class="err-msg" id="m-unit-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitAddUnit()">Add</button>`);
}
async function submitAddUnit() {
  const v = id => document.getElementById(id).value;
  const body = {
    property_id: v('m-unit-prop'), unit_number: v('m-unit-num').trim(),
    floor_num: v('m-unit-floor') || null, bedrooms: v('m-unit-beds') || null,
    bathrooms: v('m-unit-baths') || null, area_sqm: v('m-unit-area') || null, rent_amount: v('m-unit-rent')
  };
  document.getElementById('m-unit-err').textContent = '';
  if (!body.unit_number || !body.rent_amount) { document.getElementById('m-unit-err').textContent = 'Unit number and rent are required'; return; }
  try { await apiFetch('/units', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); loadUnitsForProperty(parseInt(body.property_id)); }
  catch (e) { document.getElementById('m-unit-err').textContent = e.message; }
}

// ═══════════════════════════════════════════════
// TENANTS
// ═══════════════════════════════════════════════
async function loadTenants() {
  const pg = document.getElementById('page-tenants'); pg.innerHTML = loadingHtml;
  try {
    const tenants = await apiFetch('/landlord/tenants');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Tenants (${tenants.length})</h3>
      <button class="btn btn-brand" onclick="showLandlordInvite()">👋 Invite Tenants</button></div>
      ${!tenants.length ? `<div class="empty-state"><div class="icon">👥</div><p>No tenants yet. Share your join code, link or QR code.</p></div>` :
        `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Contact</th><th>Property / Unit</th><th>Contract</th><th>Actions</th></tr></thead><tbody>
        ${tenants.map(t => `<tr><td><strong>${esc(t.full_name)}</strong><br><small class="muted-text">Joined ${fmtDate(t.joined_at)}</small></td>
          <td style="font-size:12px">${esc(t.email)}${t.phone ? '<br>' + esc(t.phone) : ''}</td>
          <td>${t.unit_number ? `${esc(t.property_name)} — Unit ${esc(t.unit_number)}` :
            t.requested_property ? `<span class="badge badge-blue">Asked for ${esc(t.requested_property)}</span>` : '<span class="muted-text">Not assigned</span>'}</td>
          <td>${t.contract_status ? badge(t.contract_status) : `<button class="btn btn-sm btn-outline" onclick="showCreateContract(${parseInt(t.id)})">+ Contract</button>`}</td>
          <td><button class="btn btn-sm btn-info" onclick="showNewThread(${parseInt(t.user_id)})">Message</button></td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}

// ═══════════════════════════════════════════════
// CONTRACTS
// ═══════════════════════════════════════════════
let _contracts = [];
async function loadContracts() {
  const pg = document.getElementById('page-contracts'); pg.innerHTML = loadingHtml;
  try {
    _contracts = await apiFetch('/contracts');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Contracts (${_contracts.length})</h3>
      <button class="btn btn-brand" onclick="showCreateContract()">+ New Contract</button></div>
      ${!_contracts.length ? '<div class="empty-state"><p>No contracts yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Unit</th><th>Term</th><th>Rent</th><th>Contract Doc</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        ${_contracts.map(c => { const id = parseInt(c.id); return `<tr>
          <td><strong>${esc(c.tenant_name)}</strong><br><small class="muted-text">${esc(c.property_name)}</small></td>
          <td>${esc(c.unit_number)}</td>
          <td style="font-size:12px">
            ${c.is_open_term ? '<span class="badge badge-blue">Open Term</span>' : `${fmtDate(c.start_date)} → ${fmtDate(c.end_date)}`}
            ${c.minimum_months ? `<br><small class="muted-text">Min ${esc(c.minimum_months)} mo</small>` : ''}
          </td>
          <td>₱${fmt(c.monthly_rent)}/mo</td>
          <td style="font-size:12px">
            ${c.contract_doc_url
            ? `<button class="btn btn-sm btn-outline" onclick="openDoc(${jsArg(c.contract_doc_url)})">📄 View</button>
                 ${c.tenant_ack ? '<br><span class="badge badge-green" style="margin-top:4px">Acknowledged</span>' : '<br><span class="badge badge-yellow" style="margin-top:4px">Pending ACK</span>'}`
            : `<button class="btn btn-sm btn-brand" onclick="uploadContractDoc(${id})">📤 Upload</button>`}
          </td>
          <td>${badge(c.status)}</td>
          <td><div class="btn-group">${c.status === 'active' ? `
            <button class="btn btn-sm btn-warn" onclick="showExtendContract(${id})">Extend</button>
            <button class="btn btn-sm btn-red" onclick="showMoveOut(${id})">Move Out</button>
            ${c.contract_doc_url ? `<button class="btn btn-sm btn-brand" onclick="uploadContractDoc(${id})">Re-upload</button>` : ''}` :
            c.status === 'move_out_pending' ? `<button class="btn btn-sm btn-warn" onclick="showMoveOutChecklist(${id})">📋 Checklist</button>` : ''}</div></td>
        </tr>`; }).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
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
      ${tenants.map(t => `<option value="${parseInt(t.id)}" ${t.id === tenantId ? 'selected' : ''}>${esc(t.full_name)} (${esc(t.email)})${t.requested_property ? ' — asked for ' + esc(t.requested_property) : ''}</option>`).join('')}</select></div>
    <div class="form-group"><label>Unit (vacant)</label><select id="m-c-unit" onchange="contractUnitPicked()"><option value="">— Select —</option>
      ${vacantUnits.map(u => `<option value="${parseInt(u.id)}" data-rent="${esc(u.rent_amount)}">${esc(u.property_name)} — Unit ${esc(u.unit_number)} (₱${fmt(u.rent_amount)}/mo)</option>`).join('')}</select></div>
    <div class="grid-2">
      <div class="form-group"><label>Contract Signed Date</label><input type="date" id="m-c-signed"/></div>
      <div class="form-group"><label>Lease Start Date</label><input type="date" id="m-c-start"/></div>
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
  try { await apiFetch('/contracts', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); goPage('contracts'); }
  catch (e) { errEl.textContent = e.message; }
}
async function uploadContractDoc(contractId) {
  try {
    const result = await cloudinaryUpload({ sources: ['local'], resourceType: 'auto', clientAllowedFormats: ['pdf', 'jpg', 'jpeg', 'png'], maxFileSize: 10000000 });
    await apiFetch('/contracts/' + contractId + '/upload-doc', { method: 'POST', body: JSON.stringify({ contract_doc_url: result.url, public_id: result.public_id }) });
    alert('✅ Contract uploaded! Tenant has been notified.');
    loadContracts();
  } catch (e) { if (e && e.message) alert('Upload failed: ' + e.message); }
}
function showMoveOut(contractId) {
  const c = _contracts.find(x => x.id === contractId) || {};
  const today = new Date().toISOString().split('T')[0];
  openModal(`Start Move-Out: ${c.tenant_name || ''}`, `
    <div class="info-box">This begins the move-out process. The contract stays open until you complete the checklist.</div>
    <div class="form-group"><label>Move-Out Date</label><input type="date" id="m-mo-date" value="${today}"/></div>
    <div class="form-group"><label>Notes (optional)</label><textarea id="m-mo-notes" rows="3"></textarea></div>
    <p class="err-msg" id="m-mo-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-warn" onclick="submitMoveOut(${parseInt(contractId)})">Start Move-Out</button>`);
}
async function submitMoveOut(contractId) {
  const move_out_date = document.getElementById('m-mo-date').value;
  const notes = document.getElementById('m-mo-notes').value;
  try { await apiFetch('/contracts/' + contractId + '/terminate', { method: 'PATCH', body: JSON.stringify({ move_out_date, notes }) }); closeModalDirect(); loadContracts(); }
  catch (e) { document.getElementById('m-mo-err').textContent = e.message; }
}
async function showMoveOutChecklist(contractId) {
  try {
    const d = await apiFetch('/contracts/' + contractId + '/move-out');
    const c = d.contract; const ch = d.checklist || {};
    const sel = (v, cur) => v === cur ? 'selected' : '';
    openModal(`📋 Move-Out Checklist — ${c.tenant_name}`, `
      <div class="muted-text" style="margin-bottom:14px">Unit ${esc(c.unit_number)} · ${esc(c.property_name)} · Move-out: ${fmtDate(c.move_out_date)}</div>
      <h4 class="section-title">💰 Security Deposit</h4>
      <div class="pref-row"><span class="pref-label">Deposit was used for repairs/damages?</span>
        <label class="toggle"><input type="checkbox" id="ch-dep-consumed" ${ch.deposit_consumed ? 'checked' : ''}/><span class="toggle-slider"></span></label></div>
      <div class="form-group" style="margin-top:10px"><label>Amount Used ₱</label><input type="number" id="ch-dep-amount" value="${esc(ch.deposit_consumed_amount || 0)}" min="0"/></div>
      <h4 class="section-title">🔧 Repairs</h4>
      <div class="form-group"><label>Repair Status</label><select id="ch-repair-status">
          <option value="not_required" ${sel('not_required', ch.repair_status || 'not_required')}>No repairs needed</option>
          <option value="pending" ${sel('pending', ch.repair_status)}>Pending</option>
          <option value="cleared" ${sel('cleared', ch.repair_status)}>Cleared</option></select></div>
      <div class="form-group"><label>Repair Notes</label><textarea id="ch-repair-notes" rows="3">${esc(ch.repair_notes || '')}</textarea></div>
      <div class="form-group"><label>Proof Documents</label>
        ${ch.repair_proof_url ? `<div style="margin-bottom:8px"><button class="btn btn-sm btn-outline" onclick="openDoc(${jsArg(ch.repair_proof_url)})">📎 View Current</button></div>` : ''}
        <button class="btn btn-outline btn-sm" type="button" onclick="uploadMoveOutProof()">📤 Upload Receipts/Photos</button>
        <input type="hidden" id="ch-proof-url" value="${esc(ch.repair_proof_url || '')}"/>
        <div id="ch-proof-status" style="font-size:12px;color:var(--success);margin-top:4px"></div></div>
      <h4 class="section-title">✅ Deposit Status</h4>
      <div class="form-group"><label>Status</label><select id="ch-deposit-status">
          <option value="processing" ${sel('processing', ch.deposit_status || 'processing')}>Processing</option>
          <option value="ready" ${sel('ready', ch.deposit_status)}>Ready for Pickup</option>
          <option value="released" ${sel('released', ch.deposit_status)}>Released</option></select></div>
      <p class="err-msg" id="ch-err"></p>`,
      `<button class="btn btn-outline" onclick="closeModalDirect()">Close</button>
       <button class="btn btn-warn" onclick="saveMoveOutChecklist(${parseInt(contractId)})">💾 Save</button>
       ${ch.repair_status !== 'pending' ? `<button class="btn btn-green" onclick="completeMoveOut(${parseInt(contractId)})">✅ Complete Move-Out</button>` : '<span style="font-size:12px;color:var(--danger)">Resolve repairs first</span>'}`);
  } catch (e) { alert('Could not load checklist: ' + e.message); }
}
async function uploadMoveOutProof() {
  try {
    const result = await cloudinaryUpload({ sources: ['local', 'camera'], maxFileSize: 10000000, resourceType: 'auto' });
    document.getElementById('ch-proof-url').value = result.url;
    document.getElementById('ch-proof-status').textContent = '✅ Uploaded';
  } catch (e) { if (e && e.message) alert('Upload failed: ' + e.message); }
}
async function saveMoveOutChecklist(contractId) {
  const body = {
    deposit_consumed: document.getElementById('ch-dep-consumed').checked ? 1 : 0,
    deposit_consumed_amount: document.getElementById('ch-dep-amount').value || 0,
    repair_status: document.getElementById('ch-repair-status').value,
    repair_notes: document.getElementById('ch-repair-notes').value,
    repair_proof_url: document.getElementById('ch-proof-url').value || null,
    deposit_status: document.getElementById('ch-deposit-status').value
  };
  try {
    await apiFetch('/contracts/' + contractId + '/move-out', { method: 'PATCH', body: JSON.stringify(body) });
    closeModalDirect(); loadContracts();
  } catch (e) { document.getElementById('ch-err').textContent = e.message; }
}
async function completeMoveOut(contractId) {
  if (!confirm('Complete move-out? This will mark the unit as vacant.')) return;
  try {
    await apiFetch('/contracts/' + contractId + '/complete-move-out', { method: 'POST', body: '{}' });
    closeModalDirect(); alert('✅ Move-out complete. Unit is now vacant.'); loadContracts();
  } catch (e) { alert(e.message); }
}
function showExtendContract(id) {
  openModal('Extend Contract', `<div class="form-group"><label>New End Date</label><input type="date" id="m-ext-date"/></div><p class="err-msg" id="m-ext-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button><button class="btn btn-brand" onclick="submitExtend(${parseInt(id)})">Extend</button>`);
}
async function submitExtend(id) {
  const end_date = document.getElementById('m-ext-date').value;
  if (!end_date) { document.getElementById('m-ext-err').textContent = 'Required'; return; }
  try { await apiFetch('/contracts/' + id + '/extend', { method: 'PATCH', body: JSON.stringify({ end_date }) }); closeModalDirect(); loadContracts(); }
  catch (e) { document.getElementById('m-ext-err').textContent = e.message; }
}

// ═══════════════════════════════════════════════
// BILLS
// ═══════════════════════════════════════════════
async function loadBills() {
  const pg = document.getElementById('page-bills'); pg.innerHTML = loadingHtml;
  try {
    const bills = await apiFetch('/bills');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Bills</h3>
      <div class="btn-group"><button class="btn btn-outline" onclick="generateMonthly()">⚡ Generate Monthly Rent</button>
      <button class="btn btn-brand" onclick="showCreateBill()">+ Add Bill</button></div></div>
      ${!bills.length ? '<div class="empty-state"><p>No bills yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Type</th><th>Description</th><th>Amount</th><th>Due</th><th>Status</th></tr></thead><tbody>
        ${bills.map(b => `<tr><td><strong>${esc(b.tenant_name)}</strong><br><small>${esc(b.property_name)} · ${esc(b.unit_number)}</small></td>
          <td>${badge(b.bill_type || 'rent')}</td><td>${esc(b.description)}</td>
          <td>₱${fmt(b.amount)}</td><td>${fmtDate(b.due_date)}</td><td>${badge(b.status)}</td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function generateMonthly() {
  if (!confirm("Create this month's rent bill for each of your active contracts that doesn't have one yet?")) return;
  try { const d = await apiFetch('/bills/generate-monthly', { method: 'POST' }); alert(`Done! ${d.bills_generated} bill(s) created and tenants notified.`); loadBills(); }
  catch (e) { alert(e.message); }
}
async function showCreateBill() {
  let contracts;
  try { contracts = await apiFetch('/contracts'); } catch (e) { alert(e.message); return; }
  const active = contracts.filter(c => c.status === 'active' || c.status === 'move_out_pending');
  if (!active.length) { alert('Create a contract first.'); return; }
  const now = new Date();
  openModal('Create Bill', `
    <div class="form-group"><label>Contract</label><select id="m-b-contract"><option value="">— Select —</option>
      ${active.map(c => `<option value="${parseInt(c.id)}">${esc(c.tenant_name)} — ${esc(c.property_name)} Unit ${esc(c.unit_number)}</option>`).join('')}</select></div>
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
async function submitCreateBill() {
  const v = id => document.getElementById(id).value;
  const body = {
    contract_id: v('m-b-contract'), description: v('m-b-desc').trim(), bill_type: v('m-b-type'),
    bill_month: v('m-b-month'), bill_year: v('m-b-year'), amount: v('m-b-amt'), due_date: v('m-b-due')
  };
  try { await apiFetch('/bills', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); loadBills(); }
  catch (e) { document.getElementById('m-b-err').textContent = e.message; }
}

// ═══════════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════════
async function loadPayments() {
  const pg = document.getElementById('page-payments'); pg.innerHTML = loadingHtml;
  try {
    const payments = await apiFetch('/payments');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Payments</h3></div>
      ${!payments.length ? '<div class="empty-state"><p>No payments yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Bill</th><th>Type</th><th>Amount</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead><tbody>
        ${payments.map(p => `<tr><td>${esc(p.tenant_name)}</td><td style="font-size:12px">${esc(p.bill_desc)}</td>
          <td>${badge(p.bill_type || 'rent')}</td><td>₱${fmt(p.amount_paid)}</td><td>${badge(p.status)}</td>
          <td style="font-size:12px">${fmtDate(p.paid_at)}</td>
          <td><div class="btn-group">${p.status === 'pending' ? `
            <button class="btn btn-sm btn-green" onclick="reviewPayment(${parseInt(p.id)},'approve')">✓ Approve</button>
            <button class="btn btn-sm btn-red" onclick="rejectPaymentModal(${parseInt(p.id)})">✗ Reject</button>` : ''}
            ${p.proof_url ? `<button class="btn btn-sm btn-outline" onclick="openDoc(${jsArg(p.proof_url)})">📎 Proof</button>` : ''}</div></td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function reviewPayment(id, action) {
  try { await apiFetch('/payments/' + id + '/' + action, { method: 'PATCH', body: '{}' }); } catch (e) { alert(e.message); }
  loadPayments();
}
function rejectPaymentModal(id) {
  openModal('Reject Payment', `<div class="form-group"><label>Reason</label><textarea id="m-reject-notes" rows="3"></textarea></div>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-red" onclick="submitReject(${parseInt(id)})">Reject</button>`);
}
async function submitReject(id) {
  const notes = document.getElementById('m-reject-notes').value;
  try { await apiFetch('/payments/' + id + '/reject', { method: 'PATCH', body: JSON.stringify({ notes }) }); } catch (e) { alert(e.message); }
  closeModalDirect(); loadPayments();
}

// ═══════════════════════════════════════════════
// ANNOUNCEMENTS — LANDLORD
// ═══════════════════════════════════════════════
async function loadLandlordAnnouncements() {
  const pg = document.getElementById('page-announcements'); pg.innerHTML = loadingHtml;
  try {
    const [announcements, props] = await Promise.all([apiFetch('/announcements'), apiFetch('/properties')]);
    _props = props;
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Announcements (${announcements.length})</h3>
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
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
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
  if (!confirm('Remove this announcement?')) return;
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
    <div style="margin-top:12px"><textarea id="reply-body" rows="3" placeholder="Type your reply…"></textarea></div>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Close</button>
     <button class="btn btn-brand" onclick="submitReplyThread(${parseInt(tid)})">Send Reply</button>`);
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
      <div class="info-box">Enter monthly water meter readings per property. The app calculates each unit's bill.</div>
      ${!sessions.length ? '<div class="empty-state"><div class="icon">💧</div><p>No sessions yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Property</th><th>Month</th><th>Main Bill</th><th>Rate/Cubic</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        ${sessions.map(s => `<tr><td><strong>${esc(s.property_name)}</strong></td>
          <td>${MONTHS[s.session_month - 1]} ${esc(s.session_year)}</td>
          <td>₱${fmt(s.total_bill)}</td><td>₱${fmt(s.price_per_cubic)}</td><td>${badge(s.status)}</td>
          <td><button class="btn btn-sm btn-brand" onclick="openWaterSession(${parseInt(s.id)})">${s.status === 'draft' ? 'Enter Readings' : 'View'}</button></td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function showNewWaterSession() {
  if (!_props.length) { alert('Add a property first.'); return; }
  const now = new Date();
  openModal('New Water Billing Session', `
    <div class="form-group"><label>Property</label><select id="m-w-prop">${_props.map(p => `<option value="${parseInt(p.id)}">${esc(p.name)}</option>`).join('')}</select></div>
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
  try { const d = await apiFetch('/water/sessions', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); openWaterSession(d.session_id); }
  catch (e) { errEl.textContent = e.message; }
}
let _water = null;   // { session, units }
async function openWaterSession(sid) {
  setPage('water'); const pg = document.getElementById('page-water'); pg.innerHTML = loadingHtml;
  try {
    const d = await apiFetch('/water/sessions/' + sid); const s = d.session; const readings = d.readings || [];
    const units = await apiFetch('/units?property_id=' + s.property_id);
    _water = { session: s, units };
    const billed = s.status === 'billed';
    const readingMap = {}; readings.forEach(r => readingMap[r.unit_id] = r);
    const dis = billed ? 'disabled' : '';
    pg.innerHTML = `<div class="card">
      <div class="card-header"><div><h3>💧 ${esc(s.property_name)} — ${MONTHS[s.session_month - 1]} ${esc(s.session_year)}</h3>
        <div class="muted-text" style="margin-top:4px">${fmtDate(s.prev_reading_date)} → ${fmtDate(s.curr_reading_date)}</div></div>
        <button class="btn btn-outline" onclick="loadWaterBilling()">← Back</button></div>
      <div class="water-calc">
        <div class="row"><span>Total Main Bill</span><span>₱${fmt(s.total_bill)}</span></div>
        <div class="row"><span>Overall Consumption</span><span>${esc(s.overall_consumption)} cu</span></div>
        <div class="row"><span>Price per Cubic</span><span>₱${parseFloat(s.price_per_cubic).toFixed(4)}</span></div>
        <div class="row"><span>Pump Fee per Unit</span><span>₱${parseFloat(s.pump_per_unit).toFixed(4)}</span></div>
      </div></div>
      <div class="card"><div class="card-header"><h3>Unit Readings</h3></div>
      ${billed ? '<div class="info-box">Bills generated. View them in the Bills tab.</div>' : ''}
      <div class="table-wrap"><table><thead><tr><th>Unit</th><th>Owner?</th><th>Previous cu</th><th>Current cu</th><th>Consumption</th><th>Water Bill</th><th>Pump</th><th>Total</th></tr></thead><tbody>
      ${units.map(u => { const r = readingMap[u.id] || {}; const id = parseInt(u.id); return `<tr>
        <td><strong>${esc(u.unit_number)}</strong></td>
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
  const readings = _water.units.map(u => ({
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
// REMINDERS
// ═══════════════════════════════════════════════
async function loadReminders() {
  const pg = document.getElementById('page-reminders'); pg.innerHTML = loadingHtml;
  try {
    const reminders = await apiFetch('/reminders'); const today = new Date().getDate();
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Reminders</h3>
      <button class="btn btn-brand" onclick="showAddReminder()">+ Add Reminder</button></div>
      <div class="info-box">Reminders appear on your dashboard on the day you set every month.</div>
      ${!reminders.length ? '<div class="empty-state"><div class="icon">🔔</div><p>No reminders yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Type</th><th>Day</th><th>Actions</th></tr></thead><tbody>
        ${reminders.map(r => `<tr><td><strong>${esc(r.title)}</strong></td><td>${badge(r.reminder_type)}</td>
          <td>Every ${esc(r.day_of_month)}${r.day_of_month === today ? ' 🔔 Today' : ''}</td>
          <td><button class="btn btn-sm btn-red" onclick="deleteReminder(${parseInt(r.id)})">Delete</button></td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
}
function showAddReminder() {
  openModal('Add Reminder', `
    <div class="form-group"><label>Title</label><input type="text" id="m-rem-title" maxlength="255" placeholder="Read water meters…"/></div>
    <div class="form-group"><label>Type</label><select id="m-rem-type">
      <option value="water_reading">Water Meter Reading</option><option value="bill_generation">Bill Generation</option>
      <option value="payment_collection">Payment Collection</option><option value="custom">Custom</option></select></div>
    <div class="form-group"><label>Day of Month (1–28)</label><input type="number" id="m-rem-day" min="1" max="28" placeholder="1"/>
      <small class="hint">Appears on your dashboard on this day every month</small></div>
    <p class="err-msg" id="m-rem-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitAddReminder()">Add</button>`);
}
async function submitAddReminder() {
  const body = { title: document.getElementById('m-rem-title').value.trim(), reminder_type: document.getElementById('m-rem-type').value, day_of_month: document.getElementById('m-rem-day').value };
  const errEl = document.getElementById('m-rem-err'); errEl.textContent = '';
  if (!body.title || !body.day_of_month) { errEl.textContent = 'All fields required'; return; }
  try { await apiFetch('/reminders', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); loadReminders(); }
  catch (e) { errEl.textContent = e.message; }
}
async function deleteReminder(id) {
  if (!confirm('Delete?')) return;
  try { await apiFetch('/reminders/' + id, { method: 'DELETE' }); } catch (e) { alert(e.message); }
  loadReminders();
}

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
  if (!confirm('Mark this ticket as resolved?')) return;
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
    const d = await apiFetch('/tenant/dashboard');
    const landlords = d.landlords || []; _bills = d.bills || []; const unreadAnn = d.unread_announcements || 0;
    const due = _bills.filter(b => b.status !== 'paid' && !b.payment_id);
    pg.innerHTML = `
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
              ${c.contract_status === 'move_out_pending' ? '<div class="warn-box">Move-out in progress.</div>' : ''}
              ${c.contract_doc_url ? `
                <div class="doc-row"><span>📄 Signed contract available</span>
                  <div class="btn-group">
                    <button class="btn btn-sm btn-outline" onclick="openDoc(${jsArg(c.contract_doc_url)})">View Contract</button>
                    ${!c.tenant_ack ? `<button class="btn btn-sm btn-green" onclick="acknowledgeContract(${parseInt(c.contract_id)})">✓ Acknowledge</button>` : '<span class="badge badge-green">Acknowledged</span>'}
                  </div></div>` : ''}
            </div>`).join('')
          : `<p class="muted-text">${l.requested_property ? `You asked to join <strong>${esc(l.requested_property)}</strong>. ` : ''}Your landlord hasn't assigned you a unit yet.</p>`}
        </div>`).join('')}
      ${!landlords.length ? `<div class="card"><div class="empty-state"><div class="icon">🏠</div>
        <p>You haven't joined a landlord yet.</p>
        <button class="btn btn-brand" onclick="showJoinLandlord()" style="margin-top:12px">🔑 Enter a Join Code</button></div></div>`
        : `<div style="margin-bottom:16px"><button class="btn btn-outline btn-sm" onclick="showJoinLandlord()">+ Join Another Landlord or Property</button></div>`}
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
  openModal('Join a Landlord or Property', `
    <div class="info-box">Enter the code from your landlord (it starts with L or P), or scan their QR code with your phone camera.</div>
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
          <div class="muted-text" style="margin-bottom:10px">Upload a screenshot or photo of your payment receipt</div>
          <button class="btn btn-outline" type="button" onclick="uploadPaymentProof()">Choose File</button>
        </div>
        <div id="m-pay-proof-done" style="display:none">
          <div style="font-size:20px;color:var(--success)">✅</div>
          <div style="font-size:13px;margin-top:6px">Proof uploaded</div>
          <button class="btn btn-sm btn-outline" style="margin-top:8px" type="button" onclick="uploadPaymentProof()">Change</button>
        </div>
      </div>
      <input type="hidden" id="m-pay-proof-url"/><input type="hidden" id="m-pay-proof-pid"/>
    </div>
    <p class="err-msg" id="m-pay-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" id="m-pay-btn" onclick="submitTenantPayment(${parseInt(billId)})">Submit Payment</button>`);
}
async function uploadPaymentProof() {
  try {
    const result = await cloudinaryUpload({ sources: ['local', 'camera'], clientAllowedFormats: ['jpg', 'jpeg', 'png', 'webp', 'heic'], maxFileSize: 8000000, resourceType: 'image' });
    document.getElementById('m-pay-proof-url').value = result.url;
    document.getElementById('m-pay-proof-pid').value = result.public_id;
    document.getElementById('m-pay-proof-placeholder').style.display = 'none';
    document.getElementById('m-pay-proof-done').style.display = 'block';
  } catch (e) { if (e && e.message) alert('Upload failed: ' + e.message); }
}
async function submitTenantPayment(billId) {
  const proof_url = document.getElementById('m-pay-proof-url').value || '';
  const body = { bill_id: billId, amount_paid: document.getElementById('m-pay-amt').value, proof_url, proof_public_id: document.getElementById('m-pay-proof-pid').value || '' };
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
          <td>${payButton(b, 'Pay Now')}</td></tr>`).join('')}
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
function accountCardHtml(roleLabel) {
  return `<div class="card">
      <div class="card-header"><h3>👤 My Account</h3></div>
      <div class="pref-row"><span class="pref-label">Name</span><strong>${esc(currentUser.full_name)}</strong></div>
      <div class="pref-row"><span class="pref-label">Email</span><strong class="break">${esc(currentUser.email)}</strong></div>
      <div class="pref-row"><span class="pref-label">Role</span><strong>${roleLabel}</strong></div>
      <div class="btn-group" style="margin-top:16px">
        <button class="btn btn-outline" onclick="showChangeEmail()">✉️ Change Email Address</button>
        <button class="btn btn-outline" onclick="logout()">Sign Out</button>
      </div>
    </div>`;
}
async function loadTenantSettings() {
  const pg = document.getElementById('page-t-settings'); pg.innerHTML = loadingHtml;
  try {
    const prefs = await apiFetch('/notification-preferences');
    pg.innerHTML = `
      ${pushCardHtml()}
      <div class="card"><div class="card-header"><h3>🔑 Join Another Landlord or Property</h3></div>
        <p class="muted-text">Renting from more than one landlord, or another of your landlord's properties? Enter their join code.</p>
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
      ${accountCardHtml('Tenant')}`;
    wirePushCard();
  } catch (e) { pg.innerHTML = errHtml(e); }
}
async function loadLandlordSettings() {
  const pg = document.getElementById('page-l-settings'); pg.innerHTML = loadingHtml;
  try {
    const prefs = await apiFetch('/notification-preferences');
    pg.innerHTML = `
      ${pushCardHtml()}
      <div class="card"><div class="card-header"><h3>👋 Invite Tenants</h3></div>
        <p class="muted-text">Your join code, link and QR code. Make a new code there if the old one got shared too widely.</p>
        <button class="btn btn-brand" style="margin-top:10px" onclick="showLandlordInvite()">Open Invite</button></div>
      <div class="card"><div class="card-header"><h3>📧 Email Notifications</h3></div>
        ${prefRowsHtml([
          { key: 'email_tenant_message', label: 'Message received from a tenant' },
          { key: 'email_contract_acknowledged', label: 'Tenant acknowledges a signed contract' },
          { key: 'email_payment_submitted', label: 'Tenant submits a payment proof' },
          { key: 'email_new_tenant_joined', label: 'New tenant joins using your code' },
        ], prefs)}
        <div id="pref-save-msg" class="small-msg ok" style="display:none">✅ Saved</div>
      </div>
      ${accountCardHtml('Landlord')}`;
    wirePushCard();
  } catch (e) { pg.innerHTML = errHtml(e); }
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
    ${r.is_active ? `<button class="btn btn-sm btn-red" onclick="adminToggleUser(${id},'suspend','${role}')">Suspend</button>`
      : `<button class="btn btn-sm btn-green" onclick="adminToggleUser(${id},'activate','${role}')">Activate</button>`}</div>`;
}
async function loadAdminLandlords() {
  const pg = document.getElementById('page-admin-landlords'); pg.innerHTML = loadingHtml;
  try {
    const rows = await apiFetch('/admin/landlords');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Landlords (${rows.length})</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Code</th><th>Props</th><th>Tenants</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td><strong>${esc(r.full_name)}</strong><br><small class="muted-text">${esc(r.business_name || '')}</small></td>
        <td style="font-size:12px">${esc(r.email)}</td><td><code>${esc(r.landlord_code)}</code></td>
        <td>${esc(r.properties)}</td><td>${esc(r.tenants)}</td>
        <td>${r.is_active ? badge('active') : badge('suspended')}</td><td>${adminUserActions(r, 'landlord')}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  } catch (e) { pg.innerHTML = errHtml(e); }
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
  if (!confirm(`${action === 'suspend' ? 'Suspend' : 'Activate'} this user?`)) return;
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
    const item = c => `<div class="thread-list-item ${c.unread_count > 0 ? 'unread' : ''}" onclick="adminOpenChat(${parseInt(c.id)})">
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
            <button class="btn btn-outline btn-sm" onclick="loadAdminChat()">← Back</button>
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
  if (!confirm('Close this chat?')) return;
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

  // A tenant join link / QR opened while signed out: show who it's for, then sign up
  if (PENDING_JOIN_CODE) {
    authCard(loadingHtml);
    if (await lookupJoinCode(PENDING_JOIN_CODE)) showTenantRegister();
    return;
  }
  showLogin();
})();
