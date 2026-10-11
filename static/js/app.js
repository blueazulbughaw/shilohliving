// ═══════════════════════════════════════════════
// GLOBALS & API
// ═══════════════════════════════════════════════
const API = '/api';
const CLOUDINARY_CLOUD = 'dyyi3mtm0';
const CLOUDINARY_PRESET = 'UploadPresetShiloh';

let token = localStorage.getItem('shiloh_token');
let currentUser = JSON.parse(localStorage.getItem('shiloh_user') || 'null');

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API + path, { headers, ...opts });
  let json;
  try { json = await res.json(); }
  catch (_) {
    if (res.status === 401) { logout(); return; }
    throw new Error('Server error (' + res.status + '). Please try refreshing the page.');
  }
  if (!res.ok) throw new Error(json.message || 'Request failed');
  return json.data !== undefined ? json.data : json;
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
// NOTIFICATIONS
// ═══════════════════════════════════════════════
async function loadNotifications() {
  try {
    const d = await apiFetch('/notifications');
    const badge = document.getElementById('notif-badge');
    const list = document.getElementById('notif-list');
    if (d.unread_count > 0) { badge.textContent = d.unread_count; badge.style.display = 'flex'; }
    else badge.style.display = 'none';
    if (!d.notifications || !d.notifications.length) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">No notifications</div>';
      return;
    }
    list.innerHTML = d.notifications.map(n =>
      `<div class="notif-item ${!n.is_read ? 'unread' : ''}" onclick="readNotif(${n.id})">
        <div class="ntitle">${n.title}</div>
        <div class="nbody">${n.body || ''}</div>
        <div class="ntime">${fmtDate(n.created_at)}</div>
      </div>`).join('');
  } catch (e) { }
}
async function readNotif(id) { await apiFetch('/notifications/' + id + '/read', { method: 'PATCH' }); loadNotifications(); }
async function markAllNotifsRead() { await apiFetch('/notifications/read-all', { method: 'PATCH' }); loadNotifications(); document.getElementById('notif-dropdown').classList.remove('open'); }
function toggleNotifDropdown() { document.getElementById('notif-dropdown').classList.toggle('open'); }
document.addEventListener('click', e => {
  const d = document.getElementById('notif-dropdown');
  const b = document.getElementById('notif-btn');
  if (d && !d.contains(e.target) && b && !b.contains(e.target)) d.classList.remove('open');
});

// ═══════════════════════════════════════════════
// AUTH TABS
// ═══════════════════════════════════════════════
function showTab(tab) {
  document.getElementById('tab-login').style.display = tab === 'login' ? '' : 'none';
  document.getElementById('tab-register').style.display = tab === 'register' ? '' : 'none';
  document.querySelectorAll('.auth-tabs button').forEach((b, i) => b.classList.toggle('active', (i === 0) === (tab === 'login')));
  if (tab === 'register') { document.getElementById('register-extra').style.display = 'block'; onRoleChange(); }
}
function onRoleChange() {
  const role = document.getElementById('reg-role').value;
  document.getElementById('landlord-fields').style.display = role === 'landlord' ? '' : 'none';
  document.getElementById('tenant-fields').style.display = role === 'tenant' ? '' : 'none';
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
// LOGIN
// ═══════════════════════════════════════════════
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-err');
  errEl.innerHTML = '';
  try {
    const d = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    token = d.token; currentUser = d.user;
    localStorage.setItem('shiloh_token', token);
    localStorage.setItem('shiloh_user', JSON.stringify(currentUser));
    initApp();
  } catch (e) {
    const msg = e.message || '';
    if (msg.toLowerCase().includes('verify your email')) {
      errEl.innerHTML = msg + ' <a href="#" onclick="showResendFromLogin()" style="color:var(--brand)">Resend link</a>';
    } else {
      errEl.textContent = msg;
    }
  }
}

async function showResendFromLogin() {
  const email = document.getElementById('login-email').value.trim();
  if (!email) { alert('Enter your email address first'); return; }
  // Call the dedicated resend endpoint — it accepts email in body (no auth needed)
  try {
    await apiFetch('/auth/resend-verification-by-email', { method: 'POST', body: JSON.stringify({ email }) });
    alert('Verification email sent! Check your inbox.');
  } catch (e) {
    // Fallback: tell user to check inbox anyway
    alert('If that email is registered and unverified, a new verification link has been sent.');
  }
}

// ═══════════════════════════════════════════════
// FORGOT PASSWORD
// ═══════════════════════════════════════════════
function showForgotPassword() {
  document.getElementById('tab-login').innerHTML = `
    <div class="form-group"><label>Email Address</label>
      <input type="email" id="fp-email" placeholder="you@example.com"/></div>
    <button class="btn-primary" onclick="doForgotPassword()">Send Reset Link</button>
    <p class="err-msg" id="fp-err"></p>
    <p style="text-align:center;margin-top:12px;font-size:13px">
      <a href="#" onclick="location.reload()" style="color:var(--brand)">← Back to Sign In</a></p>`;
}

async function doForgotPassword() {
  const email = document.getElementById('fp-email').value.trim();
  const errEl = document.getElementById('fp-err');
  errEl.textContent = '';
  if (!email) { errEl.textContent = 'Please enter your email address'; return; }
  try {
    await apiFetch('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    document.getElementById('tab-login').innerHTML = `
      <div style="text-align:center;padding:10px 0">
        <div style="font-size:48px;margin-bottom:12px">📧</div>
        <p style="color:var(--brand);font-weight:600;font-size:16px">Check your inbox</p>
        <p style="color:var(--muted);font-size:13px;margin-top:8px;line-height:1.6">
          If that email is registered, a reset link has been sent.<br>It expires in <strong>1 hour</strong>.</p>
        <button class="btn-primary" style="margin-top:16px" onclick="location.reload()">Back to Sign In</button>
      </div>`;
  } catch (e) { errEl.textContent = e.message; }
}

function showResetPasswordScreen(rtoken) {
  document.getElementById('auth-screen').style.display = 'flex';
  document.querySelector('.auth-card').innerHTML = `
    <div class="auth-logo"><h1>🏠 Shiloh Living</h1><p>Set a new password</p></div>
    <div class="form-group"><label>New Password</label>
      <input type="password" id="rp-password" placeholder="Min 8 chars, uppercase, number, symbol"/>
      <small style="color:var(--muted);font-size:12px;margin-top:4px;display:block">
        Must contain uppercase, lowercase, a number, and a special character.</small></div>
    <div class="form-group"><label>Confirm New Password</label>
      <input type="password" id="rp-confirm"/></div>
    <button class="btn-primary" onclick="doResetPassword('${rtoken}')">Set New Password</button>
    <p class="err-msg" id="rp-err"></p>`;
}

async function doResetPassword(rtoken) {
  const password = document.getElementById('rp-password').value;
  const confirm = document.getElementById('rp-confirm').value;
  const errEl = document.getElementById('rp-err');
  errEl.textContent = '';
  const pwErr = validatePasswordStrength(password);
  if (pwErr) { errEl.textContent = pwErr; return; }
  if (password !== confirm) { errEl.textContent = 'Passwords do not match'; return; }
  try {
    await apiFetch('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: rtoken, password }) });
    alert('✅ Password reset successfully! You can now log in.');
    window.history.replaceState({}, '', '/');
    location.reload();
  } catch (e) { errEl.textContent = e.message; }
}

// ═══════════════════════════════════════════════
// REGISTER
// ═══════════════════════════════════════════════
async function doRegister() {
  const password = document.getElementById('reg-password').value;
  const confirmPassword = document.getElementById('reg-confirm-password').value;
  const errEl = document.getElementById('reg-err');
  errEl.textContent = '';
  const pwErr = validatePasswordStrength(password);
  if (pwErr) { errEl.textContent = pwErr; return; }
  if (password !== confirmPassword) { errEl.textContent = 'Passwords do not match'; return; }
  const body = {
    full_name: document.getElementById('reg-name').value.trim(),
    email: document.getElementById('reg-email').value.trim(),
    password,
    phone: document.getElementById('reg-phone').value.trim(),
    role: document.getElementById('reg-role').value,
    business_name: document.getElementById('reg-biz').value.trim(),
    landlord_code: (document.getElementById('reg-code')?.value || '').trim().toUpperCase()
  };
  try {
    const d = await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(body) });
    token = d.token; currentUser = d.user;
    localStorage.setItem('shiloh_token', token);
    localStorage.setItem('shiloh_user', JSON.stringify(currentUser));
    showVerifyGate();
  } catch (e) { errEl.textContent = e.message; }
}

function logout() {
  localStorage.removeItem('shiloh_token');
  localStorage.removeItem('shiloh_user');
  token = null; currentUser = null;
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
  location.reload();
}

// ═══════════════════════════════════════════════
// EMAIL VERIFICATION GATE
// ═══════════════════════════════════════════════
function showVerifyGate() {
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
  document.querySelector('.auth-card').innerHTML = `
    <div class="auth-logo"><h1>🏠 Shiloh Living</h1></div>
    <div style="text-align:center;padding:10px 0 20px">
      <div style="font-size:48px;margin-bottom:12px">✉️</div>
      <h2 style="color:var(--brand);margin-bottom:10px">Verify Your Email</h2>
      <p style="color:var(--muted);font-size:14px;margin-bottom:20px;line-height:1.6">
        We sent a verification link to<br><strong>${currentUser.email}</strong><br><br>
        Please check your inbox and click the link to activate your account.
      </p>
      <button class="btn-primary" id="resend-gate-btn" onclick="resendFromGate()">Resend Verification Email</button>
      <p id="gate-msg" style="color:var(--success);font-size:13px;margin-top:10px;display:none">✅ Email sent!</p>
      <p style="margin-top:16px;font-size:13px;color:var(--muted)">
        Already verified? <a href="#" onclick="recheckVerification()" style="color:var(--brand)">Click here</a>
      </p>
      <p style="margin-top:8px;font-size:13px">
        <a href="#" onclick="logout()" style="color:var(--muted)">Sign out</a>
      </p>
    </div>`;
}

async function resendFromGate() {
  const btn = document.getElementById('resend-gate-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    await apiFetch('/auth/resend-verification', { method: 'POST' });
    const msg = document.getElementById('gate-msg');
    if (msg) msg.style.display = 'block';
    if (btn) { btn.textContent = 'Resend Verification Email'; btn.disabled = false; }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Resend Verification Email'; }
    alert(e.message);
  }
}

async function recheckVerification() {
  try {
    const me = await apiFetch('/auth/me');
    if (me && me.email_verified) {
      currentUser = Object.assign({}, currentUser, me);
      localStorage.setItem('shiloh_user', JSON.stringify(currentUser));
      launchApp();
    } else {
      alert('Email not verified yet. Check your inbox.');
    }
  } catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// APP INIT
// ═══════════════════════════════════════════════
function initApp() {
  document.getElementById('auth-screen').style.display = 'none';
  apiFetch('/auth/me').then(function (me) {
    if (me) currentUser = Object.assign({}, currentUser, me);
    localStorage.setItem('shiloh_user', JSON.stringify(currentUser));
    if (currentUser.email_verified === false) { showVerifyGate(); return; }
    launchApp();
  }).catch(function () { launchApp(); });
}

function launchApp() {
  document.getElementById('app-screen').style.display = 'block';
  document.getElementById('sidebar-name').textContent = currentUser.full_name;
  document.getElementById('sidebar-role').textContent = currentUser.role;
  document.getElementById('sidebar-avatar').textContent = (currentUser.full_name || 'U')[0].toUpperCase();
  buildNav();
  loadNotifications();
  setInterval(loadNotifications, 60000);
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
    { id: 't-dashboard', icon: '📊', label: 'Dashboard', fn: loadTenantDashboard },
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
  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'nav-item'; el.id = 'nav-' + item.id;
    el.innerHTML = `<span class="nav-icon">${item.icon}</span><span>${item.label}</span>`;
    el.onclick = () => { item.fn(); setPage(item.id); closeSidebar(); };
    nav.appendChild(el);
  });
  if (items.length) { items[0].fn(); setPage(items[0].id); }
}

function setPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pg = document.getElementById('page-' + id); if (pg) pg.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const ni = document.getElementById('nav-' + id); if (ni) ni.classList.add('active');
  const labels = {
    dashboard: 'Dashboard', properties: 'Properties', units: 'Units', tenants: 'Tenants',
    contracts: 'Contracts', bills: 'Bills', water: 'Water Billing', payments: 'Payments',
    announcements: 'Announcements', messages: 'Messages', reminders: 'Reminders', support: 'Support',
    't-dashboard': 'My Dashboard', 't-contract': 'My Contracts', 't-bills': 'My Bills',
    't-announcements': 'Announcements', 't-messages': 'Messages', 't-settings': 'Settings', 't-support': 'Support',
    'l-settings': 'Settings', 'admin-stats': 'Platform Overview', 'admin-landlords': 'All Landlords',
    'admin-tenants': 'All Tenants', 'admin-tickets': 'Support Tickets', 'admin-audit': 'Audit Log', 'admin-chat': 'Live Support Chat'
  };
  document.getElementById('topbar-title').textContent = labels[id] || id;
}

// ═══════════════════════════════════════════════
// MODAL
// ═══════════════════════════════════════════════
function openModal(title, body, footer = '') {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-footer').innerHTML = footer;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal(e) { if (!e || e.target === document.getElementById('modal-overlay')) document.getElementById('modal-overlay').classList.remove('open'); }
function closeModalDirect() { document.getElementById('modal-overlay').classList.remove('open'); }

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
function badge(status) {
  const map = {
    active: 'green', occupied: 'green', approved: 'green', paid: 'green', billed: 'green', resolved: 'green',
    pending: 'yellow', vacant: 'yellow', draft: 'yellow', open: 'yellow', in_progress: 'orange',
    overdue: 'red', terminated: 'red', rejected: 'red', high: 'red',
    expired: 'gray', maintenance: 'gray', water: 'blue', electricity: 'purple', rent: 'gray', other: 'gray',
    normal: 'gray', low: 'gray', custom: 'gray', water_reading: 'blue', bill_generation: 'purple', payment_collection: 'green'
  };
  return `<span class="badge badge-${map[status] || 'gray'}">${status?.replace(/_/g, ' ')}</span>`;
}
function fmt(val) { if (val === null || val === undefined) return '—'; return Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '—'; }
function fmtDateTime(d) { return d ? new Date(d).toLocaleString() : '—'; }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function openDoc(url) {
  if (!url) { alert('No document available'); return; }
  if (!url.startsWith('http')) { alert('Invalid document URL'); return; }
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(() => { try { document.body.removeChild(a); } catch (_) { } }, 500);
}
function copyCode(code) { navigator.clipboard.writeText(code).then(() => alert('Code copied!')).catch(() => { }); }

// ═══════════════════════════════════════════════
// CLOUDINARY UPLOAD
// ═══════════════════════════════════════════════
function cloudinaryUpload(opts = {}) {
  return new Promise((resolve, reject) => {
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
// LANDLORD DASHBOARD
// ═══════════════════════════════════════════════
async function loadLandlordDashboard() {
  const pg = document.getElementById('page-dashboard');
  pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const d = await apiFetch('/landlord/dashboard'); const s = d.summary || {};
    const remBanners = (d.due_reminders || []).map(r =>
      `<div class="reminder-banner"><span style="font-size:20px">🔔</span>
        <div><strong>${r.title}</strong><div style="font-size:12px;color:var(--warn);margin-top:2px">Due today</div></div></div>`).join('');
    pg.innerHTML = `${remBanners}
      <div class="stats-grid">
        <div class="stat-card"><div class="value">${s.total_properties || 0}</div><div class="label">Properties</div></div>
        <div class="stat-card"><div class="value">${s.total_units || 0}</div><div class="label">Units</div></div>
        <div class="stat-card"><div class="value">${s.occupied_units || 0}</div><div class="label">Occupied</div></div>
        <div class="stat-card"><div class="value">${s.vacant_units || 0}</div><div class="label">Vacant</div></div>
        <div class="stat-card"><div class="value">${s.total_tenants || 0}</div><div class="label">Tenants</div></div>
        <div class="stat-card"><div class="value">${d.unread_threads || 0}</div><div class="label">Unread Messages</div></div>
      </div>
      <div class="card"><div class="card-header"><h3>Your Landlord Code</h3></div>
        <div class="code-card">${d.landlord_code || '—'}</div>
        <div class="info-box">Share this code with tenants so they can register and join your account.</div>
        <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-outline" onclick="showLandlordQR()">📱 Show QR Code</button>
          <button class="btn btn-sm btn-outline" onclick="copyCode('${d.landlord_code}')">📋 Copy Code</button>
        </div>
      </div>
      <div class="grid-2">
        <div class="card"><div class="card-header"><h3>Recent Payments</h3></div>
          ${!(d.recent_payments || []).length ? '<p style="color:var(--muted);font-size:13px">No payments yet</p>' :
        `<div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Amount</th><th>Status</th></tr></thead><tbody>
            ${d.recent_payments.map(p => `<tr><td>${p.tenant_name}</td><td>₱${fmt(p.amount_paid)}</td><td>${badge(p.status)}</td></tr>`).join('')}
            </tbody></table></div>`}
        </div>
        <div class="card"><div class="card-header"><h3>Quick Actions</h3></div>
          <div style="display:flex;flex-direction:column;gap:10px">
            <button class="btn btn-brand" onclick="setPage('announcements');loadLandlordAnnouncements()">📣 Send Announcement</button>
            <button class="btn btn-outline" onclick="setPage('messages');loadMessages()">💬 View Messages</button>
            <button class="btn btn-outline" onclick="setPage('bills');loadBills()">💰 Manage Bills</button>
            <button class="btn btn-outline" onclick="setPage('payments');loadPayments()">💳 Review Payments</button>
          </div>
        </div>
      </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}

// ═══════════════════════════════════════════════
// PROPERTIES
// ═══════════════════════════════════════════════
async function loadProperties() {
  const pg = document.getElementById('page-properties'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const props = await apiFetch('/properties');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Properties (${props.length})</h3>
      <button class="btn btn-brand" onclick="showAddProperty()">+ Add Property</button></div>
      ${!props.length ? '<div class="empty-state"><div class="icon">🏢</div><p>No properties yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Address</th><th>Units</th><th>Occupied</th><th>Actions</th></tr></thead><tbody>
        ${props.map(p => `<tr><td><strong>${p.name}</strong></td><td>${p.address}</td><td>${p.unit_count || 0}</td><td>${p.occupied || 0}/${p.unit_count || 0}</td>
          <td class="btn-group"><button class="btn btn-sm btn-outline" onclick="loadUnitsForProperty(${p.id},'${p.name.replace(/'/g, "\\'")}')">Units</button>
          <button class="btn btn-sm btn-red" onclick="deleteProperty(${p.id})">Delete</button></td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
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
  if (!name || !address) { document.getElementById('m-prop-err').textContent = 'Required'; return; }
  try {
    await apiFetch('/properties', { method: 'POST', body: JSON.stringify({ name, address, city: document.getElementById('m-prop-city').value, country: document.getElementById('m-prop-country').value }) });
    closeModalDirect(); loadProperties();
  } catch (e) { document.getElementById('m-prop-err').textContent = e.message; }
}
async function deleteProperty(id) { if (!confirm('Delete?')) return; await apiFetch('/properties/' + id, { method: 'DELETE' }); loadProperties(); }

// ═══════════════════════════════════════════════
// UNITS
// ═══════════════════════════════════════════════
async function loadUnits() {
  const pg = document.getElementById('page-units'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const [units, props] = await Promise.all([apiFetch('/units'), apiFetch('/properties')]);
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>All Units (${units.length})</h3>
      <button class="btn btn-brand" onclick='showAddUnit(${JSON.stringify(props).replace(/'/g, "&apos;")})'>+ Add Unit</button></div>
      ${!units.length ? '<div class="empty-state"><p>No units yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Property</th><th>Unit</th><th>Beds</th><th>Rent</th><th>Status</th></tr></thead><tbody>
        ${units.map(u => `<tr><td>${u.property_name || '—'}</td><td><strong>${u.unit_number}</strong></td>
          <td>${u.bedrooms || '—'}</td><td>₱${fmt(u.rent_amount)}/mo</td><td>${badge(u.status)}</td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function loadUnitsForProperty(propId, propName) {
  setPage('units'); const pg = document.getElementById('page-units'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  const units = await apiFetch('/units?property_id=' + propId);
  pg.innerHTML = `<div class="card"><div class="card-header"><h3>Units — ${propName}</h3>
    <div class="btn-group"><button class="btn btn-outline" onclick="loadUnits()">← All</button>
    <button class="btn btn-brand" onclick="showAddUnitForProp(${propId})">+ Add Unit</button></div></div>
    ${!units.length ? '<div class="empty-state"><p>No units</p></div>' :
      `<div class="table-wrap"><table><thead><tr><th>Unit</th><th>Floor</th><th>Beds</th><th>Rent</th><th>Status</th></tr></thead><tbody>
      ${units.map(u => `<tr><td><strong>${u.unit_number}</strong></td><td>${u.floor_num || '—'}</td>
        <td>${u.bedrooms || '—'}</td><td>₱${fmt(u.rent_amount)}/mo</td><td>${badge(u.status)}</td></tr>`).join('')}
      </tbody></table></div>`}
  </div>`;
}
function showAddUnit(props) {
  if (!props || !props.length) { alert('Add a property first.'); return; }
  openModal('Add Unit', `
    <div class="form-group"><label>Property</label><select id="m-unit-prop">${props.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select></div>
    <div class="form-group"><label>Unit Number</label><input type="text" id="m-unit-num" placeholder="101, 2A…"/></div>
    <div class="grid-2"><div class="form-group"><label>Floor</label><input type="number" id="m-unit-floor"/></div>
    <div class="form-group"><label>Bedrooms</label><input type="number" id="m-unit-beds"/></div></div>
    <div class="grid-2"><div class="form-group"><label>Bathrooms</label><input type="number" id="m-unit-baths"/></div>
    <div class="form-group"><label>Area m²</label><input type="number" id="m-unit-area"/></div></div>
    <div class="form-group"><label>Monthly Rent ₱</label><input type="number" id="m-unit-rent"/></div>
    <p class="err-msg" id="m-unit-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitAddUnit()">Add</button>`);
}
function showAddUnitForProp(propId) { apiFetch('/properties').then(props => { showAddUnit(props); setTimeout(() => { const s = document.getElementById('m-unit-prop'); if (s) s.value = propId; }, 50); }); }
async function submitAddUnit() {
  const body = {
    property_id: document.getElementById('m-unit-prop').value, unit_number: document.getElementById('m-unit-num').value.trim(),
    floor_num: document.getElementById('m-unit-floor').value || null, bedrooms: document.getElementById('m-unit-beds').value || null,
    bathrooms: document.getElementById('m-unit-baths').value || null, area_sqm: document.getElementById('m-unit-area').value || null,
    rent_amount: document.getElementById('m-unit-rent').value
  };
  document.getElementById('m-unit-err').textContent = '';
  if (!body.unit_number || !body.rent_amount) { document.getElementById('m-unit-err').textContent = 'Required'; return; }
  try { await apiFetch('/units', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); loadUnits(); }
  catch (e) { document.getElementById('m-unit-err').textContent = e.message; }
}

// ═══════════════════════════════════════════════
// TENANTS
// ═══════════════════════════════════════════════
async function loadTenants() {
  const pg = document.getElementById('page-tenants'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const tenants = await apiFetch('/landlord/tenants');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Tenants (${tenants.length})</h3></div>
      ${!tenants.length ? `<div class="empty-state"><div class="icon">👥</div><p>No tenants yet. Share your landlord code.</p></div>` :
        `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Property</th><th>Unit</th><th>Contract</th><th>Actions</th></tr></thead><tbody>
        ${tenants.map(t => `<tr><td><strong>${t.full_name}</strong></td><td>${t.email}</td>
          <td>${t.property_name || '—'}</td><td>${t.unit_number || 'Not assigned'}</td>
          <td>${t.contract_status ? badge(t.contract_status) : '<span style="color:var(--muted);font-size:12px">No contract</span>'}</td>
          <td><button class="btn btn-sm btn-info" onclick="showNewThreadToTenant(${t.user_id || t.id},'${t.full_name.replace(/'/g, "\\'")}')">Message</button></td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}

// ═══════════════════════════════════════════════
// CONTRACTS
// ═══════════════════════════════════════════════
async function loadContracts() {
  const pg = document.getElementById('page-contracts'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const contracts = await apiFetch('/contracts');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Contracts (${contracts.length})</h3>
      <button class="btn btn-brand" onclick="showCreateContract()">+ New Contract</button></div>
      ${!contracts.length ? '<div class="empty-state"><p>No contracts yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Unit</th><th>Term</th><th>Rent</th><th>Contract Doc</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        ${contracts.map(c => `<tr>
          <td><strong>${c.tenant_name}</strong><br><small style="color:var(--muted)">${c.property_name}</small></td>
          <td>${c.unit_number}</td>
          <td style="font-size:12px">
            ${c.is_open_term ? '<span class="badge badge-blue">Open Term</span>' : `${fmtDate(c.start_date)} → ${fmtDate(c.end_date)}`}
            ${c.minimum_months ? `<br><small style="color:var(--muted)">Min ${c.minimum_months} mo</small>` : ''}
          </td>
          <td>₱${fmt(c.monthly_rent)}/mo</td>
          <td style="font-size:12px">
            ${c.contract_doc_url
            ? `<button class="btn btn-sm btn-outline" onclick="openDoc('${c.contract_doc_url}')">📄 View</button>
                 ${c.tenant_ack ? '<br><span class="badge badge-green" style="margin-top:4px">Acknowledged</span>' : '<br><span class="badge badge-yellow" style="margin-top:4px">Pending ACK</span>'}`
            : `<button class="btn btn-sm btn-brand" onclick="uploadContractDoc(${c.id})">📤 Upload</button>`}
          </td>
          <td>${badge(c.status)}</td>
          <td class="btn-group">${c.status === 'active' ? `
            <button class="btn btn-sm btn-warn" onclick="showExtendContract(${c.id})">Extend</button>
            <button class="btn btn-sm btn-red" onclick="showMoveOut(${c.id},'${c.tenant_name.replace(/'/g, "\\'")}')">Move Out</button>
            ${c.contract_doc_url ? `<button class="btn btn-sm btn-brand" onclick="uploadContractDoc(${c.id})">Re-upload</button>` : ''}` :
            c.status === 'move_out_pending' ? `<button class="btn btn-sm btn-warn" onclick="showMoveOutChecklist(${c.id})">📋 Checklist</button>` : ''}</td>
        </tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}

async function showCreateContract() {
  const [units, tenants] = await Promise.all([apiFetch('/units'), apiFetch('/landlord/tenants')]);
  const vacantUnits = units.filter(u => u.status === 'vacant');
  const unassigned = tenants.filter(t => !t.contract_status || t.contract_status !== 'active');
  openModal('Create Contract', `
    <div class="form-group"><label>Unit (vacant)</label><select id="m-c-unit"><option value="">— Select —</option>
      ${vacantUnits.map(u => `<option value="${u.id}">${u.property_name} — Unit ${u.unit_number} (₱${u.rent_amount}/mo)</option>`).join('')}</select></div>
    <div class="form-group"><label>Tenant</label><select id="m-c-tenant"><option value="">— Select —</option>
      ${unassigned.map(t => `<option value="${t.id}">${t.full_name} (${t.email})</option>`).join('')}</select></div>
    <div class="grid-2">
      <div class="form-group"><label>Contract Signed Date</label><input type="date" id="m-c-signed"/>
        <small style="color:var(--muted);font-size:11px">Date the contract was signed</small></div>
      <div class="form-group"><label>Lease Start Date</label><input type="date" id="m-c-start"/>
        <small style="color:var(--muted);font-size:11px">Official start of the lease period</small></div>
    </div>
    <div class="form-group"><label>Move-In Date <span style="color:var(--muted);font-weight:400">(optional)</span></label>
      <input type="date" id="m-c-movein"/>
      <small style="color:var(--muted);font-size:11px">Actual date tenant moves in</small></div>
    <div class="form-group" style="background:var(--bg);padding:12px;border-radius:8px;margin-bottom:8px">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;text-transform:none;font-size:14px;color:var(--text)">
        <input type="checkbox" id="m-c-open" onchange="toggleContractTermFields()" style="width:18px;height:18px"/>
        <span>Open Term (no fixed end date)</span>
      </label>
    </div>
    <div id="m-c-fixed-fields">
      <div class="form-group"><label>End Date</label><input type="date" id="m-c-end"/></div>
    </div>
    <div class="form-group">
      <label>Minimum Term (months)</label>
      <input type="number" id="m-c-minmonths" min="1" max="36" placeholder="e.g. 6 — leave blank if none"/>
    </div>
    <div class="grid-2">
      <div class="form-group"><label>Monthly Rent ₱</label><input type="number" id="m-c-rent"/></div>
      <div class="form-group"><label>Deposit ₱</label><input type="number" id="m-c-dep" value="0"/></div>
    </div>
    <p class="err-msg" id="m-c-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitCreateContract()">Create</button>`);
}
function toggleContractTermFields() {
  const open = document.getElementById('m-c-open').checked;
  document.getElementById('m-c-fixed-fields').style.display = open ? 'none' : '';
}
async function submitCreateContract() {
  const is_open_term = document.getElementById('m-c-open').checked;
  const body = {
    unit_id: document.getElementById('m-c-unit').value, tenant_id: document.getElementById('m-c-tenant').value,
    contract_signed_date: document.getElementById('m-c-signed').value || null,
    start_date: document.getElementById('m-c-start').value,
    move_in_date: document.getElementById('m-c-movein').value || null,
    end_date: is_open_term ? null : document.getElementById('m-c-end').value,
    monthly_rent: document.getElementById('m-c-rent').value,
    deposit: document.getElementById('m-c-dep').value || 0,
    is_open_term, minimum_months: document.getElementById('m-c-minmonths').value || null
  };
  document.getElementById('m-c-err').textContent = '';
  if (!body.unit_id || !body.tenant_id || !body.start_date || !body.monthly_rent) { document.getElementById('m-c-err').textContent = 'All required fields missing'; return; }
  if (!is_open_term && !body.end_date) { document.getElementById('m-c-err').textContent = 'End date required for fixed term'; return; }
  try { await apiFetch('/contracts', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); loadContracts(); }
  catch (e) { document.getElementById('m-c-err').textContent = e.message; }
}
async function uploadContractDoc(contractId) {
  try {
    const result = await cloudinaryUpload({ sources: ['local'], resourceType: 'auto', clientAllowedFormats: ['pdf', 'jpg', 'jpeg', 'png'], maxFileSize: 10000000 });
    await apiFetch('/contracts/' + contractId + '/upload-doc', { method: 'POST', body: JSON.stringify({ contract_doc_url: result.url, public_id: result.public_id }) });
    alert('✅ Contract uploaded! Tenant has been notified.');
    loadContracts();
  } catch (e) { if (e && e.message) alert('Upload failed: ' + e.message); }
}
function showMoveOut(contractId, tenantName) {
  const today = new Date().toISOString().split('T')[0];
  openModal(`Start Move-Out: ${tenantName}`, `
    <div class="info-box">This begins the move-out process. The contract stays active until you complete the checklist.</div>
    <div class="form-group"><label>Move-Out Date</label><input type="date" id="m-mo-date" value="${today}"/></div>
    <div class="form-group"><label>Notes (optional)</label>
      <textarea id="m-mo-notes" rows="3" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px"></textarea>
    </div><p class="err-msg" id="m-mo-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-warn" onclick="submitMoveOut(${contractId})">Start Move-Out</button>`);
}
async function submitMoveOut(contractId) {
  const move_out_date = document.getElementById('m-mo-date').value;
  const notes = document.getElementById('m-mo-notes').value;
  document.getElementById('m-mo-err').textContent = '';
  try { await apiFetch('/contracts/' + contractId + '/terminate', { method: 'PATCH', body: JSON.stringify({ move_out_date, notes }) }); closeModalDirect(); loadContracts(); }
  catch (e) { document.getElementById('m-mo-err').textContent = e.message; }
}
async function showMoveOutChecklist(contractId) {
  try {
    const d = await apiFetch('/contracts/' + contractId + '/move-out');
    const c = d.contract; const ch = d.checklist || {};
    openModal(`📋 Move-Out Checklist — ${c.tenant_name}`, `
      <div style="font-size:13px;color:var(--muted);margin-bottom:14px">Unit ${c.unit_number} · ${c.property_name} · Move-out: ${fmtDate(c.move_out_date) || 'TBD'}</div>
      <h4 style="font-size:14px;font-weight:600;margin-bottom:10px">💰 Security Deposit</h4>
      <div class="pref-row">
        <span class="pref-label">Deposit was consumed for repairs/damages?</span>
        <label class="toggle"><input type="checkbox" id="ch-dep-consumed" ${ch.deposit_consumed ? 'checked' : ''}/><span class="toggle-slider"></span></label>
      </div>
      <div class="form-group" style="margin-top:10px"><label>Amount Consumed ₱</label>
        <input type="number" id="ch-dep-amount" value="${ch.deposit_consumed_amount || 0}" min="0"/></div>
      <h4 style="font-size:14px;font-weight:600;margin:16px 0 10px">🔧 Repairs</h4>
      <div class="form-group"><label>Repair Status</label>
        <select id="ch-repair-status">
          <option value="not_required" ${(ch.repair_status || 'not_required') === 'not_required' ? 'selected' : ''}>No repairs needed</option>
          <option value="pending" ${ch.repair_status === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="cleared" ${ch.repair_status === 'cleared' ? 'selected' : ''}>Cleared</option>
        </select></div>
      <div class="form-group"><label>Repair Notes</label>
        <textarea id="ch-repair-notes" rows="3" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px">${ch.repair_notes || ''}</textarea></div>
      <div class="form-group"><label>Proof Documents</label>
        ${ch.repair_proof_url ? `<div style="margin-bottom:8px"><button class="btn btn-sm btn-outline" onclick="openDoc('${ch.repair_proof_url}')">📎 View Current</button></div>` : ''}
        <button class="btn btn-outline btn-sm" type="button" id="ch-proof-btn" onclick="uploadMoveOutProof(${contractId})">📤 Upload Receipts/Photos</button>
        <input type="hidden" id="ch-proof-url" value="${ch.repair_proof_url || ''}"/>
        <div id="ch-proof-status" style="font-size:12px;color:var(--success);margin-top:4px"></div>
      </div>
      <h4 style="font-size:14px;font-weight:600;margin:16px 0 10px">✅ Deposit Status</h4>
      <div class="form-group"><label>Status</label>
        <select id="ch-deposit-status">
          <option value="processing" ${(ch.deposit_status || 'processing') === 'processing' ? 'selected' : ''}>Processing</option>
          <option value="ready" ${ch.deposit_status === 'ready' ? 'selected' : ''}>Ready for Pickup</option>
          <option value="released" ${ch.deposit_status === 'released' ? 'selected' : ''}>Released</option>
        </select></div>
      <p class="err-msg" id="ch-err"></p>`,
      `<button class="btn btn-outline" onclick="closeModalDirect()">Close</button>
       <button class="btn btn-warn" onclick="saveMoveOutChecklist(${contractId})">💾 Save</button>
       ${ch.repair_status !== 'pending' ? `<button class="btn btn-green" onclick="completeMoveOut(${contractId})">✅ Complete Move-Out</button>` : '<span style="font-size:12px;color:var(--danger)">Resolve repairs first</span>'}`);
  } catch (e) { alert('Could not load checklist: ' + e.message); }
}
async function uploadMoveOutProof(contractId) {
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
  document.getElementById('ch-err').textContent = '';
  try {
    await apiFetch('/contracts/' + contractId + '/move-out', { method: 'PATCH', body: JSON.stringify(body) });
    closeModalDirect();
    if (body.deposit_status === 'ready') alert('✅ Tenant will be notified their deposit is ready.');
    loadContracts();
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
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button><button class="btn btn-brand" onclick="submitExtend(${id})">Extend</button>`);
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
  const pg = document.getElementById('page-bills'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const bills = await apiFetch('/bills');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Bills</h3>
      <div class="btn-group"><button class="btn btn-outline" onclick="generateMonthly()">⚡ Generate Monthly Rent</button>
      <button class="btn btn-brand" onclick="showCreateBill()">+ Add Bill</button></div></div>
      ${!bills.length ? '<div class="empty-state"><p>No bills yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Type</th><th>Description</th><th>Amount</th><th>Due</th><th>Status</th></tr></thead><tbody>
        ${bills.map(b => `<tr><td><strong>${b.tenant_name}</strong><br><small>${b.unit_number}</small></td>
          <td>${badge(b.bill_type || 'rent')}</td><td>${b.description}</td>
          <td>₱${fmt(b.amount)}</td><td>${fmtDate(b.due_date)}</td><td>${badge(b.status)}</td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function generateMonthly() {
  if (!confirm('Generate monthly rent bills?')) return;
  try { const d = await apiFetch('/bills/generate-monthly', { method: 'POST' }); alert(`Done! ${d.bills_generated} bills generated.`); loadBills(); }
  catch (e) { alert(e.message); }
}
async function showCreateBill() {
  const contracts = await apiFetch('/contracts'); const active = contracts.filter(c => c.status === 'active');
  const now = new Date();
  openModal('Create Bill', `
    <div class="form-group"><label>Contract</label><select id="m-b-contract"><option value="">— Select —</option>
      ${active.map(c => `<option value="${c.id}">${c.tenant_name} — Unit ${c.unit_number}</option>`).join('')}</select></div>
    <div class="form-group"><label>Bill Type</label><select id="m-b-type">
      <option value="rent">Rent</option><option value="electricity">Electricity</option><option value="other">Other</option></select></div>
    <div class="grid-2"><div class="form-group"><label>Month</label><select id="m-b-month">
      ${MONTHS.map((m, i) => `<option value="${i + 1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
    <div class="form-group"><label>Year</label><input type="number" id="m-b-year" value="${now.getFullYear()}"/></div></div>
    <div class="form-group"><label>Description</label><input type="text" id="m-b-desc"/></div>
    <div class="form-group"><label>Amount ₱</label><input type="number" id="m-b-amt"/></div>
    <div class="form-group"><label>Due Date</label><input type="date" id="m-b-due"/></div>
    <p class="err-msg" id="m-b-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitCreateBill()">Create</button>`);
}
async function submitCreateBill() {
  const body = {
    contract_id: document.getElementById('m-b-contract').value, description: document.getElementById('m-b-desc').value.trim(),
    bill_type: document.getElementById('m-b-type').value, bill_month: document.getElementById('m-b-month').value,
    bill_year: document.getElementById('m-b-year').value, amount: document.getElementById('m-b-amt').value,
    due_date: document.getElementById('m-b-due').value
  };
  document.getElementById('m-b-err').textContent = '';
  try { await apiFetch('/bills', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); loadBills(); }
  catch (e) { document.getElementById('m-b-err').textContent = e.message; }
}

// ═══════════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════════
async function loadPayments() {
  const pg = document.getElementById('page-payments'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const payments = await apiFetch('/payments');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Payments</h3></div>
      ${!payments.length ? '<div class="empty-state"><p>No payments yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Bill</th><th>Type</th><th>Amount</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead><tbody>
        ${payments.map(p => `<tr><td>${p.tenant_name}</td><td style="font-size:12px">${p.bill_desc}</td>
          <td>${badge(p.bill_type || 'rent')}</td><td>₱${fmt(p.amount_paid)}</td><td>${badge(p.status)}</td>
          <td style="font-size:12px">${fmtDate(p.paid_at)}</td>
          <td class="btn-group">${p.status === 'pending' ? `
            <button class="btn btn-sm btn-green" onclick="reviewPayment(${p.id},'approve')">✓ Approve</button>
            <button class="btn btn-sm btn-red" onclick="rejectPaymentModal(${p.id})">✗ Reject</button>` : ''}
            ${p.proof_url ? `<button class="btn btn-sm btn-outline" onclick="openDoc('${p.proof_url}')">📎 Proof</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function reviewPayment(id, action) { await apiFetch('/payments/' + id + '/' + action, { method: 'PATCH', body: '{}' }); loadPayments(); }
function rejectPaymentModal(id) {
  openModal('Reject Payment', `<div class="form-group"><label>Reason</label>
    <textarea id="m-reject-notes" rows="3" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px"></textarea></div>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-red" onclick="submitReject(${id})">Reject</button>`);
}
async function submitReject(id) {
  const notes = document.getElementById('m-reject-notes').value;
  await apiFetch('/payments/' + id + '/reject', { method: 'PATCH', body: JSON.stringify({ notes }) }); closeModalDirect(); loadPayments();
}

// ═══════════════════════════════════════════════
// ANNOUNCEMENTS — LANDLORD
// ═══════════════════════════════════════════════
async function loadLandlordAnnouncements() {
  const pg = document.getElementById('page-announcements'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const [announcements, props] = await Promise.all([apiFetch('/announcements'), apiFetch('/properties')]);
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Announcements (${announcements.length})</h3>
      <button class="btn btn-brand" onclick='showCreateAnnouncement(${JSON.stringify(props).replace(/"/g, "&quot;")})'>+ New Announcement</button></div>
      <div class="info-box">Send announcements to tenants — maintenance updates, payment reminders, or general notices.</div>
      ${!announcements.length ? '<div class="empty-state"><div class="icon">📣</div><p>No announcements yet</p></div>' :
        announcements.map(a => `
          <div class="announcement-card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
              <div class="ann-subject">📣 ${a.subject}</div>
              <div class="btn-group">${a.is_active ? `<button class="btn btn-sm btn-red" onclick="deleteAnnouncement(${a.id})">Remove</button>` : '<span class="badge badge-gray">Removed</span>'}</div>
            </div>
            <div class="ann-body">${a.body}</div>
            <div class="ann-meta">
              <span>${a.target_all ? '📡 All Properties' : '🏢 Selected Properties'}</span>
              ${a.expires_at ? `<span>⏰ Expires ${fmtDate(a.expires_at)}</span>` : ''}
              <span>📅 ${fmtDate(a.created_at)}</span>
            </div>
          </div>`).join('')}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
function showCreateAnnouncement(props) {
  openModal('New Announcement', `
    <div class="form-group"><label>Subject</label><input type="text" id="m-ann-subject" placeholder="e.g. Water interruption this Saturday"/></div>
    <div class="form-group"><label>Message</label>
      <textarea id="m-ann-body" rows="5" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px" placeholder="Write your announcement here…"></textarea></div>
    <div class="form-group" style="background:var(--bg);padding:12px;border-radius:8px">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;text-transform:none;font-size:14px;color:var(--text)">
        <input type="checkbox" id="m-ann-all" onchange="toggleAnnPropertySelect()" style="width:18px;height:18px" checked/>
        <span><strong>Send to ALL properties</strong></span>
      </label>
    </div>
    <div id="m-ann-props-wrap" style="display:none">
      <div class="form-group"><label>Select Properties</label>
        <div id="m-ann-prop-checks" style="display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--bg);border-radius:8px">
          ${props.map(p => `<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
            <input type="checkbox" class="ann-prop-cb" value="${p.id}" style="width:16px;height:16px"/>${p.name}</label>`).join('')}
        </div>
      </div>
    </div>
    <div class="form-group"><label>Expiry Date (optional)</label>
      <input type="date" id="m-ann-expires"/>
      <small style="color:var(--muted);font-size:12px;margin-top:4px;display:block">Announcement will be hidden after this date.</small></div>
    <p class="err-msg" id="m-ann-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitCreateAnnouncement()">Send Announcement</button>`);
}
function toggleAnnPropertySelect() { const all = document.getElementById('m-ann-all').checked; document.getElementById('m-ann-props-wrap').style.display = all ? 'none' : ''; }
async function submitCreateAnnouncement() {
  const subject = document.getElementById('m-ann-subject').value.trim();
  const body = document.getElementById('m-ann-body').value.trim();
  const target_all = document.getElementById('m-ann-all').checked;
  const property_ids = [...document.querySelectorAll('.ann-prop-cb:checked')].map(cb => parseInt(cb.value));
  const expires_at = document.getElementById('m-ann-expires').value || null;
  document.getElementById('m-ann-err').textContent = '';
  if (!subject || !body) { document.getElementById('m-ann-err').textContent = 'Subject and message are required'; return; }
  if (!target_all && !property_ids.length) { document.getElementById('m-ann-err').textContent = 'Select at least one property'; return; }
  try {
    await apiFetch('/announcements', { method: 'POST', body: JSON.stringify({ subject, body, target_all, property_ids, expires_at }) });
    closeModalDirect(); alert('✅ Announcement sent!'); loadLandlordAnnouncements();
  } catch (e) { document.getElementById('m-ann-err').textContent = e.message; }
}
async function deleteAnnouncement(id) {
  if (!confirm('Remove this announcement?')) return;
  await apiFetch('/announcements/' + id, { method: 'DELETE' }); loadLandlordAnnouncements();
}

// ═══════════════════════════════════════════════
// MESSAGES — LANDLORD
// ═══════════════════════════════════════════════
const LANDLORD_SUBJECTS = ['Payment Reminder', 'Lease Renewal', 'Maintenance Notice', 'Unit Inspection', 'Contract Update', 'Rent Increase Notice', 'Welcome', 'Others'];
const TENANT_SUBJECTS = ['Maintenance Request', 'Late Payment Notice', 'Lease Question', 'Moving Out Notice', 'General Inquiry', 'Emergency', 'Others'];

async function loadMessages() {
  const pg = document.getElementById('page-messages'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const threads = await apiFetch('/threads');
    const unread = threads.filter(t => !t.is_read_landlord).length;
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Messages ${unread > 0 ? `<span class="badge badge-red">${unread} unread</span>` : ''}</h3>
      <button class="btn btn-brand" onclick="showNewThread()">+ New Message</button></div>
      ${!threads.length ? '<div class="empty-state"><div class="icon">💬</div><p>No messages yet</p></div>' :
        threads.map(t => `<div class="thread-list-item ${!t.is_read_landlord ? 'unread' : ''}" onclick="openThread(${t.id})">
          <div class="thread-avatar">${(t.other_name || 'T')[0].toUpperCase()}</div>
          <div class="thread-info">
            <div class="tname">${t.other_name} ${!t.is_read_landlord ? '🔵' : ''}</div>
            <div class="tsubject"><strong>${t.subject}</strong></div>
            <div class="tlast">${(t.last_message || '').substring(0, 60)}</div>
          </div>
          <div class="thread-time">${fmtDate(t.last_reply_at)}</div>
        </div>`).join('')}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function showNewThread() {
  const tenants = await apiFetch('/landlord/tenants');
  openModal('New Message to Tenant', `
    <div class="form-group"><label>To (Tenant)</label><select id="m-nt-tenant"><option value="">— Select tenant —</option>
      ${tenants.map(t => `<option value="${t.user_id || t.id}">${t.full_name}${t.unit_number ? ' — Unit ' + t.unit_number : ''}</option>`).join('')}</select></div>
    <div class="form-group"><label>Subject</label>
      <select id="m-nt-subject">${LANDLORD_SUBJECTS.map(s => `<option value="${s}">${s}</option>`).join('')}</select></div>
    <div class="form-group"><label>Message</label>
      <textarea id="m-nt-body" rows="4" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px" placeholder="Type your message…"></textarea></div>
    <p class="err-msg" id="m-nt-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitNewThreadLandlord()">Send</button>`);
}
async function showNewThreadToTenant(tenantUserId, tenantName) {
  openModal(`Message to ${tenantName}`, `
    <div class="form-group"><label>Subject</label>
      <select id="m-nt-subject">${LANDLORD_SUBJECTS.map(s => `<option value="${s}">${s}</option>`).join('')}</select></div>
    <div class="form-group"><label>Message</label>
      <textarea id="m-nt-body" rows="4" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px" placeholder="Type your message…"></textarea></div>
    <input type="hidden" id="m-nt-uid" value="${tenantUserId}"/>
    <p class="err-msg" id="m-nt-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitNewThreadToTenantDirect()">Send</button>`);
}
async function submitNewThreadToTenantDirect() {
  const tenant_user_id = document.getElementById('m-nt-uid').value;
  const subject = document.getElementById('m-nt-subject').value.trim();
  const body = document.getElementById('m-nt-body').value.trim();
  document.getElementById('m-nt-err').textContent = '';
  if (!subject || !body) { document.getElementById('m-nt-err').textContent = 'All fields required'; return; }
  try { await apiFetch('/threads', { method: 'POST', body: JSON.stringify({ subject, body, tenant_user_id: parseInt(tenant_user_id) }) }); closeModalDirect(); loadMessages(); }
  catch (e) { document.getElementById('m-nt-err').textContent = e.message; }
}
async function submitNewThreadLandlord() {
  const tenant_user_id = document.getElementById('m-nt-tenant').value;
  const subject = document.getElementById('m-nt-subject').value.trim();
  const body = document.getElementById('m-nt-body').value.trim();
  document.getElementById('m-nt-err').textContent = '';
  if (!tenant_user_id || !subject || !body) { document.getElementById('m-nt-err').textContent = 'All fields required'; return; }
  try { await apiFetch('/threads', { method: 'POST', body: JSON.stringify({ subject, body, tenant_user_id: parseInt(tenant_user_id) }) }); closeModalDirect(); loadMessages(); }
  catch (e) { document.getElementById('m-nt-err').textContent = e.message; }
}
async function openThread(tid) {
  const d = await apiFetch('/threads/' + tid);
  const t = d.thread; const replies = d.replies || [];
  openModal(t.subject, `
    <div style="font-size:12px;color:var(--muted);margin-bottom:12px">Conversation with ${t.other_name || 'tenant'}</div>
    <div class="chat-wrap" id="chat-wrap">
      ${replies.map(r => { const mine = r.sender_id === currentUser.id; return `<div class="bubble ${mine ? 'mine' : 'theirs'}">
        <div class="bname">${mine ? 'You' : r.sender_name}</div>
        <div>${r.body}</div><div class="btime">${fmtDateTime(r.sent_at)}</div></div>`; }).join('')}
    </div>
    <div style="margin-top:12px">
      <textarea id="reply-body" rows="3" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px" placeholder="Type your reply…"></textarea>
    </div>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Close</button>
     <button class="btn btn-brand" onclick="submitReplyThread(${tid})">Send Reply</button>`);
  setTimeout(() => { const cw = document.getElementById('chat-wrap'); if (cw) cw.scrollTop = cw.scrollHeight; }, 100);
}
async function submitReplyThread(tid) {
  const body = document.getElementById('reply-body').value.trim();
  if (!body) { alert('Please type a message'); return; }
  try {
    await apiFetch('/threads/' + tid + '/reply', { method: 'POST', body: JSON.stringify({ body }) });
    closeModalDirect();
    if (currentUser.role === 'landlord') loadMessages(); else loadTenantMessages();
  } catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// WATER BILLING
// ═══════════════════════════════════════════════
async function loadWaterBilling() {
  const pg = document.getElementById('page-water'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const [sessions, props] = await Promise.all([apiFetch('/water/sessions'), apiFetch('/properties')]);
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Water Billing Sessions</h3>
      <button class="btn btn-brand" onclick='showNewWaterSession(${JSON.stringify(props)})'>+ New Session</button></div>
      <div class="info-box">Enter monthly water meter readings per property. System calculates each unit's bill automatically.</div>
      ${!sessions.length ? '<div class="empty-state"><div class="icon">💧</div><p>No sessions yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Property</th><th>Month</th><th>Main Bill</th><th>Rate/Cubic</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        ${sessions.map(s => `<tr><td><strong>${s.property_name}</strong></td>
          <td>${MONTHS[s.session_month - 1]} ${s.session_year}</td>
          <td>₱${fmt(s.total_bill)}</td><td>₱${fmt(s.price_per_cubic)}</td><td>${badge(s.status)}</td>
          <td><button class="btn btn-sm btn-brand" onclick="openWaterSession(${s.id})">${s.status === 'draft' ? 'Enter Readings' : 'View'}</button></td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
function showNewWaterSession(props) {
  const now = new Date();
  openModal('New Water Billing Session', `
    <div class="form-group"><label>Property</label><select id="m-w-prop">${props.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select></div>
    <div class="grid-2"><div class="form-group"><label>Month</label><select id="m-w-month">
      ${MONTHS.map((m, i) => `<option value="${i + 1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
    <div class="form-group"><label>Year</label><input type="number" id="m-w-year" value="${now.getFullYear()}"/></div></div>
    <div class="grid-2"><div class="form-group"><label>Previous Reading Date</label><input type="date" id="m-w-prev-date"/></div>
    <div class="form-group"><label>Present Reading Date</label><input type="date" id="m-w-curr-date"/></div></div>
    <div class="grid-2"><div class="form-group"><label>Total Main Bill ₱</label><input type="number" id="m-w-bill" step="0.01" oninput="calcWaterRate()"/></div>
    <div class="form-group"><label>Overall Consumption cu</label><input type="number" id="m-w-cons" oninput="calcWaterRate()"/></div></div>
    <div class="grid-2"><div class="form-group"><label>Water Pump Total ₱</label><input type="number" id="m-w-pump" step="0.01" oninput="calcWaterRate()"/></div>
    <div class="form-group"><label>Number of Units</label><input type="number" id="m-w-units" oninput="calcWaterRate()"/></div></div>
    <div id="water-rate-preview" class="water-calc" style="display:none">
      <div class="row"><span>Price per cubic meter</span><span id="w-rate-val">—</span></div>
      <div class="row"><span>Pump fee per unit</span><span id="w-pump-val">—</span></div>
    </div><p class="err-msg" id="m-w-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitNewWaterSession()">Create Session</button>`);
}
function calcWaterRate() {
  const bill = parseFloat(document.getElementById('m-w-bill')?.value || 0);
  const cons = parseFloat(document.getElementById('m-w-cons')?.value || 0);
  const pump = parseFloat(document.getElementById('m-w-pump')?.value || 0);
  const units = parseInt(document.getElementById('m-w-units')?.value || 1);
  if (bill > 0 && cons > 0) {
    document.getElementById('water-rate-preview').style.display = 'block';
    document.getElementById('w-rate-val').textContent = '₱' + (bill / cons).toFixed(4);
    document.getElementById('w-pump-val').textContent = '₱' + (units > 0 ? pump / units : 0).toFixed(4);
  }
}
async function submitNewWaterSession() {
  const body = {
    property_id: document.getElementById('m-w-prop').value, session_month: document.getElementById('m-w-month').value,
    session_year: document.getElementById('m-w-year').value, prev_reading_date: document.getElementById('m-w-prev-date').value,
    curr_reading_date: document.getElementById('m-w-curr-date').value, total_bill: document.getElementById('m-w-bill').value,
    overall_consumption: document.getElementById('m-w-cons').value,
    pump_total: document.getElementById('m-w-pump').value || 0, number_of_units: document.getElementById('m-w-units').value || 1
  };
  document.getElementById('m-w-err').textContent = '';
  if (!body.prev_reading_date || !body.curr_reading_date || !body.total_bill || !body.overall_consumption) { document.getElementById('m-w-err').textContent = 'All fields required'; return; }
  try { const d = await apiFetch('/water/sessions', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); openWaterSession(d.session_id); loadWaterBilling(); }
  catch (e) { document.getElementById('m-w-err').textContent = e.message; }
}
async function openWaterSession(sid) {
  setPage('water'); const pg = document.getElementById('page-water'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading session…</p>';
  try {
    const d = await apiFetch('/water/sessions/' + sid); const s = d.session; const readings = d.readings || [];
    const units = await apiFetch('/units?property_id=' + s.property_id);
    const readingMap = {}; readings.forEach(r => readingMap[r.unit_id] = r);
    pg.innerHTML = `<div class="card" style="margin-bottom:16px">
      <div class="card-header"><div><h3>💧 ${s.property_name} — ${MONTHS[s.session_month - 1]} ${s.session_year}</h3>
        <div style="font-size:13px;color:var(--muted);margin-top:4px">${fmtDate(s.prev_reading_date)} → ${fmtDate(s.curr_reading_date)}</div></div>
        <button class="btn btn-outline" onclick="loadWaterBilling()">← Back</button></div>
      <div class="water-calc">
        <div class="row"><span>Total Main Bill</span><span>₱${fmt(s.total_bill)}</span></div>
        <div class="row"><span>Overall Consumption</span><span>${s.overall_consumption} cu</span></div>
        <div class="row"><span>Price per Cubic</span><span>₱${parseFloat(s.price_per_cubic).toFixed(4)}</span></div>
        <div class="row"><span>Pump Fee per Unit</span><span>₱${parseFloat(s.pump_per_unit).toFixed(4)}</span></div>
      </div></div>
      <div class="card"><div class="card-header"><h3>Unit Readings</h3></div>
      ${s.status === 'billed' ? '<div class="info-box">Bills generated. View them in the Bills tab.</div>' : ''}
      <div class="table-wrap"><table><thead><tr><th>Unit</th><th>Owner?</th><th>Previous cu</th><th>Current cu</th><th>Consumption</th><th>Water Bill</th><th>Pump</th><th>Total</th></tr></thead><tbody>
      ${units.map(u => { const r = readingMap[u.id] || {}; return `<tr id="row-${u.id}">
        <td><strong>${u.unit_number}</strong></td>
        <td><input type="checkbox" id="owner-${u.id}" ${r.is_owner_unit ? 'checked' : ''} ${s.status === 'billed' ? 'disabled' : ''}/></td>
        <td><input type="number" id="prev-${u.id}" value="${r.prev_reading || ''}" style="width:90px;padding:6px;border:1.5px solid var(--border);border-radius:6px" oninput="recalcRow(${u.id})" ${s.status === 'billed' ? 'disabled' : ''}/></td>
        <td><input type="number" id="curr-${u.id}" value="${r.curr_reading || ''}" style="width:90px;padding:6px;border:1.5px solid var(--border);border-radius:6px" oninput="recalcRow(${u.id})" ${s.status === 'billed' ? 'disabled' : ''}/></td>
        <td id="cons-${u.id}">${r.consumption != null ? r.consumption + ' cu' : '—'}</td>
        <td id="wb-${u.id}">${r.water_bill != null ? '₱' + fmt(r.water_bill) : '—'}</td>
        <td id="pf-${u.id}">${r.pump_fee != null ? '₱' + fmt(r.pump_fee) : '—'}</td>
        <td id="tot-${u.id}" style="font-weight:600;color:var(--brand)">${r.total_amount != null ? '₱' + fmt(r.total_amount) : '—'}</td>
      </tr>`; }).join('')}
      </tbody></table></div>
      ${s.status !== 'billed' ? `<div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-outline" onclick="saveWaterReadings(${sid},${JSON.stringify(units).replace(/"/g, '&quot;')})">💾 Save Readings</button>
        <button class="btn btn-brand" onclick="showGenerateWaterBills(${sid})">⚡ Generate Bills</button></div>` : ''}
      </div>`;
    window._waterSession = s; window._waterUnits = units;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
function recalcRow(unitId) {
  const s = window._waterSession; if (!s) return;
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
async function saveWaterReadings(sid, units) {
  const readings = units.map(u => ({
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
  openModal('Generate Water Bills', `<div class="info-box">This creates water bills for all non-owner units. Save all readings first.</div>
    <div class="form-group"><label>Due Date</label><input type="date" id="m-wbill-due" value="${defaultDue}"/></div>
    <p class="err-msg" id="m-wbill-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitGenerateWaterBills(${sid})">Generate Bills</button>`);
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
  const pg = document.getElementById('page-reminders'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const reminders = await apiFetch('/reminders'); const today = new Date().getDate();
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Reminders</h3>
      <button class="btn btn-brand" onclick="showAddReminder()">+ Add Reminder</button></div>
      <div class="info-box">Reminders appear on your dashboard on the day you set every month.</div>
      ${!reminders.length ? '<div class="empty-state"><div class="icon">🔔</div><p>No reminders yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Type</th><th>Day</th><th>Actions</th></tr></thead><tbody>
        ${reminders.map(r => `<tr><td><strong>${r.title}</strong></td><td>${badge(r.reminder_type)}</td>
          <td>Every ${r.day_of_month}${r.day_of_month === today ? ' 🔔 Today' : ''}</td>
          <td><button class="btn btn-sm btn-red" onclick="deleteReminder(${r.id})">Delete</button></td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
function showAddReminder() {
  openModal('Add Reminder', `
    <div class="form-group"><label>Title</label><input type="text" id="m-rem-title" placeholder="Read water meters…"/></div>
    <div class="form-group"><label>Type</label><select id="m-rem-type">
      <option value="water_reading">Water Meter Reading</option><option value="bill_generation">Bill Generation</option>
      <option value="payment_collection">Payment Collection</option><option value="custom">Custom</option></select></div>
    <div class="form-group"><label>Day of Month (1–28)</label><input type="number" id="m-rem-day" min="1" max="28" placeholder="1"/>
      <small style="color:var(--muted);font-size:12px;margin-top:4px;display:block">Appears on dashboard on this day every month</small></div>
    <p class="err-msg" id="m-rem-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitAddReminder()">Add</button>`);
}
async function submitAddReminder() {
  const body = { title: document.getElementById('m-rem-title').value.trim(), reminder_type: document.getElementById('m-rem-type').value, day_of_month: document.getElementById('m-rem-day').value };
  document.getElementById('m-rem-err').textContent = '';
  if (!body.title || !body.day_of_month) { document.getElementById('m-rem-err').textContent = 'All fields required'; return; }
  try { await apiFetch('/reminders', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); loadReminders(); }
  catch (e) { document.getElementById('m-rem-err').textContent = e.message; }
}
async function deleteReminder(id) { if (!confirm('Delete?')) return; await apiFetch('/reminders/' + id, { method: 'DELETE' }); loadReminders(); }

// ═══════════════════════════════════════════════
// SUPPORT (Landlord & Tenant)
// ═══════════════════════════════════════════════
async function loadSupport(role) {
  const pageId = role === 'tenant' ? 't-support' : 'support';
  const pg = document.getElementById('page-' + pageId);
  pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  let chats = [], tickets = [];
  try { chats = await apiFetch('/support-chat'); } catch (_) { }
  try { tickets = await apiFetch('/tickets'); } catch (_) { }
  const openChat = chats.find(c => c.status === 'open');
  const unreadTickets = tickets.filter(t => t.unread_count > 0).length;
  window._supportTab = window._supportTab || 'chat';

  function renderSupport(tab) {
    window._supportTab = tab;
    const chatActive = tab === 'chat';
    pg.innerHTML = `
      <div style="display:flex;gap:0;margin-bottom:16px;border:1.5px solid var(--border);border-radius:var(--radius);overflow:hidden">
        <button onclick="renderSupportTab('chat')" style="flex:1;padding:10px;border:none;font-weight:600;font-size:14px;cursor:pointer;
          background:${chatActive ? 'var(--brand)' : 'var(--surface)'};color:${chatActive ? '#fff' : 'var(--text)'}">💬 Live Chat</button>
        <button onclick="renderSupportTab('tickets')" style="flex:1;padding:10px;border:none;font-weight:600;font-size:14px;cursor:pointer;
          background:${!chatActive ? 'var(--brand)' : 'var(--surface)'};color:${!chatActive ? '#fff' : 'var(--text)'}">
          🎫 Tickets ${unreadTickets > 0 ? `<span style="background:var(--danger);color:#fff;border-radius:50%;padding:1px 6px;font-size:11px">${unreadTickets}</span>` : ''}</button>
      </div>
      <div id="support-tab-content"></div>`;
    const tc = document.getElementById('support-tab-content');
    if (chatActive) {
      if (openChat) { loadSupportChat(openChat.id, pageId); return; }
      tc.innerHTML = `
        <div class="card">
          <div class="card-header"><h3>💬 Chat with Support</h3></div>
          <div class="info-box">Start a conversation with our support team.</div>
          <div class="form-group" style="margin-top:14px"><label>Subject</label>
            <select id="chat-subject">
              <option>Billing Issue</option><option>Technical Problem</option>
              <option>Account Help</option><option>Contract Question</option>
              <option>Feature Request</option><option>Other</option>
            </select></div>
          <div class="form-group"><label>Message</label>
            <textarea id="chat-body" rows="4" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px" placeholder="Describe your issue…"></textarea></div>
          <button class="btn btn-brand" onclick="startSupportChat('${pageId}')">Start Chat</button>
          <p class="err-msg" id="chat-err"></p>
        </div>
        ${chats.filter(c => c.status !== 'open').length ? `<div class="card"><div class="card-header"><h3>Previous Chats</h3></div>
          ${chats.filter(c => c.status !== 'open').map(c => `<div class="ticket-item" onclick="loadSupportChat(${c.id},'${pageId}')">
            <div class="ttitle">${c.subject} ${badge(c.status)}</div>
            <div class="tmeta"><span>📅 ${fmtDate(c.last_message_at)}</span></div>
          </div>`).join('')}
        </div>` : ''}`;
    } else {
      tc.innerHTML = `
        <div class="card">
          <div class="card-header"><h3>My Support Tickets</h3>
            <button class="btn btn-brand" onclick="showNewTicket('${pageId}')">+ New Ticket</button></div>
          ${!tickets.length ? '<div class="empty-state"><div class="icon">🎫</div><p>No tickets yet</p></div>' :
          tickets.map(t => `<div class="ticket-item" onclick="openTicket(${t.id},'${pageId}')">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div class="ttitle">#${t.id} ${t.title} ${t.unread_count > 0 ? `<span class="badge badge-red">${t.unread_count} new</span>` : ''}</div>
              <div style="display:flex;gap:6px;flex-shrink:0">${badge(t.priority)}${badge(t.status)}</div>
            </div>
            <div class="tmeta"><span>📁 ${t.category}</span><span>💬 ${t.reply_count} replies</span><span>📅 ${fmtDate(t.created_at)}</span></div>
          </div>`).join('')}
        </div>`;
    }
  }
  window.renderSupportTab = function (tab) { renderSupport(tab); };
  renderSupport(window._supportTab);
}
async function startSupportChat(pageId) {
  const subject = document.getElementById('chat-subject').value;
  const body = document.getElementById('chat-body').value.trim();
  document.getElementById('chat-err').textContent = '';
  if (!body) { document.getElementById('chat-err').textContent = 'Please describe your issue'; return; }
  try { const d = await apiFetch('/support-chat', { method: 'POST', body: JSON.stringify({ subject, body }) }); await loadSupportChat(d.chat_id, pageId); }
  catch (e) { document.getElementById('chat-err').textContent = e.message; }
}
async function loadSupportChat(chatId, pageId) {
  const tc = document.getElementById('support-tab-content');
  const pg = tc || document.getElementById('page-' + pageId);
  pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading chat…</p>';
  try {
    const d = await apiFetch('/support-chat/' + chatId);
    const chat = d.chat; const msgs = d.messages || []; const closed = chat.status !== 'open';
    pg.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div><h3>💬 ${chat.subject}</h3><div style="font-size:12px;color:var(--muted);margin-top:2px">Support Chat ${badge(chat.status)}</div></div>
        </div>
        <div class="chat-wrap" id="support-chat-wrap">
          ${msgs.map(m => { const mine = m.sender_id === currentUser.id; const isSupport = m.sender_role === 'admin';
            return `<div class="bubble ${mine ? 'mine' : 'theirs'}">
              <div class="bname">${mine ? 'You' : (isSupport ? '🛡️ Support' : m.sender_name)}</div>
              <div>${m.body}</div><div class="btime">${fmtDateTime(m.sent_at)}</div>
            </div>`; }).join('')}
          ${msgs.length === 0 ? '<div style="text-align:center;color:var(--muted);padding:20px;font-size:13px">Waiting for support to respond…</div>' : ''}
        </div>
        ${!closed ? `<div style="margin-top:12px;display:flex;gap:8px">
          <textarea id="support-reply-body" rows="2" style="flex:1;padding:10px;border:1.5px solid var(--border);border-radius:8px" placeholder="Type your message…"></textarea>
          <button id="support-send-btn" class="btn btn-brand" style="align-self:flex-end" onclick="sendSupportReply(${chatId},'${pageId}')">Send</button>
        </div>` : `<div class="info-box" style="margin-top:10px">This chat has been ${chat.status}. <button class="btn btn-sm btn-brand" onclick="loadSupport('${currentUser.role}')">Start New Chat</button></div>`}
      </div>`;
    setTimeout(() => { const w = document.getElementById('support-chat-wrap'); if (w) w.scrollTop = w.scrollHeight; }, 100);
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function sendSupportReply(chatId, pageId) {
  const body = document.getElementById('support-reply-body').value.trim();
  if (!body) return;
  const btn = document.getElementById('support-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try { await apiFetch('/support-chat/' + chatId + '/reply', { method: 'POST', body: JSON.stringify({ body }) }); await loadSupportChat(chatId, pageId); }
  catch (e) { alert(e.message); if (btn) { btn.disabled = false; btn.textContent = 'Send'; } }
}
function showNewTicket(pageId) {
  openModal('Open Support Ticket', `
    <div class="form-group"><label>Title / Subject</label><input type="text" id="m-tk-title" placeholder="Brief description of your issue"/></div>
    <div class="grid-2"><div class="form-group"><label>Category</label><select id="m-tk-cat">
      <option value="billing">Billing</option><option value="technical">Technical</option>
      <option value="account">Account</option><option value="contract">Contract</option><option value="other">Other</option></select></div>
    <div class="form-group"><label>Priority</label><select id="m-tk-pri">
      <option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></div></div>
    <div class="form-group"><label>Describe your issue</label>
      <textarea id="m-tk-body" rows="5" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px" placeholder="Please provide as much detail as possible…"></textarea></div>
    <p class="err-msg" id="m-tk-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitNewTicket('${pageId}')">Submit Ticket</button>`);
}
async function submitNewTicket(pageId) {
  const body = { title: document.getElementById('m-tk-title').value.trim(), category: document.getElementById('m-tk-cat').value, priority: document.getElementById('m-tk-pri').value, body: document.getElementById('m-tk-body').value.trim() };
  document.getElementById('m-tk-err').textContent = '';
  if (!body.title || !body.body) { document.getElementById('m-tk-err').textContent = 'Title and description required'; return; }
  try { await apiFetch('/tickets', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); alert('✅ Ticket submitted!'); loadSupport(currentUser.role); }
  catch (e) { document.getElementById('m-tk-err').textContent = e.message; }
}
async function openTicket(tid, pageId) {
  const d = await apiFetch('/tickets/' + tid);
  const t = d.ticket; const replies = d.replies || []; const isAdmin = currentUser.role === 'admin';
  openModal(`#${t.id} — ${t.title}`, `
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      ${badge(t.status)}${badge(t.priority)}${badge(t.category)}
      ${isAdmin && t.status !== 'resolved' ? `<button class="btn btn-sm btn-green" onclick="resolveTicket(${t.id},'${pageId}')">✓ Mark Resolved</button>` : ''}
    </div>
    <div class="chat-wrap" id="ticket-chat">
      ${replies.map(r => `<div class="bubble ${r.sender_role === 'admin' ? 'mine' : 'theirs'}">
          <div class="bname">${r.sender_role === 'admin' ? 'Support Team' : r.sender_name}</div>
          <div>${r.body}</div><div class="btime">${fmtDateTime(r.sent_at)}</div></div>`).join('')}
    </div>
    ${t.status !== 'resolved' ? `<div style="margin-top:12px">
      <textarea id="ticket-reply-body" rows="3" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px" placeholder="Type your reply…"></textarea>
    </div>` : `<div class="info-box" style="margin-top:12px">This ticket has been resolved.</div>`}`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Close</button>
     ${t.status !== 'resolved' ? `<button class="btn btn-brand" onclick="submitTicketReply(${t.id},'${pageId}')">Send Reply</button>` : ''}`);
  setTimeout(() => { const cw = document.getElementById('ticket-chat'); if (cw) cw.scrollTop = cw.scrollHeight; }, 100);
}
async function submitTicketReply(tid, pageId) {
  const body = document.getElementById('ticket-reply-body').value.trim();
  if (!body) { alert('Please type a reply'); return; }
  try { await apiFetch('/tickets/' + tid + '/reply', { method: 'POST', body: JSON.stringify({ body }) }); closeModalDirect(); loadSupport(currentUser.role); }
  catch (e) { alert(e.message); }
}
async function resolveTicket(tid, pageId) {
  if (!confirm('Mark this ticket as resolved?')) return;
  try { await apiFetch('/tickets/' + tid + '/resolve', { method: 'PATCH' }); closeModalDirect(); loadSupport(currentUser.role); }
  catch (e) { alert(e.message); }
}

// ═══════════════════════════════════════════════
// TENANT DASHBOARD
// ═══════════════════════════════════════════════
async function loadTenantDashboard() {
  const pg = document.getElementById('page-t-dashboard'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const d = await apiFetch('/tenant/dashboard');
    const landlords = d.landlords || []; const bills = d.bills || []; const unreadAnn = d.unread_announcements || 0;
    pg.innerHTML = `
      ${unreadAnn > 0 ? `<div class="reminder-banner"><span style="font-size:20px">📣</span>
        <div><strong>${unreadAnn} unread announcement${unreadAnn > 1 ? 's' : ''}</strong>
        <div style="font-size:12px;margin-top:2px"><button class="btn btn-sm btn-brand" onclick="setPage('t-announcements');loadTenantAnnouncements()">View</button></div></div></div>` : ''}
      ${landlords.map(l => `
        <div class="card">
          <div class="card-header"><h3>🏠 ${l.landlord_name}</h3>${l.contract_status ? badge(l.contract_status) : '<span style="color:var(--muted);font-size:12px">No contract yet</span>'}</div>
          ${l.contract_status ? `
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">
              <div><div style="color:var(--muted);font-size:11px;text-transform:uppercase">Property</div><div style="font-weight:600;margin-top:3px">${l.property_name || '—'}</div></div>
              <div><div style="color:var(--muted);font-size:11px;text-transform:uppercase">Unit</div><div style="font-weight:600;margin-top:3px">${l.unit_number || '—'}</div></div>
              <div><div style="color:var(--muted);font-size:11px;text-transform:uppercase">Monthly Rent</div><div style="font-weight:600;margin-top:3px">₱${fmt(l.monthly_rent)}</div></div>
              <div><div style="color:var(--muted);font-size:11px;text-transform:uppercase">Term</div><div style="font-weight:600;margin-top:3px">${l.is_open_term ? 'Open Term' : fmtDate(l.end_date) || '—'}</div></div>
            </div>
            <div style="margin-top:12px">
              <button class="btn btn-brand btn-sm" onclick="sendTenantMessage(${l.landlord_user_id},'${(l.landlord_name || '').replace(/'/g, "\\'")}')">💬 Message Landlord</button>
            </div>
            ${l.contract_doc_url ? `
              <div style="margin-top:12px;padding:10px;background:var(--bg);border-radius:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
                <div style="font-size:13px">📄 Signed contract available</div>
                <div class="btn-group">
                  <button class="btn btn-sm btn-outline" onclick="openDoc('${l.contract_doc_url}')">View Contract</button>
                  ${!l.tenant_ack ? `<button class="btn btn-sm btn-green" onclick="acknowledgeContract(${l.contract_id})">✓ Acknowledge</button>` : '<span class="badge badge-green">Acknowledged</span>'}
                </div>
              </div>` : ''}
          ` : `<p style="color:var(--muted);font-size:13px">Your landlord hasn't assigned you to a unit yet.</p>`}
        </div>`).join('')}
      ${!landlords.length ? `<div class="card"><div class="info-box">You haven't joined any landlord yet.</div>
        <button class="btn btn-brand" onclick="showJoinLandlord()" style="margin-top:12px">+ Join Landlord</button></div>` : ''}
      <div style="margin-bottom:16px">
        <button class="btn btn-outline btn-sm" onclick="showJoinLandlord()">+ Join Another Landlord</button>
      </div>
      <div class="card"><div class="card-header"><h3>Recent Bills</h3><button class="btn btn-sm btn-outline" onclick="setPage('t-bills');loadTenantBills()">View All</button></div>
        ${!bills.length ? '<p style="color:var(--muted);font-size:13px">No bills yet</p>' :
          `<div class="table-wrap"><table><thead><tr><th>Description</th><th>Type</th><th>Amount</th><th>Due</th><th>Status</th><th>Action</th></tr></thead><tbody>
          ${bills.map(b => `<tr><td>${b.description}</td><td>${badge(b.bill_type || 'rent')}</td>
            <td>₱${fmt(b.amount)}</td><td>${fmtDate(b.due_date)}</td><td>${badge(b.status)}</td>
            <td>${b.status !== 'paid' && !b.payment_id ? `<button class="btn btn-sm btn-brand" onclick="showSubmitPayment(${b.id},'${b.description.replace(/'/g, "\\'")}',${b.amount})">Pay</button>` :
              b.payment_id ? badge(b.payment_status) : '—'}</td></tr>`).join('')}
          </tbody></table></div>`}
      </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function acknowledgeContract(contractId) {
  try { await apiFetch('/contracts/' + contractId + '/acknowledge', { method: 'POST' }); alert('✅ Contract acknowledged!'); loadTenantDashboard(); }
  catch (e) { alert(e.message); }
}
function showJoinLandlord() {
  openModal('Join a Landlord', `
    <div class="info-box">Enter the landlord code from your landlord.</div>
    <div class="form-group"><label>Landlord Code</label><input type="text" id="m-join-code" placeholder="e.g. L3KX9MFA" style="text-transform:uppercase"/></div>
    <p class="err-msg" id="m-join-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitJoinLandlord()">Join</button>`);
}
async function submitJoinLandlord() {
  const landlord_code = document.getElementById('m-join-code').value.trim().toUpperCase();
  document.getElementById('m-join-err').textContent = '';
  if (!landlord_code) { document.getElementById('m-join-err').textContent = 'Enter a landlord code'; return; }
  try { const d = await apiFetch('/auth/join-landlord', { method: 'POST', body: JSON.stringify({ landlord_code }) }); closeModalDirect(); alert('✅ ' + d.message); loadTenantDashboard(); }
  catch (e) { document.getElementById('m-join-err').textContent = e.message; }
}
function showSubmitPayment(billId, desc, amount) {
  openModal('Submit Payment', `<div class="info-box">Bill: <strong>${desc}</strong> — ₱${fmt(amount)}</div>
    <div class="form-group"><label>Amount Paid ₱</label><input type="number" id="m-pay-amt" value="${amount}"/></div>
    <div style="margin-bottom:14px">
      <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px">Proof of Payment</label>
      <div id="m-pay-proof-box" style="border:1.5px dashed var(--border);border-radius:var(--radius);padding:16px;text-align:center;background:var(--bg)">
        <div id="m-pay-proof-placeholder">
          <div style="font-size:24px;margin-bottom:8px">📸</div>
          <div style="font-size:13px;color:var(--muted);margin-bottom:10px">Upload screenshot or photo of your payment receipt</div>
          <button class="btn btn-outline" type="button" onclick="uploadPaymentProof()">Choose File</button>
        </div>
        <div id="m-pay-proof-done" style="display:none">
          <div style="font-size:20px;color:var(--success)">✅</div>
          <div style="font-size:13px;margin-top:6px">Proof uploaded successfully</div>
          <button class="btn btn-sm btn-outline" style="margin-top:8px" onclick="uploadPaymentProof()">Change</button>
        </div>
      </div>
      <input type="hidden" id="m-pay-proof-url"/>
      <input type="hidden" id="m-pay-proof-pid"/>
    </div>
    <p class="err-msg" id="m-pay-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitTenantPayment(${billId})">Submit Payment</button>`);
}
async function uploadPaymentProof() {
  try {
    const result = await cloudinaryUpload({ sources: ['local', 'camera'], clientAllowedFormats: ['jpg', 'jpeg', 'png'], maxFileSize: 5000000, resourceType: 'image' });
    document.getElementById('m-pay-proof-url').value = result.url;
    document.getElementById('m-pay-proof-pid').value = result.public_id;
    document.getElementById('m-pay-proof-placeholder').style.display = 'none';
    document.getElementById('m-pay-proof-done').style.display = 'block';
  } catch (e) { if (e && e.message) alert('Upload failed: ' + e.message); }
}
async function submitTenantPayment(billId) {
  const proof_url = document.getElementById('m-pay-proof-url').value || '';
  const body = { bill_id: billId, amount_paid: document.getElementById('m-pay-amt').value, proof_url, proof_public_id: document.getElementById('m-pay-proof-pid').value || '' };
  document.getElementById('m-pay-err').textContent = '';
  if (!body.amount_paid) { document.getElementById('m-pay-err').textContent = 'Amount required'; return; }
  if (!proof_url) { document.getElementById('m-pay-err').textContent = 'Please upload proof of payment'; return; }
  try { await apiFetch('/payments', { method: 'POST', body: JSON.stringify(body) }); closeModalDirect(); loadTenantDashboard(); }
  catch (e) { document.getElementById('m-pay-err').textContent = e.message; }
}

// ═══════════════════════════════════════════════
// TENANT — CONTRACTS
// ═══════════════════════════════════════════════
async function loadTenantContracts() {
  const pg = document.getElementById('page-t-contract'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const contracts = await apiFetch('/contracts');
    pg.innerHTML = `${!contracts.length ? '<div class="card"><div class="empty-state"><p>No active contracts</p></div></div>' :
      contracts.map(c => `<div class="card">
        <div class="card-header"><h3>Contract — ${c.landlord_name}</h3>${badge(c.status)}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px">
          <div><div style="color:var(--muted);font-size:11px;text-transform:uppercase">Property</div><div style="font-weight:600;margin-top:3px">${c.property_name || '—'}</div></div>
          <div><div style="color:var(--muted);font-size:11px;text-transform:uppercase">Unit</div><div style="font-weight:600;margin-top:3px">${c.unit_number || '—'}</div></div>
          <div><div style="color:var(--muted);font-size:11px;text-transform:uppercase">Monthly Rent</div><div style="font-weight:600;margin-top:3px">₱${fmt(c.monthly_rent)}</div></div>
          <div><div style="color:var(--muted);font-size:11px;text-transform:uppercase">Term</div><div style="font-weight:600;margin-top:3px">${c.is_open_term ? '<span class="badge badge-blue">Open Term</span>' : fmtDate(c.start_date) + ' → ' + fmtDate(c.end_date)}</div></div>
          ${c.minimum_months ? `<div><div style="color:var(--muted);font-size:11px;text-transform:uppercase">Minimum Stay</div><div style="font-weight:600;margin-top:3px">${c.minimum_months} months</div></div>` : ''}
        </div>
        ${c.contract_doc_url ? `
          <div style="margin-top:16px;padding:14px;background:var(--bg);border-radius:8px">
            <div style="font-size:13px;font-weight:600;margin-bottom:10px">📄 Signed Contract Document</div>
            <div class="btn-group">
              <button class="btn btn-outline" onclick="openDoc('${c.contract_doc_url}')">📥 View Contract</button>
              ${!c.tenant_ack ? `<button class="btn btn-green" onclick="acknowledgeContract(${c.id})">✓ Acknowledge Receipt</button>` : '<span class="badge badge-green" style="padding:8px 12px">✓ Acknowledged</span>'}
            </div>
          </div>` : `<div style="margin-top:16px"><div class="warn-box">No contract document uploaded yet.</div></div>`}
      </div>`).join('')}`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}

// ═══════════════════════════════════════════════
// TENANT — BILLS
// ═══════════════════════════════════════════════
async function loadTenantBills() {
  const pg = document.getElementById('page-t-bills'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const bills = await apiFetch('/bills');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>My Bills</h3></div>
      ${!bills.length ? '<div class="empty-state"><p>No bills yet</p></div>' :
        `<div class="table-wrap"><table><thead><tr><th>Description</th><th>Type</th><th>Amount</th><th>Due</th><th>Status</th><th>Action</th></tr></thead><tbody>
        ${bills.map(b => `<tr><td>${b.description}</td><td>${badge(b.bill_type || 'rent')}</td>
          <td>₱${fmt(b.amount)}</td><td>${fmtDate(b.due_date)}</td><td>${badge(b.status)}</td>
          <td>${b.status !== 'paid' && !b.payment_id ? `<button class="btn btn-sm btn-brand" onclick="showSubmitPayment(${b.id},'${b.description.replace(/'/g, "\\'")}',${b.amount})">Pay Now</button>` :
            b.payment_id ? `<span class="badge badge-blue">${b.payment_status}</span>` : '—'}</td></tr>`).join('')}
        </tbody></table></div>`}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}

// ═══════════════════════════════════════════════
// TENANT — ANNOUNCEMENTS
// ═══════════════════════════════════════════════
async function loadTenantAnnouncements() {
  const pg = document.getElementById('page-t-announcements'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const announcements = await apiFetch('/announcements');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Announcements</h3></div>
      ${!announcements.length ? '<div class="empty-state"><div class="icon">📣</div><p>No announcements yet</p></div>' :
        announcements.map(a => `
          <div class="announcement-card ${!a.read_at ? 'unread' : ''}" onclick="markAnnouncementRead(${a.id},this)">
            ${!a.read_at ? '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px"><span class="badge badge-blue">New</span></div>' : ''}
            <div class="ann-subject">📣 ${a.subject}</div>
            <div class="ann-body">${a.body}</div>
            <div class="ann-meta">
              <span>From: ${a.landlord_name}</span>
              <span>📅 ${fmtDate(a.created_at)}</span>
              ${a.expires_at ? `<span>⏰ Expires ${fmtDate(a.expires_at)}</span>` : ''}
              ${a.read_at ? `<span>✓ Read ${fmtDate(a.read_at)}</span>` : ''}
            </div>
          </div>`).join('')}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function markAnnouncementRead(id, el) {
  try {
    await apiFetch('/announcements/' + id + '/read', { method: 'POST' });
    if (el) { el.classList.remove('unread'); const b = el.querySelector('.badge-blue'); if (b) b.remove(); }
  } catch (e) { }
}

// ═══════════════════════════════════════════════
// TENANT — MESSAGES
// ═══════════════════════════════════════════════
async function loadTenantMessages() {
  const pg = document.getElementById('page-t-messages'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const threads = await apiFetch('/threads');
    const unread = threads.filter(t => !t.is_read_tenant).length;
    pg.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Messages ${unread > 0 ? `<span class="badge badge-red">${unread} unread</span>` : ''}</h3></div>
        <div class="info-box" style="margin-bottom:12px">To start a new conversation, go to your Dashboard and tap <strong>Message Landlord</strong>.</div>
        ${!threads.length ? '<div class="empty-state"><div class="icon">💬</div><p>No conversations yet</p></div>' :
          threads.map(t => `<div class="thread-list-item ${!t.is_read_tenant ? 'unread' : ''}" onclick="openThread(${t.id})">
            <div class="thread-avatar">${(t.other_name || 'L')[0].toUpperCase()}</div>
            <div class="thread-info">
              <div class="tname">${t.other_name} ${!t.is_read_tenant ? '🔵' : ''}</div>
              <div class="tsubject"><strong>${t.subject}</strong></div>
              <div class="tlast">${(t.last_message || '').substring(0, 60)}</div>
            </div>
            <div class="thread-time">${fmtDate(t.last_reply_at)}</div>
          </div>`).join('')}
      </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function sendTenantMessage(landlordUserId, landlordName) {
  openModal(`Message to ${landlordName}`, `
    <div class="form-group"><label>Subject</label>
      <select id="msg-subject">${TENANT_SUBJECTS.map(s => `<option value="${s}">${s}</option>`).join('')}</select></div>
    <div class="form-group"><label>Message</label>
      <textarea id="msg-body" rows="4" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px" placeholder="Describe your concern…"></textarea></div>
    <p class="err-msg" id="msg-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="doSendTenantMessage(${landlordUserId},'${landlordName.replace(/'/g, "\\'")}')">Send</button>`);
}
async function doSendTenantMessage(landlordUserId, landlordName) {
  const subject = document.getElementById('msg-subject').value;
  const body = document.getElementById('msg-body').value.trim();
  document.getElementById('msg-err').textContent = '';
  if (!body) { document.getElementById('msg-err').textContent = 'Please write a message'; return; }
  try {
    await apiFetch('/threads', { method: 'POST', body: JSON.stringify({ subject, body, landlord_user_id: parseInt(landlordUserId) }) });
    closeModalDirect(); loadTenantMessages(); setPage('t-messages');
  } catch (e) { document.getElementById('msg-err').textContent = e.message; }
}

// ═══════════════════════════════════════════════
// TENANT — SETTINGS
// ═══════════════════════════════════════════════
async function loadTenantSettings() {
  const pg = document.getElementById('page-t-settings'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const prefs = await apiFetch('/notification-preferences');
    const prefRows = [
      { key: 'email_new_bill', label: 'New bill created' },
      { key: 'email_payment_approved', label: 'Payment approved' },
      { key: 'email_payment_rejected', label: 'Payment rejected' },
      { key: 'email_new_announcement', label: 'New announcement from landlord' },
      { key: 'email_contract_uploaded', label: 'Signed contract uploaded' },
      { key: 'email_new_message', label: 'New message from landlord' },
      { key: 'email_ticket_reply', label: 'Support ticket reply' },
    ];
    pg.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>⚙️ Account Settings</h3></div>
        <h4 style="font-size:14px;font-weight:600;margin:16px 0 10px">📧 Email Notifications</h4>
        ${prefRows.map(row => `
          <div class="pref-row">
            <span class="pref-label">${row.label}</span>
            <label class="toggle">
              <input type="checkbox" id="pref-${row.key}" ${prefs[row.key] ? 'checked' : ''}
                onchange="saveSinglePref('${row.key}', this.checked)"/>
              <span class="toggle-slider"></span>
            </label>
          </div>`).join('')}
        <div id="pref-save-msg" style="font-size:13px;color:var(--success);margin-top:10px;display:none">✅ Saved</div>
      </div>
      <div class="card">
        <div class="card-header"><h3>👤 My Account</h3></div>
        <div class="pref-row"><span class="pref-label">Name</span><strong>${currentUser.full_name}</strong></div>
        <div class="pref-row"><span class="pref-label">Email</span><strong>${currentUser.email}</strong></div>
        <div class="pref-row"><span class="pref-label">Role</span><strong style="text-transform:capitalize">${currentUser.role}</strong></div>
        <div style="margin-top:16px">
          <button class="btn btn-outline" onclick="showChangeEmail()">✉️ Change Email Address</button>
        </div>
      </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function saveSinglePref(key, value) {
  try {
    await apiFetch('/notification-preferences', { method: 'PATCH', body: JSON.stringify({ [key]: value ? 1 : 0 }) });
    const msg = document.getElementById('pref-save-msg');
    if (msg) { msg.style.display = 'block'; setTimeout(() => msg.style.display = 'none', 2000); }
  } catch (e) { alert('Failed to save: ' + e.message); }
}

// ═══════════════════════════════════════════════
// LANDLORD SETTINGS
// ═══════════════════════════════════════════════
async function loadLandlordSettings() {
  const pg = document.getElementById('page-l-settings'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const prefs = await apiFetch('/notification-preferences');
    const emailPrefRows = [
      { key: 'email_tenant_message', label: 'Message received from a tenant' },
      { key: 'email_contract_acknowledged', label: 'Tenant acknowledges a signed contract' },
      { key: 'email_payment_submitted', label: 'Tenant submits a payment proof' },
      { key: 'email_new_tenant_joined', label: 'New tenant joins using your code' },
    ];
    pg.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>⚙️ Landlord Settings</h3></div>
        <h4 style="font-size:14px;font-weight:600;margin:0 0 10px">📧 Email Notifications</h4>
        ${emailPrefRows.map(row => `
          <div class="pref-row">
            <span class="pref-label">${row.label}</span>
            <label class="toggle">
              <input type="checkbox" id="pref-${row.key}" ${prefs[row.key] || prefs[row.key] === undefined ? 'checked' : ''}
                onchange="saveSinglePref('${row.key}', this.checked)"/>
              <span class="toggle-slider"></span>
            </label>
          </div>`).join('')}
        <div id="pref-save-msg" style="font-size:13px;color:var(--success);margin-top:10px;display:none">✅ Saved</div>
      </div>
      <div class="card">
        <div class="card-header"><h3>👤 My Account</h3></div>
        <div class="pref-row"><span class="pref-label">Name</span><strong>${currentUser.full_name}</strong></div>
        <div class="pref-row"><span class="pref-label">Email</span><strong>${currentUser.email}</strong></div>
        <div class="pref-row"><span class="pref-label">Role</span><strong>Landlord</strong></div>
        <div style="margin-top:16px">
          <button class="btn btn-outline" onclick="showChangeEmail()">✉️ Change Email Address</button>
        </div>
      </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}

// ═══════════════════════════════════════════════
// CHANGE EMAIL
// ═══════════════════════════════════════════════
function showChangeEmail() {
  openModal('Change Email Address', `
    <div class="info-box">Enter your new email. We'll send a verification link before updating.</div>
    <div class="form-group"><label>New Email Address</label><input type="email" id="m-ce-email"/></div>
    <div class="form-group"><label>Current Password (to confirm)</label><input type="password" id="m-ce-pass"/></div>
    <p class="err-msg" id="m-ce-err"></p>`,
    `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
     <button class="btn btn-brand" onclick="submitChangeEmail()">Send Verification</button>`);
}
async function submitChangeEmail() {
  const email = document.getElementById('m-ce-email').value.trim();
  const password = document.getElementById('m-ce-pass').value;
  document.getElementById('m-ce-err').textContent = '';
  if (!email || !password) { document.getElementById('m-ce-err').textContent = 'Both fields required'; return; }
  try { const d = await apiFetch('/auth/change-email', { method: 'POST', body: JSON.stringify({ email, password }) }); closeModalDirect(); alert('✅ ' + d.message); }
  catch (e) { document.getElementById('m-ce-err').textContent = e.message; }
}

// ═══════════════════════════════════════════════
// RESEND VERIFICATION
// ═══════════════════════════════════════════════
async function resendVerification() {
  const btn = document.querySelector('#verify-email-banner .btn-info');
  if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
  try {
    await apiFetch('/auth/resend-verification', { method: 'POST' });
    if (btn) { btn.textContent = 'Sent ✅'; setTimeout(() => { btn.textContent = 'Resend Email'; btn.disabled = false; }, 3000); }
  } catch (e) {
    if (btn) { btn.textContent = 'Resend Email'; btn.disabled = false; }
    alert(e.message);
  }
}

// ═══════════════════════════════════════════════
// LANDLORD QR CODE
// ═══════════════════════════════════════════════
async function showLandlordQR() {
  try {
    const d = await apiFetch('/landlord/qr-code');
    const url = d.register_url;
    openModal('Scan to Register as Tenant', `
      <div class="info-box" style="margin-bottom:12px">Tenants can scan this QR code to register with your code pre-filled.</div>
      <div style="text-align:center;margin-bottom:12px">
        <div id="qr-canvas" style="display:inline-block;padding:12px;background:#fff;border:1px solid var(--border);border-radius:8px"></div>
      </div>
      <div style="text-align:center;margin-bottom:10px">
        <div class="code-card" style="font-size:18px;letter-spacing:3px;margin:0 0 10px">${d.landlord_code}</div>
        <div style="font-size:12px;color:var(--muted);word-break:break-all">${url}</div>
      </div>
      <button class="btn btn-outline" style="width:100%;margin-top:8px" onclick="copyCode('${url}')">📋 Copy Registration Link</button>`,
      `<button class="btn btn-brand" onclick="closeModalDirect()">Done</button>`);
    setTimeout(() => {
      const container = document.getElementById('qr-canvas');
      if (container && typeof QRCode !== 'undefined') {
        container.innerHTML = '';
        new QRCode(container, { text: url, width: 200, height: 200, colorDark: '#1B4332', colorLight: '#ffffff' });
      } else if (d.qr_base64) {
        container.innerHTML = `<img src="data:image/png;base64,${d.qr_base64}" style="width:200px;height:200px"/>`;
      }
    }, 100);
  } catch (e) { alert('Could not load QR code: ' + e.message); }
}

// ═══════════════════════════════════════════════
// ADMIN PAGES
// ═══════════════════════════════════════════════
async function loadAdminStats() {
  const pg = document.getElementById('page-admin-stats'); pg.innerHTML = '<p style="padding:20px">Loading…</p>';
  try {
    const s = await apiFetch('/admin/stats');
    pg.innerHTML = `<div class="stats-grid">
      <div class="stat-card"><div class="value">${s.total_landlords}</div><div class="label">Landlords</div></div>
      <div class="stat-card"><div class="value">${s.total_tenants}</div><div class="label">Tenants</div></div>
      <div class="stat-card"><div class="value">${s.total_properties}</div><div class="label">Properties</div></div>
      <div class="stat-card"><div class="value">${s.total_units}</div><div class="label">Units</div></div>
      <div class="stat-card"><div class="value">${s.active_contracts}</div><div class="label">Active Contracts</div></div>
      <div class="stat-card"><div class="value">${s.pending_payments}</div><div class="label">Pending Payments</div></div>
      <div class="stat-card"><div class="value">${s.open_tickets}</div><div class="label">Open Tickets</div></div>
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function loadAdminLandlords() {
  const pg = document.getElementById('page-admin-landlords'); pg.innerHTML = '<p style="padding:20px">Loading…</p>';
  try {
    const rows = await apiFetch('/admin/landlords');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Landlords (${rows.length})</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Code</th><th>Props</th><th>Tenants</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td><strong>${r.full_name}</strong><br><small style="color:var(--muted)">${r.business_name || ''}</small></td>
        <td style="font-size:12px">${r.email}</td>
        <td><code style="background:var(--bg);padding:2px 6px;border-radius:4px;font-size:11px">${r.landlord_code}</code></td>
        <td>${r.properties}</td><td>${r.tenants}</td>
        <td>${r.is_active ? badge('active') : badge('terminated')}</td>
        <td class="btn-group">
          <button class="btn btn-sm btn-info" onclick="adminEditUser(${r.id},'landlord')">✏️ Edit</button>
          ${r.is_active ? `<button class="btn btn-sm btn-red" onclick="adminToggleUser(${r.id},'suspend')">Suspend</button>` : `<button class="btn btn-sm btn-green" onclick="adminToggleUser(${r.id},'activate')">Activate</button>`}
        </td></tr>`).join('')}
      </tbody></table></div></div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function loadAdminTenants() {
  const pg = document.getElementById('page-admin-tenants'); pg.innerHTML = '<p style="padding:20px">Loading…</p>';
  try {
    const rows = await apiFetch('/admin/tenants');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Tenants (${rows.length})</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Landlords</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td><strong>${r.full_name}</strong></td><td style="font-size:12px">${r.email}</td>
        <td style="font-size:12px">${r.landlord_names || '—'} <span class="badge badge-blue">${r.landlord_count}</span></td>
        <td>${r.is_active ? badge('active') : badge('terminated')}</td>
        <td class="btn-group">
          <button class="btn btn-sm btn-info" onclick="adminEditUser(${r.id},'tenant')">✏️ Edit</button>
          ${r.is_active ? `<button class="btn btn-sm btn-red" onclick="adminToggleUser(${r.id},'suspend')">Suspend</button>` : `<button class="btn btn-sm btn-green" onclick="adminToggleUser(${r.id},'activate')">Activate</button>`}
        </td></tr>`).join('')}
      </tbody></table></div></div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function adminToggleUser(id, action) {
  if (!confirm(`${action === 'suspend' ? 'Suspend' : 'Activate'} this user?`)) return;
  await apiFetch('/admin/users/' + id + '/' + action, { method: 'PATCH' });
  loadAdminLandlords();
}
async function loadAdminTickets() {
  const pg = document.getElementById('page-admin-tickets'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const tickets = await apiFetch('/tickets');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Support Tickets</h3></div>
      ${!tickets.length ? '<div class="empty-state"><div class="icon">🎫</div><p>No tickets yet</p></div>' :
        tickets.map(t => `<div class="ticket-item" onclick="openTicket(${t.id},'admin-tickets')">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div class="ttitle">#${t.id} ${t.title} ${t.unread_count > 0 ? `<span class="badge badge-red">${t.unread_count} new</span>` : ''}</div>
            <div style="display:flex;gap:6px;flex-shrink:0">${badge(t.priority)}${badge(t.status)}</div>
          </div>
          <div class="tmeta">
            <span>👤 ${t.opener_name} (${t.opener_role})</span>
            <span>📁 ${t.category}</span><span>💬 ${t.reply_count} replies</span><span>📅 ${fmtDate(t.created_at)}</span>
          </div>
        </div>`).join('')}
    </div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function loadAdminChat() {
  const pg = document.getElementById('page-admin-chat'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const chats = await apiFetch('/support-chat');
    const open = chats.filter(c => c.status === 'open');
    const other = chats.filter(c => c.status !== 'open');
    pg.innerHTML = `
      <div class="stats-grid" style="margin-bottom:16px">
        <div class="stat-card"><div class="value">${open.length}</div><div class="label">Open Chats</div></div>
        <div class="stat-card"><div class="value">${chats.reduce((s, c) => s + (c.unread_count || 0), 0)}</div><div class="label">Unread</div></div>
      </div>
      ${!chats.length ? '<div class="card"><div class="empty-state"><div class="icon">💬</div><p>No support chats yet</p></div></div>' : ''}
      ${open.length ? `<div class="card"><div class="card-header"><h3>🟢 Open Chats</h3></div>
        ${open.map(c => `<div class="thread-list-item ${c.unread_count > 0 ? 'unread' : ''}" onclick="adminOpenChat(${c.id})">
          <div class="thread-avatar">${(c.user_name || '?')[0].toUpperCase()}</div>
          <div class="thread-info">
            <div class="tname">${c.user_name} <span class="badge badge-gray" style="font-size:10px">${c.user_role}</span> ${c.unread_count > 0 ? `<span class="badge badge-red">${c.unread_count}</span>` : ''}</div>
            <div class="tsubject"><strong>${c.subject}</strong></div>
            <div class="tlast">${(c.last_message || '').substring(0, 60)}</div>
          </div>
          <div class="thread-time">${fmtDate(c.last_message_at)}</div>
        </div>`).join('')}
      </div>` : ''}
      ${other.length ? `<div class="card"><div class="card-header"><h3>Closed / Converted</h3></div>
        ${other.map(c => `<div class="thread-list-item" onclick="adminOpenChat(${c.id})">
          <div class="thread-avatar">${(c.user_name || '?')[0].toUpperCase()}</div>
          <div class="thread-info"><div class="tname">${c.user_name} ${badge(c.status)}</div><div class="tsubject">${c.subject}</div></div>
          <div class="thread-time">${fmtDate(c.last_message_at)}</div>
        </div>`).join('')}
      </div>` : ''}`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function adminOpenChat(chatId) {
  const pg = document.getElementById('page-admin-chat'); pg.innerHTML = '<p style="padding:20px;color:var(--muted)">Loading…</p>';
  try {
    const d = await apiFetch('/support-chat/' + chatId);
    const chat = d.chat; const msgs = d.messages || []; const closed = chat.status !== 'open';
    pg.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div><h3>💬 ${chat.subject}</h3><div style="font-size:12px;color:var(--muted);margin-top:2px">From: <strong>${chat.user_name}</strong> (${chat.user_email}) ${badge(chat.status)}</div></div>
          <div class="btn-group">
            <button class="btn btn-outline btn-sm" onclick="loadAdminChat()">← Back</button>
            ${!closed ? `<button class="btn btn-sm btn-warn" onclick="showConvertToTicket(${chatId})">→ Make Ticket</button>
            <button class="btn btn-sm btn-red" onclick="adminCloseChat(${chatId})">Close Chat</button>` : ''}
          </div>
        </div>
        <div class="chat-wrap" id="admin-chat-wrap">
          ${msgs.map(m => { const isAdmin = m.sender_role === 'admin';
            return `<div class="bubble ${isAdmin ? 'mine' : 'theirs'}">
              <div class="bname">${isAdmin ? 'You (Support)' : m.sender_name}</div>
              <div>${m.body}</div><div class="btime">${fmtDateTime(m.sent_at)}</div>
            </div>`; }).join('')}
        </div>
        ${!closed ? `<div style="margin-top:12px;display:flex;gap:8px">
          <textarea id="admin-reply-body" rows="2" style="flex:1;padding:10px;border:1.5px solid var(--border);border-radius:8px" placeholder="Type your reply…"></textarea>
          <button class="btn btn-brand" style="align-self:flex-end" onclick="adminSendChatReply(${chatId})">Send</button>
        </div>` : `<div class="info-box" style="margin-top:10px">This chat is ${chat.status}.</div>`}
      </div>`;
    setTimeout(() => { const w = document.getElementById('admin-chat-wrap'); if (w) w.scrollTop = w.scrollHeight; }, 100);
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
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
     <button class="btn btn-brand" onclick="submitConvertToTicket(${chatId})">Convert</button>`);
}
async function submitConvertToTicket(chatId) {
  document.getElementById('m-ct-err').textContent = '';
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
  const pg = document.getElementById('page-admin-audit'); pg.innerHTML = '<p style="padding:20px">Loading…</p>';
  try {
    const logs = await apiFetch('/admin/audit-logs');
    pg.innerHTML = `<div class="card"><div class="card-header"><h3>Audit Log</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Action</th><th>User</th><th>Description</th><th>IP</th><th>Time</th></tr></thead><tbody>
      ${logs.map(l => `<tr><td><code style="font-size:11px">${l.action}</code></td><td style="font-size:12px">${l.email || 'system'}</td>
        <td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.description || '—'}</td>
        <td style="font-size:11px;color:var(--muted)">${l.ip_address || '—'}</td>
        <td style="font-size:11px;color:var(--muted)">${fmtDate(l.created_at)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  } catch (e) { pg.innerHTML = `<p class="err-msg">${e.message}</p>`; }
}
async function adminEditUser(uid, role) {
  try {
    const d = await apiFetch('/admin/users/' + uid);
    const u = d.user;
    openModal(`Edit ${role === 'landlord' ? 'Landlord' : 'Tenant'}: ${u.full_name}`, `
      <div class="grid-2">
        <div class="form-group"><label>Full Name</label><input type="text" id="ae-name" value="${u.full_name || ''}"/></div>
        <div class="form-group"><label>Email</label><input type="email" id="ae-email" value="${u.email || ''}"/></div>
      </div>
      <div class="form-group"><label>Phone</label><input type="text" id="ae-phone" value="${u.phone || ''}"/></div>
      <div class="grid-2">
        <div class="form-group"><label>Account Status</label>
          <select id="ae-active"><option value="1" ${u.is_active ? 'selected' : ''}>Active</option><option value="0" ${!u.is_active ? 'selected' : ''}>Suspended</option></select></div>
        <div class="form-group"><label>Email Verified</label>
          <select id="ae-verified"><option value="1" ${u.email_verified ? 'selected' : ''}>Verified</option><option value="0" ${!u.email_verified ? 'selected' : ''}>Not Verified</option></select></div>
      </div>
      <div class="form-group"><label>New Password (leave blank to keep current)</label>
        <input type="password" id="ae-password" placeholder="Min 8 characters"/></div>
      <p class="err-msg" id="ae-err"></p>`,
      `<button class="btn btn-outline" onclick="closeModalDirect()">Cancel</button>
       <button class="btn btn-brand" onclick="submitAdminEditUser(${uid},'${role}')">Save Changes</button>`);
  } catch (e) { alert('Could not load user: ' + e.message); }
}
async function submitAdminEditUser(uid, role) {
  const name = document.getElementById('ae-name').value.trim();
  const email = document.getElementById('ae-email').value.trim();
  const phone = document.getElementById('ae-phone').value.trim();
  const is_active = parseInt(document.getElementById('ae-active').value);
  const email_verified = parseInt(document.getElementById('ae-verified').value);
  const password = document.getElementById('ae-password').value;
  document.getElementById('ae-err').textContent = '';
  if (!name || !email) { document.getElementById('ae-err').textContent = 'Name and email required'; return; }
  try {
    await apiFetch('/admin/users/' + uid, { method: 'PATCH', body: JSON.stringify({ full_name: name, email, phone, is_active, email_verified }) });
    if (password) {
      const pwErr = validatePasswordStrength(password);
      if (pwErr) { document.getElementById('ae-err').textContent = pwErr; return; }
      await apiFetch('/admin/users/' + uid + '/reset-password', { method: 'POST', body: JSON.stringify({ password }) });
    }
    closeModalDirect();
    if (role === 'landlord') loadAdminLandlords(); else loadAdminTenants();
  } catch (e) { document.getElementById('ae-err').textContent = e.message; }
}

// ═══════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════
(function () {
  const params = new URLSearchParams(window.location.search);
  const linkType = params.get('type');   // 'verify' or 'reset'
  const linkToken = params.get('token');

  // ── Handle email verification link: ?type=verify&token=xxx
  if (linkType === 'verify' && linkToken) {
    document.getElementById('auth-screen').style.display = 'flex';
    document.querySelector('.auth-card').innerHTML = `
      <div class="auth-logo"><h1>🏠 Shiloh Living</h1></div>
      <div style="text-align:center;padding:20px 0">
        <div style="font-size:40px;margin-bottom:12px">⏳</div>
        <p style="color:var(--muted);font-size:14px">Verifying your email…</p>
      </div>`;
    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: linkToken })
    })
      .then(r => r.json())
      .then(d => {
        window.history.replaceState({}, '', '/');
        if (d.status === 'ok') {
          document.querySelector('.auth-card').innerHTML = `
            <div class="auth-logo"><h1>🏠 Shiloh Living</h1></div>
            <div style="text-align:center;padding:20px 0">
              <div style="font-size:48px;margin-bottom:12px">✅</div>
              <h2 style="color:var(--brand);margin-bottom:10px">Email Verified!</h2>
              <p style="color:var(--muted);font-size:14px;margin-bottom:20px">Your account is now active. You can sign in.</p>
              <button class="btn-primary" onclick="location.reload()">Go to Sign In</button>
            </div>`;
        } else {
          document.querySelector('.auth-card').innerHTML = `
            <div class="auth-logo"><h1>🏠 Shiloh Living</h1></div>
            <div style="text-align:center;padding:20px 0">
              <div style="font-size:48px;margin-bottom:12px">❌</div>
              <h2 style="color:var(--danger);margin-bottom:10px">Verification Failed</h2>
              <p style="color:var(--muted);font-size:14px;margin-bottom:20px">${d.message || 'Invalid or expired link.'}</p>
              <button class="btn-primary" onclick="location.reload()">Back to Sign In</button>
            </div>`;
        }
      })
      .catch(() => {
        window.history.replaceState({}, '', '/');
        location.reload();
      });
    return;
  }

  // ── Handle reset password link: ?type=reset&token=xxx
  if (linkType === 'reset' && linkToken) {
    showResetPasswordScreen(linkToken);
    return;
  }

  // ── Handle QR code tenant registration deep link: ?register=tenant&code=xxx
  if (params.get('register') === 'tenant') {
    const code = params.get('code') || '';
    if (!token || !currentUser) {
      document.getElementById('auth-screen').style.display = 'flex';
      showTab('register');
      const roleEl = document.getElementById('reg-role');
      if (roleEl) { roleEl.value = 'tenant'; onRoleChange(); }
      setTimeout(() => {
        const codeEl = document.getElementById('reg-code');
        if (codeEl && code) { codeEl.value = code.toUpperCase(); }
      }, 50);
      return;
    }
  }

  if (token && currentUser) { initApp(); }
  else { document.getElementById('auth-screen').style.display = 'flex'; onRoleChange(); }
})();