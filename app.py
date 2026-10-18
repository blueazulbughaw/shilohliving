"""
Shiloh Living — Rental Management Platform
Flask JSON API under /api/* plus the single-page frontend (templates/index.html).
"""
import os, re, secrets, smtplib, io, json, html, logging, hashlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, date
from functools import wraps
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication

import qrcode
from qrcode.image.pure import PyPNGImage

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

from flask import Flask, request, jsonify, send_from_directory, g, Response
from flask_cors import CORS
import mysql.connector
from mysql.connector import pooling
import bcrypt
import jwt as pyjwt

import pdfs

log = logging.getLogger('shiloh')
logging.basicConfig(level=logging.INFO)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, template_folder=os.path.join(BASE_DIR, 'templates'))
app.config['MAX_CONTENT_LENGTH'] = 12 * 1024 * 1024   # uploads are 10 MB max (see save_upload)

SECRET_KEY    = os.environ.get('SECRET_KEY', '')
if len(SECRET_KEY) < 32 or SECRET_KEY == 'change-me-in-production':
    raise RuntimeError('Set SECRET_KEY in .env to a long random value (32+ characters).')
JWT_EXPIRES   = int(os.environ.get('JWT_EXPIRES_HOURS', 24))
SMTP_HOST     = os.environ.get('SMTP_HOST', 'mail.shilohliving.app')
SMTP_PORT     = int(os.environ.get('SMTP_PORT', 465))
SMTP_USER     = os.environ.get('SMTP_USER', 'noreply@shilohliving.app')
SMTP_PASSWORD = os.environ.get('SMTP_PASSWORD', '')
SUPPORT_EMAIL = os.environ.get('SUPPORT_EMAIL', 'support@shilohliving.app')
APP_URL       = os.environ.get('APP_URL', 'https://hub.shilohliving.app').rstrip('/')
# Web Push (phone notifications). Without both keys nothing is pushed; the in-app bell still works.
VAPID_PUBLIC_KEY  = os.environ.get('VAPID_PUBLIC_KEY', '')
VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY', '')
VAPID_SUBJECT     = os.environ.get('VAPID_SUBJECT', 'mailto:' + SUPPORT_EMAIL)
# Landlord sign-up: 'open' lets anyone register (default), 'invite' needs an admin invite code
SIGNUP_MODE   = os.environ.get('SIGNUP_MODE', 'open').strip().lower()
TRIAL_DAYS    = int(os.environ.get('TRIAL_DAYS', 7))
# How to pay once the trial ends (shown to the landlord), e.g. price + GCash number.
# Charging is only switched on once this is set: until then trials are tracked, never enforced.
SUBSCRIPTION_PAY_INFO = os.environ.get('SUBSCRIPTION_PAY_INFO', '').strip()
BILLING_ACTIVE = bool(SUBSCRIPTION_PAY_INFO)

# The SPA is served from the same origin; only the app's own URL may call the API cross-site.
CORS(app, resources={r"/api/*": {"origins": [APP_URL]}})


# ── Global error handlers — always return JSON, never HTML ────
@app.errorhandler(404)
def not_found(e):
    if request.path.startswith('/api/'):
        return jsonify({'status':'error','message':'API endpoint not found'}), 404
    return send_from_directory(os.path.join(BASE_DIR, 'templates'), 'index.html')

@app.errorhandler(413)
def too_large(e):
    return jsonify({'status': 'error', 'message': 'The file is too big (10 MB max)'}), 413

@app.errorhandler(405)
def method_not_allowed(e):
    return jsonify({'status':'error','message':'Method not allowed'}), 405

@app.errorhandler(Exception)
def server_error(e):
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        return jsonify({'status': 'error', 'message': e.description}), e.code
    # Details go to the server log only - never to the browser (they include SQL and data)
    log.exception('Unhandled error on %s %s', request.method, request.path)
    return jsonify({'status': 'error', 'message': 'Something went wrong. Please try again.'}), 500

db_config = {
    'host':      os.environ.get('DB_HOST', '127.0.0.1'),
    'port':      int(os.environ.get('DB_PORT', 3306)),
    'user':      os.environ.get('DB_USER', ''),
    'password':  os.environ.get('DB_PASSWORD', ''),
    'database':  os.environ.get('DB_NAME', ''),
    'charset':   'utf8mb4',
    'collation': 'utf8mb4_unicode_ci',
}

try:
    pool = pooling.MySQLConnectionPool(pool_name='shiloh_pool', pool_size=8, **db_config)
except Exception as e:
    log.error("DB pool failed: %s", e)
    pool = None


# ── DB helpers ────────────────────────────────────────────────
def get_conn():
    if pool is None: raise Exception("Database pool not initialized")
    return pool.get_connection()

def query(sql, params=None, fetchone=False):
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(sql, params or ())
        return cur.fetchone() if fetchone else cur.fetchall()
    finally:
        conn.close()

def execute(sql, params=None):
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(sql, params or ())
        conn.commit()
        return cur.lastrowid, cur.rowcount
    finally:
        conn.close()

def ok(data=None, msg=None, status=200):
    resp = {'status': 'ok'}
    if msg: resp['message'] = msg
    if data is not None: resp['data'] = data
    return jsonify(resp), status

def err(msg, status=400):
    return jsonify({'status': 'error', 'message': msg}), status

def h(value):
    """HTML-escape anything people typed before it goes into an email."""
    return html.escape(str(value if value is not None else ''))

def positive_amount(value):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


# ── Email ─────────────────────────────────────────────────────
def send_email(to_email, subject, html_body, attachments=None):
    """attachments: [(filename, bytes, 'application/pdf')]. Returns True if the mail server took it."""
    if not SMTP_PASSWORD:
        if os.environ.get('DEV_SHOW_EMAILS'):   # scripts/dev.sh: print it so links can be clicked
            log.info("EMAIL to %s: %s\n%s\nLinks: %s", to_email, subject, re.sub(r'<[^>]+>', ' ', html_body),
                     ' '.join(re.findall(r'href="([^"]+)"', html_body)))
        else:
            log.info("Email skipped (no SMTP password): %s", subject)
        return False
    try:
        msg = MIMEMultipart('mixed')
        msg['Subject'] = subject
        msg['From']    = f'Shiloh Living <{SMTP_USER}>'
        msg['To']      = to_email
        msg.attach(MIMEText(html_body, 'html'))
        for name, data, mime in attachments or []:
            part = MIMEApplication(data, _subtype=mime.split('/')[-1])
            part.add_header('Content-Disposition', 'attachment', filename=name)
            msg.attach(part)
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(SMTP_USER, to_email, msg.as_string())
        return True
    except Exception as e:
        log.warning("Email to %s failed: %s", to_email, e)
        return False

def get_notif_pref(user_id, pref_key):
    pref = query("SELECT * FROM notification_preferences WHERE user_id=%s", (user_id,), fetchone=True)
    if not pref:
        return True
    return bool(pref.get(pref_key, 1))

def send_email_if_opted_in(user_id, pref_key, to_email, subject, html_body, attachments=None):
    if get_notif_pref(user_id, pref_key):
        return send_email(to_email, subject, html_body, attachments)
    return False

def email_new_ticket(ticket_id, title, opener_name, opener_email, category):
    send_email(
        SUPPORT_EMAIL,
        f'[New Ticket #{ticket_id}] {title}',
        f"""
        <h2>New Support Ticket</h2>
        <p><strong>Ticket #:</strong> {ticket_id}</p>
        <p><strong>From:</strong> {h(opener_name)} ({h(opener_email)})</p>
        <p><strong>Category:</strong> {h(category)}</p>
        <p><strong>Title:</strong> {h(title)}</p>
        <p><a href="{APP_URL}">View in Admin Dashboard →</a></p>
        """
    )


# ── Auth helpers ──────────────────────────────────────────────
def hash_password(pw): return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=12)).decode()
def check_password(pw, hashed):
    try: return bcrypt.checkpw(pw.encode(), hashed.encode())
    except: return False

def validate_password_strength(pw):
    """Returns an error string if weak, else None."""
    if len(pw) < 8:
        return 'Password must be at least 8 characters'
    if not re.search(r'[A-Z]', pw):
        return 'Password must contain at least one uppercase letter'
    if not re.search(r'[a-z]', pw):
        return 'Password must contain at least one lowercase letter'
    if not re.search(r'[0-9]', pw):
        return 'Password must contain at least one number'
    if not re.search(r'[^A-Za-z0-9]', pw):
        return 'Password must contain at least one special character (e.g. !@#$%)'
    return None

def make_token(user_id, role, session_version=0):
    payload = {
        'sub': str(user_id),
        'role': role,
        'sv': int(session_version or 0),   # see users.session_version
        'exp': datetime.utcnow() + timedelta(hours=JWT_EXPIRES),
        'iat': datetime.utcnow()
    }
    token = pyjwt.encode(payload, SECRET_KEY, algorithm='HS256')
    if isinstance(token, bytes):
        return token.decode('utf-8')
    return token

def decode_token(token):
    token = token.strip()
    return pyjwt.decode(token, SECRET_KEY, algorithms=['HS256'])

# No 0/O/1/I so codes read aloud or typed from a printout don't get mixed up
CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

def _gen_code(prefix, exists_sql):
    for _ in range(50):
        code = prefix + ''.join(secrets.choice(CODE_CHARS) for _ in range(7))
        if not query(exists_sql, (code,), fetchone=True):
            return code
    raise Exception("Could not generate a join code")

def gen_landlord_code():
    return _gen_code('L', "SELECT id FROM landlord_profiles WHERE landlord_code=%s")

def gen_invite_code():
    return _gen_code('I', "SELECT id FROM invites WHERE code=%s")

def subscription_status(lp):
    """A landlord's plan: state is exempt / paid / trial / expired. Only 'expired' blocks changes."""
    now = datetime.now()
    trial_end, paid_until = lp.get('trial_ends_at'), lp.get('paid_until')
    if lp.get('billing_exempt'):
        state, ends = 'exempt', None
    elif paid_until and paid_until >= now.date():
        state, ends = 'paid', datetime.combine(paid_until + timedelta(days=1), datetime.min.time())
    elif trial_end and trial_end > now:
        state, ends = 'trial', trial_end
    else:
        state, ends = 'expired', None
    # Part of a day counts as a day: a 7-day trial reads "7 days left" right after sign-up
    days_left = -(-(ends - now) // timedelta(days=1)) if ends else None
    return {'state': state, 'trial_ends_at': fmt_dt(trial_end), 'paid_until': fmt_dt(paid_until),
            'days_left': days_left, 'pay_info': SUBSCRIPTION_PAY_INFO, 'enforced': BILLING_ACTIVE}

def fmt_dt(v):
    return v.isoformat() if v else None

# What a landlord can still do after the trial ends: sign-in/account, support, notifications, opening PDFs.
# Every GET (viewing) also stays allowed, so nobody loses sight of their records.
BILLING_FREE_PATHS = ('/api/auth/', '/api/support-chat', '/api/tickets', '/api/notifications',
                      '/api/notification-preferences', '/api/push/', '/api/docs/link')

def resolve_join_code(code):
    """A landlord's join code (L + 7 chars) -> their landlord profile, or None."""
    code = (code or '').strip().upper()
    if not re.match(r'^[A-Z0-9]{8}$', code):
        return None
    return query("SELECT * FROM landlord_profiles WHERE landlord_code=%s", (code,), fetchone=True)

def link_tenant_to_landlord(tp_id, lp, tenant_name):
    """Joins (or re-joins) a tenant to a landlord. Returns False if they already had."""
    existing = query("SELECT id, is_active FROM tenant_landlords WHERE tenant_id=%s AND landlord_id=%s",
                     (tp_id, lp['id']), fetchone=True)
    if existing:
        if existing['is_active']:
            return False
        execute("UPDATE tenant_landlords SET is_active=1 WHERE id=%s", (existing['id'],))
    else:
        execute("INSERT INTO tenant_landlords (tenant_id, landlord_id) VALUES (%s,%s)", (tp_id, lp['id']))
    push_notification(lp['user_id'], 'New Tenant Joined', f'{tenant_name} joined using your code.', 'system')
    ll_user = query("SELECT email FROM users WHERE id=%s", (lp['user_id'],), fetchone=True)
    if ll_user:
        send_email_if_opted_in(lp['user_id'], 'email_new_tenant_joined', ll_user['email'],
            f'New Tenant Joined: {tenant_name}',
            f'<h2>New Tenant Joined</h2><p>{h(tenant_name)} has joined using your code.</p>'
            f'<p><a href="{APP_URL}">View in dashboard</a></p>')
    return True

def require_auth(*roles):
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            auth = request.headers.get('Authorization', '')
            if not auth.startswith('Bearer '):
                return err('Missing token', 401)
            raw_token = auth[7:].strip()
            if not raw_token:
                return err('Missing token', 401)
            try:
                payload = decode_token(raw_token)
            except pyjwt.ExpiredSignatureError:
                return err('Token expired', 401)
            except Exception:
                return err('Invalid token', 401)
            if payload.get('scope'):   # a document link token is not a sign-in
                return err('Invalid token', 401)
            user = query("SELECT * FROM users WHERE id=%s AND is_active=1", (payload['sub'],), fetchone=True)
            if not user:
                return err('User not found', 401)
            # Password changed / reset, or "sign out other devices", since this sign-in
            if int(payload.get('sv', 0)) != int(user.get('session_version') or 0):
                return err('Your session has ended. Please sign in again.', 401)
            if roles and user['role'] not in roles:
                return err('Access denied', 403)
            g.current_user = user
            # Trial over and not paid: landlords can still look at everything, but not change it
            if (BILLING_ACTIVE and user['role'] == 'landlord' and request.method != 'GET'
                    and not request.path.startswith(BILLING_FREE_PATHS)):
                lp = get_landlord_profile(user['id'])
                if lp and subscription_status(lp)['state'] == 'expired':
                    return err('Your free trial has ended. You can still view everything; '
                               'subscribe to keep making changes.', 402)
            return f(*args, **kwargs)
        return wrapper
    return decorator

def get_landlord_profile(user_id):
    return query("SELECT * FROM landlord_profiles WHERE user_id=%s", (user_id,), fetchone=True)

def get_tenant_profile(user_id):
    return query("SELECT * FROM tenant_profiles WHERE user_id=%s", (user_id,), fetchone=True)

def log_action(action, table_name=None, record_id=None, description=None):
    try:
        user_id = g.current_user['id'] if hasattr(g, 'current_user') else None
        execute("INSERT INTO audit_logs (user_id,action,table_name,record_id,description,ip_address) VALUES (%s,%s,%s,%s,%s,%s)",
                (user_id, action, table_name, record_id, description, request.remote_addr))
    except: pass

NOTIF_TYPES = {'bill', 'payment', 'message', 'reminder', 'system', 'announcement', 'contract', 'support'}
# Which page a notification opens (in the bell and from a phone notification), by role
NOTIF_PAGES = {
    'landlord': {'bill': 'bills', 'payment': 'payments', 'message': 'messages', 'contract': 'contracts',
                 'announcement': 'announcements', 'support': 'support', 'system': 'tenants', 'reminder': 'reminders'},
    'tenant':   {'bill': 't-bills', 'payment': 't-bills', 'message': 't-messages', 'contract': 't-contract',
                 'announcement': 't-announcements', 'support': 't-support', 'system': 't-dashboard'},
    'admin':    {'support': 'admin-chat', 'system': 'admin-tickets'},
}

def push_notification(user_id, title, body, notif_type='system', page=None):
    """Saves a bell notification and sends it to the person's phones (Web Push).
    Never raises: a notification failing must not fail the request that caused it."""
    if notif_type not in NOTIF_TYPES:
        notif_type = 'system'
    title = (title or '')[:255]
    body = body or ''
    try:
        if page is None:
            u = query("SELECT role FROM users WHERE id=%s", (user_id,), fetchone=True)
            page = NOTIF_PAGES.get(u['role'] if u else '', {}).get(notif_type)
        nid, _ = execute("INSERT INTO notifications (user_id,title,body,type,link) VALUES (%s,%s,%s,%s,%s)",
                         (user_id, title, body, notif_type, page))
    except Exception as e:
        log.warning("Notification for user %s failed: %s", user_id, e)
        return
    send_push(user_id, {'id': nid, 'title': title, 'body': body[:200], 'page': page})


# ── Web Push ──────────────────────────────────────────────────
# Sending happens on a small background pool so a slow push service never delays a page.
_push_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix='push')

def push_enabled():
    return bool(VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)

def _deliver_push(sub, payload):
    """Returns True if the push service says this subscription is gone for good."""
    from pywebpush import webpush, WebPushException
    try:
        webpush(subscription_info={'endpoint': sub['endpoint'],
                                   'keys': {'p256dh': sub['p256dh_key'], 'auth': sub['auth_key']}},
                data=payload, vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={'sub': VAPID_SUBJECT}, timeout=5, ttl=86400)
    except WebPushException as e:
        status = getattr(e.response, 'status_code', None)
        if status in (404, 410):
            return True
        log.warning("Web push failed (%s)", status or type(e).__name__)
    except Exception as e:
        log.warning("Web push failed (%s)", type(e).__name__)
    return False

def _deliver_all(subs, payload):
    for sub in subs:
        if _deliver_push(sub, payload):
            try:
                execute("DELETE FROM push_subscriptions WHERE id=%s", (sub['id'],))
            except Exception:
                pass

def send_push(user_id, data, wait=False):
    """Pushes `data` (title/body/page/id) to every device the user turned notifications on for.
    Returns how many devices it was sent to."""
    if not push_enabled():
        return 0
    try:
        subs = query("SELECT id, endpoint, p256dh_key, auth_key FROM push_subscriptions WHERE user_id=%s",
                     (user_id,))
    except Exception as e:
        log.warning("Push lookup failed: %s", e)
        return 0
    if not subs:
        return 0
    payload = json.dumps(data)
    if wait:
        _deliver_all(subs, payload)
    else:
        _push_pool.submit(_deliver_all, subs, payload)
    return len(subs)


# ── Frontend ──────────────────────────────────────────────────
@app.route('/')
def index_page():
    return send_from_directory(os.path.join(BASE_DIR, 'templates'), 'index.html')

@app.route('/<path:path>')
def frontend(path=''):
    # Any app path (/join/CODE, ...) gets the single-page app
    if path.startswith('api/'):
        return err('Not found', 404)
    return send_from_directory(os.path.join(BASE_DIR, 'templates'), 'index.html')

@app.route('/api/health')
def health():
    try:
        query("SELECT 1", fetchone=True)
        return ok({'db': 'connected', 'server': 'Shiloh Living API v4'})
    except Exception as e:
        log.error("Health check DB error: %s", e)
        return err('Database unavailable', 500)


# ════════════════════════════════════════════════════════════
# AUTH
# ════════════════════════════════════════════════════════════

@app.route('/api/auth/register', methods=['POST'])
def register():
    data      = request.get_json() or {}
    email     = (data.get('email') or '').strip().lower()
    password  = data.get('password', '')
    full_name = (data.get('full_name') or '').strip()
    role      = data.get('role', '')
    phone     = data.get('phone', '')
    lcode     = (data.get('landlord_code') or '').strip().upper()
    biz_name  = data.get('business_name', '')
    icode     = (data.get('invite_code') or '').strip().upper()

    if not email or not password or not full_name:
        return err('Email, password, and full name are required')
    if role not in ('landlord', 'tenant'):
        return err('Role must be landlord or tenant')
    pw_err = validate_password_strength(password)
    if pw_err:
        return err(pw_err)
    if not re.match(r'^[^@]+@[^@]+\.[^@]+$', email):
        return err('Invalid email format')
    if query("SELECT id FROM users WHERE email=%s", (email,), fetchone=True):
        return err('Email already registered', 409)

    if len(full_name) > 150: return err('Name is too long')
    # Landlords need an admin invite code (SIGNUP_MODE=invite); tenants only join through a landlord's code or link
    landlord_profile = None
    invite = None
    if role == 'landlord' and SIGNUP_MODE == 'invite':
        if not icode: return err('Landlord sign-up is invite-only for now. Enter your invite code.')
        invite = query("SELECT * FROM invites WHERE code=%s AND used_at IS NULL AND revoked_at IS NULL",
                       (icode,), fetchone=True)
        if not invite: return err('That invite code is not valid or was already used', 404)
        if invite['email'] and invite['email'].lower() != email:
            return err('This invite is for a different email address', 403)
        # Claim it first so two people can't use one code at the same moment
        _, claimed = execute("UPDATE invites SET used_at=NOW() WHERE id=%s AND used_at IS NULL", (invite['id'],))
        if not claimed: return err('That invite code was already used', 409)
    elif role == 'tenant':
        if not lcode: return err('Tenants need a join code from their landlord to sign up')
        landlord_profile = resolve_join_code(lcode)
        if not landlord_profile: return err('Invalid join code — check it with your landlord', 404)

    uid, _ = execute(
        "INSERT INTO users (email,password_hash,full_name,phone,role,email_verified) VALUES (%s,%s,%s,%s,%s,0)",
        (email, hash_password(password), full_name, phone, role)
    )

    if role == 'landlord':
        code = gen_landlord_code()
        execute("""INSERT INTO landlord_profiles (user_id,landlord_code,business_name,trial_ends_at,billing_exempt)
                   VALUES (%s,%s,%s,NOW() + INTERVAL %s DAY,%s)""",
                (uid, code, biz_name, TRIAL_DAYS, 1 if invite and invite['free_forever'] else 0))
        if invite:
            execute("UPDATE invites SET used_by=%s WHERE id=%s", (uid, invite['id']))
    elif role == 'tenant':
        tp_id, _ = execute("INSERT INTO tenant_profiles (user_id) VALUES (%s)", (uid,))
        if landlord_profile:
            link_tenant_to_landlord(tp_id, landlord_profile, full_name)

    send_verification_email(uid, email, full_name)
    token = make_token(uid, role)
    user  = query("SELECT id,email,full_name,role FROM users WHERE id=%s", (uid,), fetchone=True)
    return ok({'token': token, 'user': user, 'email_verification_sent': True}, status=201)


@app.route('/api/auth/signup-info', methods=['GET'])
def signup_info():
    """Public: whether landlord sign-up needs an invite code, and how long the free trial is."""
    return ok({'invite_only': SIGNUP_MODE == 'invite', 'trial_days': TRIAL_DAYS})


@app.route('/api/join/<code>', methods=['GET'])
def join_code_info(code):
    """Public: who a join link/code is for, so the sign-up page can say "You're joining ..."."""
    lp = resolve_join_code(code)
    lu = lp and query("SELECT full_name FROM users WHERE id=%s AND is_active=1", (lp['user_id'],), fetchone=True)
    if not lu: return err('This join code is not valid. Check it with your landlord.', 404)
    return ok({'code': code.strip().upper(), 'landlord_name': lu['full_name'],
               'business_name': lp.get('business_name') or ''})


@app.route('/api/join/<code>/qr.png', methods=['GET'])
def join_code_qr(code):
    """Public: a QR code of the join link /join/CODE, for landlords to share or print."""
    if not resolve_join_code(code): return err('Not found', 404)
    img = qrcode.make(f"{APP_URL}/join/{code.strip().upper()}", image_factory=PyPNGImage,
                      box_size=12, border=2, error_correction=qrcode.constants.ERROR_CORRECT_M)
    buf = io.BytesIO()
    img.save(buf)
    # Plain bytes, not send_file(): LiteSpeed's WSGI can't stream an in-memory buffer
    return Response(buf.getvalue(), mimetype='image/png', headers={'Cache-Control': 'public, max-age=300'})


@app.route('/api/auth/join-landlord', methods=['POST'])
@require_auth('tenant')
def join_landlord():
    data  = request.get_json() or {}
    lcode = (data.get('landlord_code') or data.get('code') or '').strip().upper()
    if not lcode: return err('Join code is required')

    lp = resolve_join_code(lcode)
    if not lp: return err('Invalid join code', 404)

    tp = get_tenant_profile(g.current_user['id'])
    if not tp: return err('Tenant profile not found', 404)

    if not link_tenant_to_landlord(tp['id'], lp, g.current_user['full_name']):
        return err('You have already joined this landlord', 409)
    landlord = query("SELECT full_name FROM users WHERE id=%s", (lp['user_id'],), fetchone=True)
    name = lp.get('business_name') or (landlord['full_name'] if landlord else 'landlord')
    return ok({'message': f'Successfully joined {name}'})


LOGIN_MAX_FAILS_PER_EMAIL = 8
LOGIN_MAX_FAILS_PER_IP = 30

def too_many_failures(email):
    try:
        recent = query("""SELECT SUM(email=%s) AS by_email, SUM(ip_address=%s) AS by_ip FROM login_failures
                          WHERE created_at > NOW() - INTERVAL 15 MINUTE AND (email=%s OR ip_address=%s)""",
                       (email, request.remote_addr, email, request.remote_addr), fetchone=True) or {}
        return (int(recent.get('by_email') or 0) >= LOGIN_MAX_FAILS_PER_EMAIL
                or int(recent.get('by_ip') or 0) >= LOGIN_MAX_FAILS_PER_IP)
    except Exception:
        return False

def record_failure(email):
    try:
        execute("INSERT INTO login_failures (email, ip_address) VALUES (%s,%s)", (email[:255], request.remote_addr))
        execute("DELETE FROM login_failures WHERE created_at < NOW() - INTERVAL 1 DAY")
    except Exception:
        pass

@app.route('/api/auth/login', methods=['POST'])
def login():
    data     = request.get_json() or {}
    email    = (data.get('email') or '').strip().lower()
    password = data.get('password', '')
    if not email or not password: return err('Email and password required')
    if too_many_failures(email):
        return err('Too many failed sign-in attempts. Please wait 15 minutes, or reset your password.', 429)
    user = query("SELECT * FROM users WHERE email=%s", (email,), fetchone=True)
    if not user or not check_password(password, user['password_hash']):
        record_failure(email)
        return err('Invalid email or password', 401)
    if not user['is_active']: return err('Account suspended', 403)
    if not bool(user.get('email_verified', 0)):
        return err('Please verify your email before logging in. Check your inbox for the verification link.', 403)
    execute("UPDATE users SET last_login_at=NOW() WHERE id=%s", (user['id'],))
    execute("DELETE FROM login_failures WHERE email=%s", (email,))
    token = make_token(user['id'], user['role'], user.get('session_version'))
    return ok({'token': token, 'user': {'id': user['id'], 'email': user['email'],
               'full_name': user['full_name'], 'role': user['role'],
               'email_verified': True}})

@app.route('/api/auth/me')
@require_auth()
def me():
    u = g.current_user
    profile = None
    if u['role'] == 'landlord':
        lp = get_landlord_profile(u['id'])
        if lp:
            profile = {'landlord_code': lp['landlord_code'], 'business_name': lp['business_name'],
                       'subscription': subscription_status(lp)}
    elif u['role'] == 'tenant':
        tp = get_tenant_profile(u['id'])
        if tp:
            landlords = query("""
                SELECT lu.id AS landlord_user_id, COALESCE(NULLIF(lp.business_name,''), lu.full_name) AS landlord_name
                FROM tenant_landlords tl
                JOIN landlord_profiles lp ON lp.id = tl.landlord_id
                JOIN users lu ON lu.id = lp.user_id
                WHERE tl.tenant_id = %s AND tl.is_active = 1
            """, (tp['id'],))
            profile = {'landlords': landlords}
    return ok({'id': u['id'], 'email': u['email'], 'full_name': u['full_name'],
               'role': u['role'], 'email_verified': bool(u.get('email_verified', 0)),
               'profile': profile})


# ════════════════════════════════════════════════════════════
# NOTIFICATION PREFERENCES
# ════════════════════════════════════════════════════════════

@app.route('/api/notification-preferences', methods=['GET'])
@require_auth()
def get_notification_preferences():
    prefs = query("SELECT * FROM notification_preferences WHERE user_id=%s",
                  (g.current_user['id'],), fetchone=True)
    if not prefs:
        execute("INSERT IGNORE INTO notification_preferences (user_id) VALUES (%s)",
                (g.current_user['id'],))
        prefs = query("SELECT * FROM notification_preferences WHERE user_id=%s",
                      (g.current_user['id'],), fetchone=True)
    return ok(prefs)

@app.route('/api/notification-preferences', methods=['PATCH'])
@require_auth()
def update_notification_preferences():
    data = request.get_json() or {}
    allowed = [
        'email_new_bill', 'email_payment_approved', 'email_payment_rejected',
        'email_new_announcement', 'email_contract_uploaded', 'email_new_message',
        'email_ticket_reply',
        'email_tenant_message', 'email_contract_acknowledged', 'email_payment_submitted',
        'email_new_tenant_joined',
    ]
    fields = {k: (1 if v else 0) for k, v in data.items() if k in allowed}
    if not fields:
        return err('No valid preference fields provided')
    set_clause = ', '.join(f"{k}=%s" for k in fields)
    execute(f"UPDATE notification_preferences SET {set_clause} WHERE user_id=%s",
            (*fields.values(), g.current_user['id']))
    return ok(msg='Preferences updated')


# ════════════════════════════════════════════════════════════
# NOTIFICATIONS
# ════════════════════════════════════════════════════════════

@app.route('/api/notifications')
@require_auth()
def list_notifications():
    notifs = query("SELECT * FROM notifications WHERE user_id=%s ORDER BY created_at DESC LIMIT 50",
                   (g.current_user['id'],))
    unread = query("SELECT COUNT(*) AS cnt FROM notifications WHERE user_id=%s AND is_read=0",
                   (g.current_user['id'],), fetchone=True)
    return ok({'notifications': notifs, 'unread_count': unread['cnt'] if unread else 0})

@app.route('/api/notifications/read-all', methods=['PATCH'])
@require_auth()
def mark_all_read():
    execute("UPDATE notifications SET is_read=1 WHERE user_id=%s", (g.current_user['id'],))
    return ok(msg='All read')

@app.route('/api/notifications/<int:nid>/read', methods=['PATCH'])
@require_auth()
def mark_notif_read(nid):
    execute("UPDATE notifications SET is_read=1 WHERE id=%s AND user_id=%s", (nid, g.current_user['id']))
    return ok()


@app.route('/api/push/key')
def push_key():
    """The public key a browser needs to turn on phone notifications (null = push is off)."""
    return ok({'public_key': VAPID_PUBLIC_KEY or None})

@app.route('/api/push/subscribe', methods=['POST'])
@require_auth()
def push_subscribe():
    """Stores this device's push subscription. A device belongs to whoever signed in on it last."""
    data = request.get_json() or {}
    endpoint = (data.get('endpoint') or '').strip()
    keys = data.get('keys') or {}
    p256dh, auth = (keys.get('p256dh') or '').strip(), (keys.get('auth') or '').strip()
    if not endpoint.startswith('https://') or len(endpoint) > 500 or not p256dh or not auth \
            or len(p256dh) > 255 or len(auth) > 255:
        return err('Invalid push subscription')
    execute("""INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key) VALUES (%s,%s,%s,%s)
               ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), p256dh_key=VALUES(p256dh_key),
                                       auth_key=VALUES(auth_key)""",
            (g.current_user['id'], endpoint, p256dh, auth))
    return ok(msg='Notifications are on for this device')

@app.route('/api/push/unsubscribe', methods=['POST'])
@require_auth()
def push_unsubscribe():
    endpoint = ((request.get_json() or {}).get('endpoint') or '').strip()
    if endpoint:
        execute("DELETE FROM push_subscriptions WHERE endpoint=%s AND user_id=%s",
                (endpoint[:500], g.current_user['id']))
    return ok()

@app.route('/api/push/test', methods=['POST'])
@require_auth()
def push_test():
    """Settings' "Send a test": pushes to the signed-in person's own devices (not saved in the bell)."""
    if not push_enabled():
        return err('Phone notifications are not set up on this server yet.', 503)
    sent = send_push(g.current_user['id'], {'title': 'Shiloh Living', 'page': None,
                                            'body': 'Notifications are working on this device.'}, wait=True)
    if not sent:
        return err('This device is not set up for notifications. Turn them on first.', 404)
    return ok(msg='Test notification sent')


# ════════════════════════════════════════════════════════════
# ANNOUNCEMENTS
# ════════════════════════════════════════════════════════════

@app.route('/api/announcements', methods=['GET'])
@require_auth('landlord', 'tenant')
def list_announcements():
    u = g.current_user
    if u['role'] == 'landlord':
        lp = get_landlord_profile(u['id'])
        announcements = query("""
            SELECT a.*,
                   GROUP_CONCAT(ap.property_id) AS property_ids
            FROM announcements a
            LEFT JOIN announcement_properties ap ON ap.announcement_id = a.id
            WHERE a.landlord_id = %s
            GROUP BY a.id
            ORDER BY a.created_at DESC
        """, (lp['id'],))
    else:
        tp = get_tenant_profile(u['id'])
        announcements = query(f"""
            SELECT a.*, u.full_name AS landlord_name,
                   (SELECT read_at FROM announcement_reads
                    WHERE announcement_id=a.id AND tenant_user_id=%s LIMIT 1) AS read_at
            {TENANT_ANNOUNCEMENTS_FROM}
            ORDER BY a.created_at DESC
        """, (u['id'], tp['id'], tp['id']))
    return ok(announcements)


# Announcements a tenant can see: from landlords they've joined, still live, and either for all
# properties or for a property they rent in. Params: (tenant_profile_id, tenant_profile_id)
TENANT_ANNOUNCEMENTS_FROM = """
    FROM announcements a
    JOIN landlord_profiles lp ON lp.id = a.landlord_id
    JOIN users u ON u.id = lp.user_id
    JOIN tenant_landlords tl ON tl.landlord_id = lp.id AND tl.tenant_id = %s AND tl.is_active = 1
    WHERE a.is_active = 1
      AND (a.expires_at IS NULL OR a.expires_at >= CURDATE())
      AND (a.target_all = 1 OR EXISTS (
            SELECT 1 FROM announcement_properties ap
            WHERE ap.announcement_id = a.id
              AND ap.property_id IN (
                    SELECT un.property_id FROM contracts c JOIN units un ON un.id = c.unit_id
                    WHERE c.tenant_id = %s AND c.status IN ('active','move_out_pending'))))
"""


@app.route('/api/announcements', methods=['POST'])
@require_auth('landlord')
def create_announcement():
    lp   = get_landlord_profile(g.current_user['id'])
    data = request.get_json() or {}
    subject    = (data.get('subject') or '').strip()
    body       = (data.get('body') or '').strip()
    target_all = 1 if data.get('target_all') else 0
    expires_at = data.get('expires_at')
    try:
        property_ids = [int(p) for p in (data.get('property_ids') or [])]
    except (TypeError, ValueError):
        return err('Invalid property selection')

    if not subject or not body:
        return err('Subject and body are required')
    if len(subject) > 255:
        return err('Subject is too long')
    if not target_all:
        own = query("SELECT id FROM properties WHERE landlord_id=%s AND is_active=1", (lp['id'],))
        property_ids = [p for p in property_ids if p in {r['id'] for r in own}]
        if not property_ids:
            return err('Select at least one property or choose "All Properties"')

    ann_id, _ = execute(
        "INSERT INTO announcements (landlord_id, subject, body, target_all, expires_at) VALUES (%s,%s,%s,%s,%s)",
        (lp['id'], subject, body, target_all, expires_at or None)
    )
    for pid in property_ids if not target_all else []:
        execute("INSERT IGNORE INTO announcement_properties (announcement_id, property_id) VALUES (%s,%s)",
                (ann_id, pid))

    if target_all:
        tenants = query("""
            SELECT DISTINCT u.id AS user_id, u.email, u.full_name
            FROM tenant_landlords tl
            JOIN tenant_profiles tp ON tp.id = tl.tenant_id
            JOIN users u ON u.id = tp.user_id
            WHERE tl.landlord_id = %s AND tl.is_active = 1
        """, (lp['id'],))
    else:
        marks = ','.join(['%s'] * len(property_ids))
        tenants = query(f"""
            SELECT DISTINCT u.id AS user_id, u.email, u.full_name
            FROM tenant_landlords tl
            JOIN tenant_profiles tp ON tp.id = tl.tenant_id
            JOIN users u ON u.id = tp.user_id
            WHERE tl.landlord_id = %s AND tl.is_active = 1
              AND EXISTS (
                    SELECT 1 FROM contracts c JOIN units un ON un.id = c.unit_id
                    WHERE c.tenant_id = tp.id AND c.status IN ('active','move_out_pending')
                      AND un.property_id IN ({marks}))
        """, (lp['id'], *property_ids))

    landlord_name = g.current_user['full_name']
    for t in tenants:
        push_notification(t['user_id'], f'Announcement: {subject}', body[:120], 'announcement')
        send_email_if_opted_in(
            t['user_id'], 'email_new_announcement',
            t['email'],
            f'Announcement from {landlord_name}: {subject}',
            f"""
            <h2>New Announcement</h2>
            <p><strong>From:</strong> {h(landlord_name)}</p>
            <p><strong>Subject:</strong> {h(subject)}</p>
            <hr/>
            <p style="white-space:pre-wrap">{h(body)}</p>
            <hr/>
            <p><a href="{APP_URL}">View in your dashboard →</a></p>
            """
        )

    log_action('CREATE_ANNOUNCEMENT', 'announcements', ann_id, subject)
    return ok({'announcement_id': ann_id}, status=201)


@app.route('/api/announcements/<int:aid>/read', methods=['POST'])
@require_auth('tenant')
def mark_announcement_read(aid):
    execute(
        "INSERT IGNORE INTO announcement_reads (announcement_id, tenant_user_id) VALUES (%s,%s)",
        (aid, g.current_user['id'])
    )
    return ok()


@app.route('/api/announcements/<int:aid>', methods=['DELETE'])
@require_auth('landlord')
def delete_announcement(aid):
    lp = get_landlord_profile(g.current_user['id'])
    execute("UPDATE announcements SET is_active=0 WHERE id=%s AND landlord_id=%s", (aid, lp['id']))
    return ok(msg='Announcement removed')


# ════════════════════════════════════════════════════════════
# THREADED MESSAGING
# ════════════════════════════════════════════════════════════

@app.route('/api/threads', methods=['GET'])
@require_auth('landlord', 'tenant')
def list_threads():
    u = g.current_user
    try:
        if u['role'] == 'landlord':
            threads = query("""
                SELECT mt.*, u.full_name AS other_name, u.email AS other_email,
                       (SELECT body FROM message_replies WHERE thread_id=mt.id ORDER BY sent_at DESC LIMIT 1) AS last_message
                FROM message_threads mt
                JOIN users u ON u.id = mt.tenant_id
                WHERE mt.landlord_id = %s
                ORDER BY COALESCE(mt.last_reply_at, mt.created_at) DESC
            """, (u['id'],))
        else:
            threads = query("""
                SELECT mt.*, u.full_name AS other_name, u.email AS other_email,
                       (SELECT body FROM message_replies WHERE thread_id=mt.id ORDER BY sent_at DESC LIMIT 1) AS last_message
                FROM message_threads mt
                JOIN users u ON u.id = mt.landlord_id
                WHERE mt.tenant_id = %s
                ORDER BY COALESCE(mt.last_reply_at, mt.created_at) DESC
            """, (u['id'],))
        return ok(threads)
    except Exception as e:
        log.warning("Thread list failed: %s", e)
        return ok([])


@app.route('/api/threads', methods=['POST'])
@require_auth('tenant', 'landlord')
def create_thread():
    u    = g.current_user
    data = request.get_json() or {}
    subject     = (data.get('subject') or '').strip()
    body        = (data.get('body') or '').strip()
    contract_id = data.get('contract_id')
    if not subject or not body: return err('Subject and message are required')
    if len(subject) > 255: return err('Subject is too long')

    # Tenants may only message landlords they've joined, and landlords only their own tenants.
    if u['role'] == 'tenant':
        tp = get_tenant_profile(u['id'])
        if contract_id:
            c = query("""SELECT lp.user_id AS landlord_user_id FROM contracts c
                         JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
                         JOIN landlord_profiles lp ON lp.id=p.landlord_id
                         WHERE c.id=%s AND c.tenant_id=%s""", (contract_id, tp['id']), fetchone=True)
            if not c: return err('Contract not found', 404)
            landlord_user_id = c['landlord_user_id']
        else:
            landlord_user_id = data.get('landlord_user_id')
            if not landlord_user_id: return err('landlord_user_id or contract_id required')
            if not query("""SELECT 1 FROM tenant_landlords tl JOIN landlord_profiles lp ON lp.id=tl.landlord_id
                            WHERE tl.tenant_id=%s AND tl.is_active=1 AND lp.user_id=%s""",
                         (tp['id'], landlord_user_id), fetchone=True):
                return err('You can only message landlords you have joined', 403)
        landlord_id, tenant_id, other_id = landlord_user_id, u['id'], landlord_user_id
    else:
        lp = get_landlord_profile(u['id'])
        tenant_user_id = data.get('tenant_user_id')
        if not tenant_user_id: return err('tenant_user_id is required')
        if not query("""SELECT 1 FROM tenant_landlords tl JOIN tenant_profiles tp ON tp.id=tl.tenant_id
                        WHERE tl.landlord_id=%s AND tp.user_id=%s AND tl.is_active=1""", (lp['id'], tenant_user_id), fetchone=True):
            return err('Tenant not found or not your tenant', 403)
        if contract_id and not query("""SELECT 1 FROM contracts c JOIN units un ON un.id=c.unit_id
                                        JOIN properties p ON p.id=un.property_id
                                        WHERE c.id=%s AND p.landlord_id=%s""", (contract_id, lp['id']), fetchone=True):
            contract_id = None
        landlord_id, tenant_id, other_id = u['id'], tenant_user_id, tenant_user_id
    if not still_linked(landlord_id, tenant_id):
        return err('This tenant has moved out, so new messages are turned off.', 403)

    tid, _ = execute(
        "INSERT INTO message_threads (subject,started_by,landlord_id,tenant_id,contract_id,is_read_landlord,is_read_tenant) VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (subject, u['id'], landlord_id, tenant_id, contract_id,
         1 if u['role'] == 'landlord' else 0, 1 if u['role'] == 'tenant' else 0)
    )
    execute("INSERT INTO message_replies (thread_id,sender_id,body) VALUES (%s,%s,%s)",
            (tid, u['id'], body))
    push_notification(other_id, f'New message from {u["full_name"]}: {subject}', body[:120], 'message')
    other_user = query("SELECT email, role FROM users WHERE id=%s", (other_id,), fetchone=True)
    if other_user:
        pref_key = 'email_tenant_message' if other_user['role'] == 'landlord' else 'email_new_message'
        send_email_if_opted_in(other_id, pref_key, other_user['email'], f'New message: {subject}',
            f"""<h2>New Message</h2><p><strong>From:</strong> {h(u['full_name'])}</p>
            <p><strong>Subject:</strong> {h(subject)}</p><hr/><p style="white-space:pre-wrap">{h(body)}</p><hr/>
            <p><a href="{APP_URL}">View conversation →</a></p>""")
    return ok({'thread_id': tid}, status=201)


@app.route('/api/threads/<int:tid>', methods=['GET'])
@require_auth('landlord', 'tenant')
def get_thread(tid):
    u = g.current_user
    thread = query("SELECT * FROM message_threads WHERE id=%s", (tid,), fetchone=True)
    if not thread: return err('Thread not found', 404)
    if u['id'] not in (thread['landlord_id'], thread['tenant_id']):
        return err('Access denied', 403)
    other = query("SELECT full_name FROM users WHERE id=%s",
                  (thread['tenant_id'] if u['id'] == thread['landlord_id'] else thread['landlord_id'],), fetchone=True)
    thread['other_name'] = other['full_name'] if other else ''
    thread['read_only'] = not still_linked(thread['landlord_id'], thread['tenant_id'])
    replies = query("""
        SELECT mr.*, u.full_name AS sender_name, u.role AS sender_role
        FROM message_replies mr JOIN users u ON u.id=mr.sender_id
        WHERE mr.thread_id=%s ORDER BY mr.sent_at ASC
    """, (tid,))
    if u['role'] == 'landlord':
        execute("UPDATE message_threads SET is_read_landlord=1 WHERE id=%s", (tid,))
    else:
        execute("UPDATE message_threads SET is_read_tenant=1 WHERE id=%s", (tid,))
    return ok({'thread': thread, 'replies': replies})


@app.route('/api/threads/<int:tid>/reply', methods=['POST'])
@require_auth('landlord', 'tenant')
def reply_to_thread(tid):
    u    = g.current_user
    data = request.get_json() or {}
    body = (data.get('body') or '').strip()
    if not body: return err('Message body is required')

    thread = query("SELECT * FROM message_threads WHERE id=%s", (tid,), fetchone=True)
    if not thread: return err('Thread not found', 404)
    if u['id'] not in (thread['landlord_id'], thread['tenant_id']):
        return err('Access denied', 403)
    if not still_linked(thread['landlord_id'], thread['tenant_id']):
        return err('This tenant has moved out. The conversation is kept as a record and can no longer be replied to.', 403)

    execute("INSERT INTO message_replies (thread_id,sender_id,body) VALUES (%s,%s,%s)",
            (tid, u['id'], body))

    other_id = thread['tenant_id'] if u['id'] == thread['landlord_id'] else thread['landlord_id']
    push_notification(other_id, f'{u["full_name"]}: {thread["subject"]}', body[:120], 'message')

    other_user = query("SELECT email, full_name, role FROM users WHERE id=%s", (other_id,), fetchone=True)
    if other_user:
        pref_key = 'email_tenant_message' if other_user.get('role') == 'landlord' else 'email_new_message'
        send_email_if_opted_in(
            other_id, pref_key,
            other_user['email'],
            f'New reply: {thread["subject"]}',
            f"""
            <h2>New Message</h2>
            <p><strong>From:</strong> {h(u['full_name'])}</p>
            <p><strong>Subject:</strong> {h(thread['subject'])}</p>
            <hr/><p style="white-space:pre-wrap">{h(body)}</p><hr/>
            <p><a href="{APP_URL}">View conversation →</a></p>
            """
        )

    return ok(msg='Reply sent')


@app.route('/api/threads/unread-count')
@require_auth('landlord', 'tenant')
def thread_unread_count():
    u = g.current_user
    if u['role'] == 'landlord':
        result = query("SELECT COUNT(*) AS cnt FROM message_threads WHERE landlord_id=%s AND is_read_landlord=0",
                       (u['id'],), fetchone=True)
    else:
        result = query("SELECT COUNT(*) AS cnt FROM message_threads WHERE tenant_id=%s AND is_read_tenant=0",
                       (u['id'],), fetchone=True)
    return ok({'unread': result['cnt'] if result else 0})


# ════════════════════════════════════════════════════════════
# SUPPORT TICKETS
# ════════════════════════════════════════════════════════════

@app.route('/api/tickets', methods=['GET'])
@require_auth('landlord', 'tenant', 'admin')
def list_tickets():
    u = g.current_user
    if u['role'] == 'admin':
        tickets = query("""
            SELECT st.*, u.full_name AS opener_name, u.email AS opener_email, u.role AS opener_role,
                   (SELECT COUNT(*) FROM ticket_replies WHERE ticket_id=st.id) AS reply_count,
                   (SELECT COUNT(*) FROM ticket_replies WHERE ticket_id=st.id AND is_read=0 AND sender_id!=st.opened_by) AS unread_count
            FROM support_tickets st JOIN users u ON u.id=st.opened_by
            ORDER BY st.created_at DESC
        """)
    else:
        tickets = query("""
            SELECT st.*,
                   (SELECT COUNT(*) FROM ticket_replies WHERE ticket_id=st.id) AS reply_count,
                   (SELECT COUNT(*) FROM ticket_replies WHERE ticket_id=st.id AND is_read=0 AND sender_id!=%s) AS unread_count
            FROM support_tickets st
            WHERE st.opened_by=%s ORDER BY st.created_at DESC
        """, (u['id'], u['id']))
    return ok(tickets)


@app.route('/api/tickets', methods=['POST'])
@require_auth('landlord', 'tenant')
def create_ticket():
    u    = g.current_user
    data = request.get_json() or {}
    title    = (data.get('title') or '').strip()
    category = data.get('category', 'other')
    body     = (data.get('body') or '').strip()
    priority = data.get('priority', 'normal')
    if not title or not body: return err('Title and message are required')
    if category not in ('billing', 'technical', 'account', 'contract', 'other'): category = 'other'
    if priority not in ('low', 'normal', 'high'): priority = 'normal'

    tid, _ = execute(
        "INSERT INTO support_tickets (opened_by,title,category,priority) VALUES (%s,%s,%s,%s)",
        (u['id'], title[:255], category, priority)
    )
    execute("INSERT INTO ticket_replies (ticket_id,sender_id,body) VALUES (%s,%s,%s)",
            (tid, u['id'], body))
    email_new_ticket(tid, title, u['full_name'], u['email'], category)
    for a in query("SELECT id FROM users WHERE role='admin' AND is_active=1"):
        push_notification(a['id'], f'New ticket #{tid}: {title}', f'From {u["full_name"]}', 'system')
    log_action('CREATE_TICKET', 'support_tickets', tid, title)
    return ok({'ticket_id': tid}, status=201)


@app.route('/api/tickets/<int:tid>', methods=['GET'])
@require_auth('landlord', 'tenant', 'admin')
def get_ticket(tid):
    u = g.current_user
    ticket = query("SELECT st.*, u.full_name AS opener_name FROM support_tickets st JOIN users u ON u.id=st.opened_by WHERE st.id=%s", (tid,), fetchone=True)
    if not ticket: return err('Ticket not found', 404)
    if u['role'] != 'admin' and ticket['opened_by'] != u['id']:
        return err('Access denied', 403)
    replies = query("""
        SELECT tr.*, u.full_name AS sender_name, u.role AS sender_role
        FROM ticket_replies tr JOIN users u ON u.id=tr.sender_id
        WHERE tr.ticket_id=%s ORDER BY tr.sent_at ASC
    """, (tid,))
    execute("UPDATE ticket_replies SET is_read=1 WHERE ticket_id=%s AND sender_id!=%s",
            (tid, u['id']))
    return ok({'ticket': ticket, 'replies': replies})


@app.route('/api/tickets/<int:tid>/reply', methods=['POST'])
@require_auth('landlord', 'tenant', 'admin')
def reply_ticket(tid):
    u    = g.current_user
    data = request.get_json() or {}
    body = (data.get('body') or '').strip()
    if not body: return err('Reply body is required')

    ticket = query("SELECT * FROM support_tickets st WHERE st.id=%s", (tid,), fetchone=True)
    if not ticket: return err('Ticket not found', 404)
    if u['role'] != 'admin' and ticket['opened_by'] != u['id']:
        return err('Access denied', 403)
    if ticket['status'] == 'resolved':
        return err('This ticket is resolved. Open a new ticket if needed.', 409)

    execute("INSERT INTO ticket_replies (ticket_id,sender_id,body) VALUES (%s,%s,%s)",
            (tid, u['id'], body))

    if u['role'] == 'admin':
        opener = query("SELECT email,full_name FROM users WHERE id=%s", (ticket['opened_by'],), fetchone=True)
        if opener:
            send_email_if_opted_in(
                ticket['opened_by'], 'email_ticket_reply',
                opener['email'],
                f'[Ticket #{tid}] New reply: {ticket["title"]}',
                f"""
                <h2>New Reply on Your Support Ticket</h2>
                <p><strong>Ticket:</strong> {h(ticket['title'])}</p>
                <p><strong>From:</strong> Support Team</p>
                <hr/>
                <p style="white-space:pre-wrap">{h(body)}</p>
                <hr/>
                <p><a href="{APP_URL}">View full conversation →</a></p>
                """
            )
        push_notification(ticket['opened_by'], 'Support replied to your ticket',
                          f'Ticket: {ticket["title"]}', 'support')
    else:
        send_email(SUPPORT_EMAIL,
                   f'[Ticket #{tid} Reply] {ticket["title"]}',
                   f'<p><strong>{h(u["full_name"])}</strong> replied:</p><p style="white-space:pre-wrap">{h(body)}</p>')
        for a in query("SELECT id FROM users WHERE role='admin' AND is_active=1"):
            push_notification(a['id'], f'Ticket #{tid} reply from {u["full_name"]}', body[:120], 'system')

    return ok(msg='Reply sent')


@app.route('/api/tickets/<int:tid>/resolve', methods=['PATCH'])
@require_auth('admin')
def resolve_ticket(tid):
    execute("UPDATE support_tickets SET status='resolved', resolved_at=NOW(), resolved_by=%s WHERE id=%s",
            (g.current_user['id'], tid))
    ticket = query("SELECT * FROM support_tickets WHERE id=%s", (tid,), fetchone=True)
    if ticket:
        opener = query("SELECT email,full_name FROM users WHERE id=%s", (ticket['opened_by'],), fetchone=True)
        if opener:
            send_email(opener['email'],
                       f'[Ticket #{tid}] Resolved: {ticket["title"]}',
                       f'<p>Hi {h(opener["full_name"])},</p><p>Your support ticket <strong>"{h(ticket["title"])}"</strong> has been marked as resolved.</p><p>If you need further help, please open a new ticket.</p>')
        push_notification(ticket['opened_by'], 'Support ticket resolved',
                          f'Your ticket "{ticket["title"]}" has been resolved.', 'support')
    log_action('RESOLVE_TICKET', 'support_tickets', tid)
    return ok(msg='Ticket resolved')


# ════════════════════════════════════════════════════════════
# PROPERTIES
# ════════════════════════════════════════════════════════════

# What a property uses, chosen in its Setup. Add new modules here (key, label, help, default);
# properties saved before a module existed get its default. Stored as JSON in properties.features.
PROPERTY_FEATURES = [
    ('rent_billing', 'Monthly rent bills',
     'Included when you tap "Generate Monthly Rent".', True),
    ('water_billing', 'Water billing (sub-meters)',
     'Read each unit\'s water meter every month and split the main water bill (with pump fee).', True),
    ('electricity_billing', 'Electricity bills',
     'Bill tenants for electricity.', True),
    ('other_charges', 'Other charges',
     'Parking, internet, association dues and other one-off bills.', True),
]
FEATURE_KEYS = {k for k, _, _, _ in PROPERTY_FEATURES}
# Which feature a bill type needs (rent is always allowed for manual bills)
BILL_TYPE_FEATURE = {'water': 'water_billing', 'electricity': 'electricity_billing', 'other': 'other_charges'}

def property_features(raw):
    """Saved JSON (or NULL) -> {feature_key: bool} with defaults filled in."""
    try:
        saved = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        saved = {}
    return {k: bool(saved.get(k, default)) for k, _, _, default in PROPERTY_FEATURES}

def property_has(property_id, feature):
    p = query("SELECT features FROM properties WHERE id=%s", (property_id,), fetchone=True)
    return bool(p) and property_features(p['features'])[feature]

def clean_features(data, current=None):
    """Merges {feature_key: bool} from a request into the current settings, ignoring unknown keys."""
    merged = dict(current or property_features(None))
    for k, v in (data or {}).items():
        if k in FEATURE_KEYS:
            merged[k] = bool(v)
    return json.dumps(merged)

@app.route('/api/property-features', methods=['GET'])
@require_auth('landlord')
def list_property_features():
    return ok([{'key': k, 'label': label, 'help': help_, 'default': d} for k, label, help_, d in PROPERTY_FEATURES])

@app.route('/api/properties', methods=['GET'])
@require_auth('landlord')
def list_properties():
    lp = get_landlord_profile(g.current_user['id'])
    props = query("""SELECT p.*,COUNT(u.id) AS unit_count,SUM(u.status='occupied') AS occupied,SUM(u.status='vacant') AS vacant
        FROM properties p LEFT JOIN units u ON u.property_id=p.id
        WHERE p.landlord_id=%s AND p.is_active=1 GROUP BY p.id ORDER BY p.created_at DESC""", (lp['id'],))
    for p in props:
        p['features'] = property_features(p['features'])
    return ok(props)

@app.route('/api/properties', methods=['POST'])
@require_auth('landlord')
def create_property():
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    name=(data.get('name') or '').strip(); address=(data.get('address') or '').strip()
    if not name or not address: return err('Name and address required')
    pid,_=execute("INSERT INTO properties (landlord_id,name,address,city,country,features) VALUES (%s,%s,%s,%s,%s,%s)",
                  (lp['id'],name[:255],address,data.get('city',''),data.get('country',''),clean_features(data.get('features'))))
    return ok({'id':pid,'name':name},status=201)

@app.route('/api/properties/<int:pid>', methods=['PATCH'])
@require_auth('landlord')
def update_property(pid):
    """Property Setup: details and which features it uses."""
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    p=query("SELECT id, features FROM properties WHERE id=%s AND landlord_id=%s AND is_active=1",(pid,lp['id']),fetchone=True)
    if not p: return err('Not found',404)
    fields={k:(v or '').strip() for k,v in data.items() if k in ('name','address','city','country')}
    if ('name' in fields and not fields['name']) or ('address' in fields and not fields['address']):
        return err('Name and address are required')
    if isinstance(data.get('features'), dict):
        fields['features'] = clean_features(data['features'], property_features(p['features']))
    if not fields: return err('No fields')
    set_clause=', '.join(f"{k}=%s" for k in fields)
    execute(f"UPDATE properties SET {set_clause} WHERE id=%s",(*fields.values(),pid))
    log_action('UPDATE_PROPERTY', 'properties', pid, ', '.join(fields))
    return ok(msg='Saved')

@app.route('/api/properties/<int:pid>', methods=['DELETE'])
@require_auth('landlord')
def delete_property(pid):
    lp=get_landlord_profile(g.current_user['id'])
    execute("UPDATE properties SET is_active=0 WHERE id=%s AND landlord_id=%s",(pid,lp['id']))
    return ok(msg='Deleted')


# ════════════════════════════════════════════════════════════
# UNITS
# ════════════════════════════════════════════════════════════

@app.route('/api/units', methods=['GET'])
@require_auth('landlord')
def list_units():
    lp=get_landlord_profile(g.current_user['id']); pid=request.args.get('property_id')
    if pid:
        p=query("SELECT id FROM properties WHERE id=%s AND landlord_id=%s",(pid,lp['id']),fetchone=True)
        if not p: return err('Not found',404)
        units=query("SELECT * FROM units WHERE property_id=%s ORDER BY unit_number",(pid,))
    else:
        units=query("""SELECT u.*,p.name AS property_name FROM units u JOIN properties p ON p.id=u.property_id
            WHERE p.landlord_id=%s AND p.is_active=1 ORDER BY p.name,u.unit_number""",(lp['id'],))
    return ok(units)

@app.route('/api/units', methods=['POST'])
@require_auth('landlord')
def create_unit():
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    prop_id=data.get('property_id'); unit_number=(data.get('unit_number') or '').strip(); rent_amount=data.get('rent_amount')
    if not prop_id or not unit_number or not rent_amount: return err('property_id, unit_number, rent_amount required')
    p=query("SELECT id FROM properties WHERE id=%s AND landlord_id=%s AND is_active=1",(prop_id,lp['id']),fetchone=True)
    if not p: return err('Property not found',404)
    try:
        uid,_=execute("INSERT INTO units (property_id,unit_number,floor_num,bedrooms,bathrooms,area_sqm,rent_amount) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                      (prop_id,unit_number,data.get('floor_num'),data.get('bedrooms'),data.get('bathrooms'),data.get('area_sqm'),rent_amount))
    except Exception as e:
        if 'Duplicate' in str(e): return err('Unit number already exists',409)
        raise
    return ok({'id':uid,'unit_number':unit_number},status=201)

@app.route('/api/units/<int:uid>', methods=['PATCH'])
@require_auth('landlord')
def update_unit(uid):
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    u=query("""SELECT u.id FROM units u JOIN properties p ON p.id=u.property_id WHERE u.id=%s AND p.landlord_id=%s""",(uid,lp['id']),fetchone=True)
    if not u: return err('Not found',404)
    fields={k:v for k,v in data.items() if k in ('unit_number','floor_num','bedrooms','bathrooms','area_sqm','rent_amount','status')}
    if not fields: return err('No fields')
    set_clause=', '.join(f"{k}=%s" for k in fields)
    execute(f"UPDATE units SET {set_clause} WHERE id=%s",(*fields.values(),uid))
    return ok(msg='Updated')


# ════════════════════════════════════════════════════════════
# CONTRACTS
# ════════════════════════════════════════════════════════════

@app.route('/api/contracts', methods=['GET'])
@require_auth('landlord', 'tenant')
def list_contracts():
    u = g.current_user
    if u['role'] == 'landlord':
        lp = get_landlord_profile(u['id'])
        contracts = query("""
            SELECT c.*,u.full_name AS tenant_name,u.email AS tenant_email,
                   un.unit_number,p.name AS property_name,p.id AS property_id
            FROM contracts c
            JOIN tenant_profiles tp ON tp.id=c.tenant_id
            JOIN users u ON u.id=tp.user_id
            JOIN units un ON un.id=c.unit_id
            JOIN properties p ON p.id=un.property_id
            WHERE p.landlord_id=%s ORDER BY c.created_at DESC
        """, (lp['id'],))
    else:
        tp = get_tenant_profile(u['id'])
        contracts = query("""
            SELECT c.*,un.unit_number,p.name AS property_name,
                   lu.full_name AS landlord_name
            FROM contracts c
            JOIN units un ON un.id=c.unit_id
            JOIN properties p ON p.id=un.property_id
            JOIN landlord_profiles lp ON lp.id=p.landlord_id
            JOIN users lu ON lu.id=lp.user_id
            WHERE c.tenant_id=%s ORDER BY c.created_at DESC
        """, (tp['id'],))
    return ok(contracts)


@app.route('/api/contracts', methods=['POST'])
@require_auth('landlord')
def create_contract():
    lp   = get_landlord_profile(g.current_user['id'])
    data = request.get_json() or {}
    unit_id            = data.get('unit_id')
    tenant_id          = data.get('tenant_id')
    start_date         = data.get('start_date')
    monthly_rent       = data.get('monthly_rent')
    deposit            = data.get('deposit', 0)
    contract_signed_date = data.get('contract_signed_date')
    move_in_date       = data.get('move_in_date')
    is_open_term   = 1 if data.get('is_open_term') else 0
    minimum_months = data.get('minimum_months')
    end_date       = data.get('end_date')

    if not all([unit_id, tenant_id, start_date, monthly_rent]):
        return err('unit_id, tenant_id, start_date, monthly_rent are required')
    if not is_open_term and not end_date:
        return err('end_date is required when not an open term contract')
    if positive_amount(monthly_rent) is None:
        return err('Monthly rent must be more than 0')
    if is_open_term:
        end_date = None

    p = query("SELECT pr.landlord_id FROM units u JOIN properties pr ON pr.id=u.property_id WHERE u.id=%s", (unit_id,), fetchone=True)
    if not p or p['landlord_id'] != lp['id']: return err('Unit not found or not yours', 403)
    tp_check = query("SELECT tp.id FROM tenant_profiles tp JOIN tenant_landlords tl ON tl.tenant_id=tp.id WHERE tp.id=%s AND tl.landlord_id=%s AND tl.is_active=1",
                     (tenant_id, lp['id']), fetchone=True)
    if not tp_check: return err('Tenant not found or not your tenant', 403)

    try:
        cid, _ = execute(
            """INSERT INTO contracts
               (unit_id,tenant_id,start_date,end_date,monthly_rent,deposit,
                is_open_term,minimum_months,contract_signed_date,move_in_date)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (unit_id, tenant_id, start_date, end_date or None,
             monthly_rent, deposit, is_open_term,
             minimum_months if not is_open_term and minimum_months else None,
             contract_signed_date or None, move_in_date or None)
        )
    except Exception as e:
        if 'already has an active contract' in str(e):
            return err('This unit already has an active contract.', 409)
        raise

    tenant_user = query("SELECT u.id, u.email, u.full_name FROM users u JOIN tenant_profiles tp ON tp.user_id=u.id WHERE tp.id=%s", (tenant_id,), fetchone=True)
    if tenant_user:
        push_notification(tenant_user['id'], 'New Contract Created',
                          'Your landlord has created a contract for you.', 'contract')

    log_action('CREATE_CONTRACT', 'contracts', cid)
    return ok({'contract_id': cid}, status=201)


@app.route('/api/contracts/<int:cid>/upload-doc', methods=['POST'])
@require_auth('landlord')
def upload_contract_doc(cid):
    lp   = get_landlord_profile(g.current_user['id'])
    data = request.get_json() or {}
    doc_url   = (data.get('contract_doc_url') or '').strip()
    public_id = (data.get('public_id') or '').strip()

    if not doc_url:
        return err('contract_doc_url is required')
    if not upload_ok(doc_url, 'contract'):
        return err('Invalid document. Please upload it with the file picker.')

    c = query("""
        SELECT c.id, c.tenant_id FROM contracts c
        JOIN units un ON un.id=c.unit_id
        JOIN properties p ON p.id=un.property_id
        WHERE c.id=%s AND p.landlord_id=%s
    """, (cid, lp['id']), fetchone=True)
    if not c: return err('Contract not found', 404)

    execute(
        "UPDATE contracts SET contract_doc_url=%s, doc_uploaded_at=NOW(), tenant_ack=0 WHERE id=%s",
        (doc_url, cid)
    )

    tenant_user = query(
        "SELECT u.id, u.email, u.full_name FROM users u JOIN tenant_profiles tp ON tp.user_id=u.id WHERE tp.id=%s",
        (c['tenant_id'],), fetchone=True
    )
    if tenant_user:
        push_notification(tenant_user['id'], 'Signed Contract Uploaded',
                          'Your landlord has uploaded your signed contract. Please review it.',
                          'contract')
        send_email_if_opted_in(
            tenant_user['id'], 'email_contract_uploaded',
            tenant_user['email'],
            'Your Signed Contract is Ready',
            '<h2>Signed Contract Uploaded</h2>'
            '<p>Hi ' + h(tenant_user['full_name']) + ',</p>'
            '<p>Your landlord has uploaded your signed rental contract.</p>'
            '<p>Please log in to your dashboard to view and acknowledge it.</p>'
            '<p><a href="' + APP_URL + '">Go to Dashboard →</a></p>'
        )

    log_action('UPLOAD_CONTRACT_DOC', 'contracts', cid)
    return ok(msg='Contract document uploaded and tenant notified')


@app.route('/api/contracts/<int:cid>/acknowledge', methods=['POST'])
@require_auth('tenant')
def acknowledge_contract(cid):
    tp = get_tenant_profile(g.current_user['id'])
    c = query("SELECT id FROM contracts WHERE id=%s AND tenant_id=%s", (cid, tp['id']), fetchone=True)
    if not c: return err('Contract not found', 404)
    execute("UPDATE contracts SET tenant_ack=1, tenant_ack_at=NOW() WHERE id=%s", (cid,))
    ci = query("SELECT lu.id AS landlord_user_id, lu.email AS landlord_email, lu.full_name AS landlord_name, un.unit_number, p.name AS property_name FROM contracts c JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id JOIN landlord_profiles lp ON lp.id=p.landlord_id JOIN users lu ON lu.id=lp.user_id WHERE c.id=%s", (cid,), fetchone=True)
    if ci:
        push_notification(ci["landlord_user_id"], "Contract Acknowledged",
                          f'{g.current_user["full_name"]} acknowledged the signed contract.', "contract")
        send_email_if_opted_in(
            ci["landlord_user_id"], "email_contract_acknowledged",
            ci["landlord_email"],
            "Contract Acknowledged by Tenant",
            f'<h2>Contract Acknowledged</h2><p>{h(g.current_user["full_name"])} acknowledged the contract for Unit {h(ci["unit_number"])}.</p><p><a href="{APP_URL}">View in dashboard</a></p>'
        )
    return ok(msg='Contract acknowledged')


@app.route('/api/contracts/<int:cid>/terminate', methods=['PATCH'])
@require_auth('landlord')
def terminate_contract(cid):
    lp   = get_landlord_profile(g.current_user['id'])
    data = request.get_json() or {}
    c = query("""SELECT c.id, c.tenant_id, c.unit_id FROM contracts c
               JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
               WHERE c.id=%s AND p.landlord_id=%s AND c.status='active'""",(cid,lp['id']),fetchone=True)
    if not c: return err('Not found',404)
    move_out_date = data.get('move_out_date')
    notes         = data.get('notes', '')
    execute("""UPDATE contracts SET status='move_out_pending',
                move_out_date=%s, move_out_notes=%s WHERE id=%s""",
            (move_out_date or None, notes, cid))
    existing = query("SELECT id FROM move_out_checklists WHERE contract_id=%s", (cid,), fetchone=True)
    if not existing:
        execute("INSERT INTO move_out_checklists (contract_id) VALUES (%s)", (cid,))
    tenant_user = query("""SELECT u.id, u.email, u.full_name FROM users u
        JOIN tenant_profiles tp ON tp.user_id=u.id WHERE tp.id=%s""", (c['tenant_id'],), fetchone=True)
    if tenant_user:
        push_notification(tenant_user['id'], 'Move-Out Process Started',
                          'Your landlord has initiated the move-out process.', 'contract')
    log_action('TERMINATE_CONTRACT', 'contracts', cid)
    return ok(msg='Move-out process started')

@app.route('/api/contracts/<int:cid>/move-out', methods=['GET'])
@require_auth('landlord')
def get_move_out(cid):
    lp = get_landlord_profile(g.current_user['id'])
    c  = query("""SELECT c.*, u.full_name AS tenant_name, u.email AS tenant_email,
               un.unit_number, p.name AS property_name
        FROM contracts c
        JOIN tenant_profiles tp ON tp.id=c.tenant_id
        JOIN users u ON u.id=tp.user_id
        JOIN units un ON un.id=c.unit_id
        JOIN properties p ON p.id=un.property_id
        WHERE c.id=%s AND p.landlord_id=%s""", (cid, lp['id']), fetchone=True)
    if not c: return err('Not found', 404)
    checklist = query("SELECT * FROM move_out_checklists WHERE contract_id=%s", (cid,), fetchone=True)
    return ok({'contract': c, 'checklist': checklist})

@app.route('/api/contracts/<int:cid>/move-out', methods=['PATCH'])
@require_auth('landlord')
def update_move_out(cid):
    lp   = get_landlord_profile(g.current_user['id'])
    data = request.get_json() or {}
    c = query("""SELECT c.id, c.tenant_id, c.unit_id FROM contracts c
        JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
        WHERE c.id=%s AND p.landlord_id=%s""", (cid, lp['id']), fetchone=True)
    if not c: return err('Not found', 404)

    allowed = ['deposit_consumed','deposit_consumed_amount','repair_status',
               'repair_notes','repair_proof_url','deposit_status','deposit_ready_at']
    fields  = {k:v for k,v in data.items() if k in allowed}
    before = query("SELECT deposit_status, repair_proof_url FROM move_out_checklists WHERE contract_id=%s", (cid,), fetchone=True)
    if not upload_ok(fields.get('repair_proof_url'), 'repair_proof', (before or {}).get('repair_proof_url')):
        return err('Invalid proof. Please upload it with the file picker.')
    if fields:
        set_cl = ', '.join(f"{k}=%s" for k in fields)
        execute(f"UPDATE move_out_checklists SET {set_cl}, updated_at=NOW() WHERE contract_id=%s",
                (*fields.values(), cid))

    # Tell the tenant once, when the deposit first becomes ready (not on every later save)
    if data.get('deposit_status') == 'ready' and (before or {}).get('deposit_status') != 'ready':
        tenant_user = query("""SELECT u.id, u.email, u.full_name FROM users u
            JOIN tenant_profiles tp ON tp.user_id=u.id WHERE tp.id=%s""",
            (c['tenant_id'],), fetchone=True)
        if tenant_user:
            push_notification(tenant_user['id'], 'Deposit Ready for Pickup',
                              'Your security deposit/check is ready to be picked up.', 'contract')
            send_email_if_opted_in(tenant_user['id'], 'email_contract_uploaded',
                tenant_user['email'], 'Your Deposit is Ready for Pickup',
                '<h2>Deposit Ready</h2><p>Your landlord has confirmed your security deposit is ready for pickup. Please coordinate with your landlord.</p>')

    return ok(msg='Move-out checklist updated')

@app.route('/api/contracts/<int:cid>/complete-move-out', methods=['POST'])
@require_auth('landlord')
def complete_move_out(cid):
    lp = get_landlord_profile(g.current_user['id'])
    c  = query("""SELECT c.id, c.unit_id, c.tenant_id FROM contracts c
        JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
        WHERE c.id=%s AND p.landlord_id=%s""", (cid, lp['id']), fetchone=True)
    if not c: return err('Not found', 404)
    checklist = query("SELECT * FROM move_out_checklists WHERE contract_id=%s", (cid,), fetchone=True)
    if checklist and checklist.get('repair_status') == 'pending':
        return err('Cannot complete move-out — repairs are still pending.', 409)
    execute("UPDATE contracts SET status='terminated' WHERE id=%s", (cid,))
    execute("UPDATE units SET status='vacant' WHERE id=%s", (c['unit_id'],))
    execute("UPDATE move_out_checklists SET completed_at=NOW() WHERE contract_id=%s", (cid,))
    tenant_user = query("""SELECT u.id, u.email, u.full_name FROM users u
        JOIN tenant_profiles tp ON tp.user_id=u.id WHERE tp.id=%s""", (c['tenant_id'],), fetchone=True)
    if tenant_user:
        push_notification(tenant_user['id'], 'Move-Out Complete',
                          'Your move-out is complete. Your bills, receipts and contracts stay in the app.', 'contract')
    archived = archive_if_moved_out(c['tenant_id'], lp['id'])
    log_action('COMPLETE_MOVE_OUT', 'contracts', cid)
    return ok({'archived': archived}, msg='Move-out complete. Unit is now vacant.'
              + (' The tenant is now in Past Tenants.' if archived else ''))

@app.route('/api/contracts/<int:cid>/extend', methods=['PATCH'])
@require_auth('landlord')
def extend_contract(cid):
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    new_end=data.get('end_date')
    if not new_end: return err('end_date required')
    c=query("""SELECT c.id FROM contracts c JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
               WHERE c.id=%s AND p.landlord_id=%s AND c.status='active'""",(cid,lp['id']),fetchone=True)
    if not c: return err('Not found',404)
    execute("UPDATE contracts SET end_date=%s, is_open_term=0 WHERE id=%s",(new_end,cid))
    return ok(msg='Extended')


# ════════════════════════════════════════════════════════════
# BILLS
# ════════════════════════════════════════════════════════════

# The latest payment that wasn't rejected, per bill (one row per bill, never duplicates)
LATEST_PAYMENT_JOIN = """
    LEFT JOIN payments py ON py.id = (SELECT MAX(p2.id) FROM payments p2
                                      WHERE p2.bill_id = b.id AND p2.status != 'rejected')"""

@app.route('/api/bills', methods=['GET'])
@require_auth('landlord','tenant')
def list_bills():
    u=g.current_user; contract_id=request.args.get('contract_id')
    if u['role']=='landlord':
        lp=get_landlord_profile(u['id'])
        if contract_id:
            bills=query(f"""SELECT b.*,py.id AS payment_id,py.status AS payment_status,py.amount_paid FROM bills b
                {LATEST_PAYMENT_JOIN} JOIN contracts c ON c.id=b.contract_id
                JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
                WHERE b.contract_id=%s AND p.landlord_id=%s ORDER BY b.due_date DESC""",(contract_id,lp['id']))
        else:
            bills=query(f"""SELECT b.*,u.full_name AS tenant_name,un.unit_number,p.name AS property_name,
                       py.id AS payment_id,py.status AS payment_status,py.receipt_no FROM bills b
                {LATEST_PAYMENT_JOIN}
                JOIN contracts c ON c.id=b.contract_id JOIN tenant_profiles tp ON tp.id=c.tenant_id
                JOIN users u ON u.id=tp.user_id JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
                WHERE p.landlord_id=%s ORDER BY b.due_date DESC LIMIT 200""",(lp['id'],))
    else:
        tp=get_tenant_profile(u['id'])
        bills=query(f"""SELECT b.*,py.id AS payment_id,py.status AS payment_status,py.amount_paid,py.receipt_no,
                   un.unit_number,p.name AS property_name,lu.full_name AS landlord_name FROM bills b
            {LATEST_PAYMENT_JOIN}
            JOIN contracts c ON c.id=b.contract_id JOIN units un ON un.id=c.unit_id
            JOIN properties p ON p.id=un.property_id JOIN landlord_profiles lp ON lp.id=p.landlord_id
            JOIN users lu ON lu.id=lp.user_id
            WHERE c.tenant_id=%s ORDER BY b.due_date DESC""",(tp['id'],))
    return ok(bills)

def notify_new_bill(contract_id, description, amount, due_date):
    tenant_user = query("""SELECT u.id, u.email, u.full_name FROM contracts c
        JOIN tenant_profiles tp ON tp.id=c.tenant_id JOIN users u ON u.id=tp.user_id WHERE c.id=%s""",
        (contract_id,), fetchone=True)
    if not tenant_user:
        return
    amount_txt = f'₱{float(amount):,.2f}'
    push_notification(tenant_user['id'], f'New Bill: {description}', f'{amount_txt} due {due_date}', 'bill')
    send_email_if_opted_in(
        tenant_user['id'], 'email_new_bill', tenant_user['email'], f'New Bill: {description}',
        f"""
        <h2>New Bill</h2>
        <p>Hi {h(tenant_user['full_name'])},</p>
        <p><strong>Description:</strong> {h(description)}</p>
        <p><strong>Amount:</strong> {h(amount_txt)}</p>
        <p><strong>Due Date:</strong> {h(due_date)}</p>
        <p><a href="{APP_URL}">View and Pay →</a></p>
        """)

@app.route('/api/bills', methods=['POST'])
@require_auth('landlord')
def create_bill():
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    contract_id=data.get('contract_id'); description=(data.get('description') or '').strip()
    amount=positive_amount(data.get('amount')); due_date=data.get('due_date')
    bill_type=data.get('bill_type','rent'); bill_month=data.get('bill_month') or None; bill_year=data.get('bill_year') or None
    if not all([contract_id,description,due_date]): return err('All fields required')
    if amount is None: return err('Amount must be more than 0')
    if bill_type not in ('rent','water','electricity','other'): bill_type='other'
    c=query("""SELECT c.id, c.tenant_id, p.features, p.name AS property_name FROM contracts c JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
               WHERE c.id=%s AND p.landlord_id=%s""",(contract_id,lp['id']),fetchone=True)
    if not c: return err('Contract not found',404)
    need = BILL_TYPE_FEATURE.get(bill_type)
    if need and not property_features(c['features'])[need]:
        return err(f'{bill_type.title()} bills are turned off for {c["property_name"]}. Turn them on in the property\'s Setup.')
    bid,_=execute("INSERT INTO bills (contract_id,description,bill_type,bill_month,bill_year,amount,due_date) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                  (contract_id,description[:255],bill_type,bill_month,bill_year,amount,due_date))
    notify_new_bill(contract_id, description, amount, due_date)
    return ok({'bill_id':bid},status=201)

@app.route('/api/bills/generate-monthly', methods=['POST'])
@require_auth('landlord')
def generate_monthly_bills():
    """This month's rent bill for each of the landlord's active contracts (open-term included)
    that doesn't have one yet. Due on the 7th, or today if that's already past."""
    lp=get_landlord_profile(g.current_user['id'])
    today=date.today()
    contracts=query("""SELECT c.id, c.monthly_rent, p.features FROM contracts c
        JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
        WHERE p.landlord_id=%s AND p.is_active=1 AND c.status='active' AND c.start_date <= CURDATE()
          AND (c.end_date IS NULL OR c.end_date >= CURDATE())
          AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.contract_id=c.id AND b.bill_type='rent'
                          AND ((b.bill_month=%s AND b.bill_year=%s)
                               OR (b.bill_month IS NULL AND b.description LIKE 'Monthly Rent%%'
                                   AND YEAR(b.created_at)=%s AND MONTH(b.created_at)=%s)))""",
        (lp['id'], today.month, today.year, today.year, today.month))
    contracts=[c for c in contracts if property_features(c['features'])['rent_billing']]
    due=max(today, today.replace(day=7)).isoformat()
    description=f"Monthly Rent — {today.strftime('%B %Y')}"
    for c in contracts:
        execute("""INSERT INTO bills (contract_id,description,bill_type,bill_month,bill_year,amount,due_date)
                   VALUES (%s,%s,'rent',%s,%s,%s,%s)""",
                (c['id'], description, today.month, today.year, c['monthly_rent'], due))
        notify_new_bill(c['id'], description, c['monthly_rent'], due)
    log_action('GENERATE_MONTHLY_BILLS', 'bills', None, f'{len(contracts)} bills')
    return ok({'bills_generated':len(contracts)})


# ════════════════════════════════════════════════════════════
# PAYMENTS
# ════════════════════════════════════════════════════════════

@app.route('/api/payments', methods=['POST'])
@require_auth('tenant')
def submit_payment():
    tp=get_tenant_profile(g.current_user['id'])
    if not tp: return err('Tenant profile not found', 404)
    data=request.get_json() or {}
    bill_id      = data.get('bill_id')
    amount_paid  = data.get('amount_paid')
    proof_url    = data.get('proof_url', '')
    proof_public_id = data.get('proof_public_id', '')

    amount_paid = positive_amount(amount_paid)
    if not bill_id or amount_paid is None: return err('bill_id and an amount more than 0 are required')
    if not proof_url: return err('Proof of payment is required')
    if not upload_ok(proof_url, 'payment_proof'):
        return err('Invalid proof of payment. Please upload it with the file picker.')
    b=query("""SELECT b.id, b.status, b.description, c.tenant_id,
                      (SELECT lp.user_id FROM units u JOIN properties p ON p.id=u.property_id
                       JOIN landlord_profiles lp ON lp.id=p.landlord_id WHERE u.id=c.unit_id) AS landlord_user_id
               FROM bills b JOIN contracts c ON c.id=b.contract_id
               WHERE b.id=%s AND c.tenant_id=%s""",(bill_id,tp['id']),fetchone=True)
    if not b: return err('Bill not found',404)
    if b['status'] == 'paid': return err('This bill is already paid', 409)
    if query("SELECT 1 FROM payments WHERE bill_id=%s AND status='pending'", (bill_id,), fetchone=True):
        return err('A payment for this bill is already waiting for review', 409)

    pid,_=execute(
        "INSERT INTO payments (bill_id,amount_paid,proof_url,proof_public_id) VALUES (%s,%s,%s,%s)",
        (bill_id, amount_paid, proof_url, (proof_public_id or '')[:255])
    )

    if b.get('landlord_user_id'):
        name = g.current_user["full_name"]
        push_notification(b['landlord_user_id'], 'New Payment Submitted',
                          f'{name} paid ₱{amount_paid:,.2f} for {b["description"]}.', 'payment')
        ll_user = query("SELECT email, full_name FROM users WHERE id=%s", (b['landlord_user_id'],), fetchone=True)
        if ll_user:
            # No proof link in the email - the landlord reviews it in the app
            send_email_if_opted_in(
                b['landlord_user_id'], 'email_payment_submitted',
                ll_user['email'],
                f'Payment Submitted by {name}',
                f'<h2>New Payment Submitted</h2><p>{h(name)} submitted a payment of ₱{amount_paid:,.2f} '
                f'for {h(b["description"])}.</p><p><a href="{APP_URL}">Review in dashboard</a></p>'
            )

    return ok({'payment_id':pid},status=201)

@app.route('/api/payments', methods=['GET'])
@require_auth('landlord','tenant')
def list_payments():
    u=g.current_user; bill_id=request.args.get('bill_id')
    if u['role']=='landlord':
        lp=get_landlord_profile(u['id'])
        if bill_id:
            payments=query("""SELECT py.* FROM payments py JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
                JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
                WHERE py.bill_id=%s AND p.landlord_id=%s ORDER BY py.paid_at DESC""",(bill_id,lp['id']))
        else:
            payments=query("""SELECT py.*,u.full_name AS tenant_name,b.description AS bill_desc,b.bill_type FROM payments py
                JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
                JOIN tenant_profiles tp ON tp.id=c.tenant_id JOIN users u ON u.id=tp.user_id
                JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
                WHERE p.landlord_id=%s ORDER BY py.paid_at DESC LIMIT 50""",(lp['id'],))
    else:
        tp=get_tenant_profile(u['id'])
        payments=query("""SELECT py.*,b.description AS bill_desc,b.amount AS bill_amount,b.bill_type FROM payments py
            JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
            WHERE c.tenant_id=%s ORDER BY py.paid_at DESC""",(tp['id'],))
    return ok(payments)

@app.route('/api/payments/<int:pid>/approve', methods=['PATCH'])
@require_auth('landlord')
def approve_payment(pid):
    lp=get_landlord_profile(g.current_user['id'])
    p=query("""SELECT py.id, py.status, c.tenant_id FROM payments py
               JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
               JOIN units un ON un.id=c.unit_id JOIN properties pr ON pr.id=un.property_id
               WHERE py.id=%s AND pr.landlord_id=%s""",(pid,lp['id']),fetchone=True)
    if not p: return err('Not found',404)
    if p['status'] != 'pending': return err('This payment was already reviewed', 409)
    execute("UPDATE payments SET status='approved',reviewed_at=NOW(),reviewed_by=%s WHERE id=%s",(g.current_user['id'],pid))
    receipt_no = issue_receipt(pid)
    return ok({'receipt_no': receipt_no}, msg=f'Approved. Receipt {receipt_no} sent to the tenant.')

@app.route('/api/payments/<int:pid>/reject', methods=['PATCH'])
@require_auth('landlord')
def reject_payment(pid):
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    notes=data.get('notes','')
    p=query("""SELECT py.id, py.status, c.tenant_id FROM payments py
               JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
               JOIN units un ON un.id=c.unit_id JOIN properties pr ON pr.id=un.property_id
               WHERE py.id=%s AND pr.landlord_id=%s""",(pid,lp['id']),fetchone=True)
    if not p: return err('Not found',404)
    if p['status'] != 'pending': return err('This payment was already reviewed', 409)
    execute("UPDATE payments SET status='rejected',notes=%s,reviewed_at=NOW(),reviewed_by=%s WHERE id=%s",(notes,g.current_user['id'],pid))

    tenant_user = query(
        "SELECT u.id, u.email, u.full_name FROM users u JOIN tenant_profiles tp ON tp.user_id=u.id WHERE tp.id=%s",
        (p['tenant_id'],), fetchone=True
    )
    if tenant_user:
        push_notification(tenant_user['id'], 'Payment Rejected',
                          f'Your payment was rejected. {notes}', 'payment')
        send_email_if_opted_in(
            tenant_user['id'], 'email_payment_rejected',
            tenant_user['email'],
            'Your Payment Was Rejected',
            f"""
            <h2>Payment Rejected</h2>
            <p>Hi {h(tenant_user['full_name'])},</p>
            <p>Your payment submission was <strong>rejected</strong>.</p>
            {f'<p><strong>Reason:</strong> {h(notes)}</p>' if notes else ''}
            <p>Please resubmit with the correct proof of payment.</p>
            <p><a href="{APP_URL}">Go to dashboard →</a></p>
            """
        )

    return ok(msg='Rejected')


# ════════════════════════════════════════════════════════════
# TENANT RECORDS (CRM) — tenant board, profile, past tenants
# ════════════════════════════════════════════════════════════

def still_linked(landlord_user_id, tenant_user_id):
    """True while the tenant is a current tenant of this landlord (not moved out)."""
    return bool(query("""SELECT 1 FROM tenant_landlords tl
        JOIN tenant_profiles tp ON tp.id=tl.tenant_id JOIN landlord_profiles lp ON lp.id=tl.landlord_id
        WHERE tp.user_id=%s AND lp.user_id=%s AND tl.is_active=1""", (tenant_user_id, landlord_user_id), fetchone=True))

def archive_if_moved_out(tenant_profile_id, landlord_profile_id):
    """A tenant with no current unit left at this landlord becomes a past tenant: their records
    stay, but no new messages, contracts or announcements. Rejoining with the code restores them."""
    if query("""SELECT 1 FROM contracts c JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
                WHERE c.tenant_id=%s AND p.landlord_id=%s AND c.status IN ('active','move_out_pending')""",
             (tenant_profile_id, landlord_profile_id), fetchone=True):
        return False
    execute("UPDATE tenant_landlords SET is_active=0, left_at=NOW() WHERE tenant_id=%s AND landlord_id=%s",
            (tenant_profile_id, landlord_profile_id))
    return True


@app.route('/api/landlord/tenants/<int:tp_id>/archive', methods=['POST'])
@require_auth('landlord')
def archive_tenant(tp_id):
    """Move a tenant without a current unit (e.g. joined but never moved in) to Past Tenants."""
    lp = get_landlord_profile(g.current_user['id'])
    if not query("SELECT 1 FROM tenant_landlords WHERE tenant_id=%s AND landlord_id=%s AND is_active=1",
                 (tp_id, lp['id']), fetchone=True):
        return err('Tenant not found', 404)
    if not archive_if_moved_out(tp_id, lp['id']):
        return err('This tenant still has a unit. Finish their move-out first.', 409)
    log_action('ARCHIVE_TENANT', 'tenant_landlords', tp_id)
    return ok(msg='Moved to Past Tenants')


@app.route('/api/landlord/tenant-board', methods=['GET'])
@require_auth('landlord')
def tenant_board():
    """Tenants by property -> unit (current tenant of each unit), then tenants who joined but
    have no unit yet, then past tenants."""
    lp = get_landlord_profile(g.current_user['id'])
    props = query("SELECT id, name, address, city FROM properties WHERE landlord_id=%s AND is_active=1 ORDER BY name",
                  (lp['id'],))
    units = query("""SELECT un.id, un.unit_number, un.status, un.property_id, un.rent_amount FROM units un
        JOIN properties p ON p.id=un.property_id WHERE p.landlord_id=%s AND p.is_active=1""", (lp['id'],))
    current = query("""SELECT c.id AS contract_id, c.unit_id, c.status, c.start_date, c.end_date, c.is_open_term,
               c.monthly_rent, c.deposit, c.tenant_ack, c.contract_doc_url, c.move_out_date,
               tp.id AS tenant_id, u.id AS user_id, u.full_name, u.email, u.phone,
               (SELECT COALESCE(SUM(b.amount),0) FROM bills b WHERE b.contract_id=c.id AND b.status!='paid') AS unpaid,
               (SELECT COUNT(*) FROM bills b WHERE b.contract_id=c.id AND b.status='overdue') AS overdue
        FROM contracts c JOIN tenant_profiles tp ON tp.id=c.tenant_id JOIN users u ON u.id=tp.user_id
        JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
        WHERE p.landlord_id=%s AND c.status IN ('active','move_out_pending') ORDER BY c.start_date""", (lp['id'],))
    linked = query("""SELECT tp.id AS tenant_id, u.id AS user_id, u.full_name, u.email, u.phone,
               tl.joined_at, tl.is_active, tl.left_at
        FROM tenant_landlords tl JOIN tenant_profiles tp ON tp.id=tl.tenant_id JOIN users u ON u.id=tp.user_id
        WHERE tl.landlord_id=%s ORDER BY u.full_name""", (lp['id'],))
    last_units = query("""SELECT c.tenant_id, GROUP_CONCAT(DISTINCT CONCAT(p.name, ' — Unit ', un.unit_number)
                                  ORDER BY c.start_date SEPARATOR '; ') AS units,
               MAX(COALESCE(c.move_out_date, c.end_date)) AS moved_out
        FROM contracts c JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
        WHERE p.landlord_id=%s GROUP BY c.tenant_id""", (lp['id'],))
    last_by_tenant = {r['tenant_id']: r for r in last_units}
    housed = {c['tenant_id'] for c in current}
    by_unit = {}
    for c in current:
        by_unit.setdefault(c['unit_id'], []).append(c)
    for un in units:
        un['contracts'] = by_unit.get(un['id'], [])
    for p in props:
        p['units'] = [un for un in units if un['property_id'] == p['id']]
    past = []
    for t in linked:
        if not t['is_active']:
            lu = last_by_tenant.get(t['tenant_id']) or {}
            past.append({**t, 'units': lu.get('units'), 'moved_out': lu.get('moved_out')})
    return ok({'properties': props,
               'unassigned': [t for t in linked if t['is_active'] and t['tenant_id'] not in housed],
               'past': sorted(past, key=lambda t: t['left_at'] or datetime.min, reverse=True)})


@app.route('/api/landlord/tenants/<int:tp_id>/profile', methods=['GET'])
@require_auth('landlord')
def tenant_profile(tp_id):
    """Everything about one tenant at this landlord: contracts, every bill with its payment
    timeline (submitted -> approved -> receipt sent), payments, water readings, conversations."""
    lp = get_landlord_profile(g.current_user['id'])
    link = query("""SELECT tl.joined_at, tl.is_active, tl.left_at, tp.id AS tenant_id, u.id AS user_id,
               u.full_name, u.email, u.phone, u.created_at AS account_created
        FROM tenant_landlords tl JOIN tenant_profiles tp ON tp.id=tl.tenant_id JOIN users u ON u.id=tp.user_id
        WHERE tl.tenant_id=%s AND tl.landlord_id=%s""", (tp_id, lp['id']), fetchone=True)
    if not link: return err('Tenant not found', 404)
    scope = """FROM contracts c JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
               WHERE c.tenant_id=%s AND p.landlord_id=%s"""
    contracts = query(f"""SELECT c.*, un.unit_number, p.name AS property_name {scope}
                          ORDER BY c.start_date DESC""", (tp_id, lp['id']))
    bills = query(f"""SELECT b.*, un.unit_number, p.name AS property_name,
               py.id AS payment_id, py.status AS payment_status, py.amount_paid, py.paid_at,
               py.reviewed_at, py.receipt_no, py.receipt_sent_at
        FROM bills b {LATEST_PAYMENT_JOIN}
        JOIN contracts c ON c.id=b.contract_id JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
        WHERE c.tenant_id=%s AND p.landlord_id=%s ORDER BY b.due_date DESC""", (tp_id, lp['id']))
    payments = query(f"""SELECT py.*, b.description AS bill_desc, b.bill_type, b.amount AS bill_amount, b.due_date,
               rv.full_name AS reviewed_by_name
        FROM payments py JOIN bills b ON b.id=py.bill_id
        JOIN contracts c ON c.id=b.contract_id JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
        LEFT JOIN users rv ON rv.id=py.reviewed_by
        WHERE c.tenant_id=%s AND p.landlord_id=%s ORDER BY py.paid_at DESC""", (tp_id, lp['id']))
    water = query(f"""SELECT wmr.prev_reading, wmr.curr_reading, wmr.consumption, wmr.water_bill, wmr.pump_fee,
               wmr.total_amount, wms.session_month, wms.session_year, wms.price_per_cubic,
               b.id AS bill_id, b.status AS bill_status, b.due_date, un.unit_number
        FROM water_meter_readings wmr JOIN water_meter_sessions wms ON wms.id=wmr.session_id
        JOIN bills b ON b.id=wmr.bill_id
        JOIN contracts c ON c.id=b.contract_id JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
        WHERE c.tenant_id=%s AND p.landlord_id=%s ORDER BY wms.session_year DESC, wms.session_month DESC""",
        (tp_id, lp['id']))
    threads = query("""SELECT id, subject, last_reply_at, created_at FROM message_threads
                       WHERE landlord_id=%s AND tenant_id=%s ORDER BY last_reply_at DESC""",
                    (g.current_user['id'], link['user_id']))
    approved = [p for p in payments if p['status'] == 'approved']
    on_time = [p for p in approved if p['paid_at'] and p['due_date'] and p['paid_at'].date() <= p['due_date']]
    summary = {
        'total_billed': sum(float(b['amount']) for b in bills),
        'total_paid': sum(float(p['amount_paid']) for p in approved),
        'unpaid': sum(float(b['amount']) for b in bills if b['status'] != 'paid'),
        'overdue_bills': sum(1 for b in bills if b['status'] == 'overdue'),
        'pending_payments': sum(1 for p in payments if p['status'] == 'pending'),
        'on_time_rate': round(100 * len(on_time) / len(approved)) if approved else None,
    }
    return ok({'tenant': link, 'summary': summary, 'contracts': contracts, 'bills': bills,
               'payments': payments, 'water': water, 'threads': threads})


# ── Printable documents (bill statements, receipts) ──
# Opened in a new tab / the phone's PDF viewer, which can't send the sign-in header, so the app
# asks /api/docs/link for a 10-minute link that only works for that one document.
DOC_PATHS = re.compile(r'^/api/(bills/\d+/pdf|payments/\d+/receipt\.pdf|files/[A-Za-z0-9_-]{20,64})$')

def make_doc_token(user_id, path):
    return pyjwt.encode({'sub': str(user_id), 'scope': 'doc', 'path': path,
                         'exp': datetime.utcnow() + timedelta(minutes=10)}, SECRET_KEY, algorithm='HS256')

def require_doc_auth(*roles):
    def decorator(f):
        bearer = require_auth(*roles)(f)
        @wraps(f)
        def wrapper(*args, **kwargs):
            dt = request.args.get('dt')
            if not dt:
                return bearer(*args, **kwargs)
            try:
                payload = decode_token(dt)
            except Exception:
                return err('This document link has expired. Open it again from the app.', 401)
            if payload.get('scope') != 'doc' or payload.get('path') != request.path:
                return err('Invalid document link', 401)
            user = query("SELECT * FROM users WHERE id=%s AND is_active=1", (payload['sub'],), fetchone=True)
            if not user or (roles and user['role'] not in roles):
                return err('Access denied', 403)
            g.current_user = user
            return f(*args, **kwargs)
        return wrapper
    return decorator

@app.route('/api/docs/link', methods=['POST'])
@require_auth('landlord', 'tenant')
def doc_link():
    path = ((request.get_json() or {}).get('path') or '').strip()
    if not DOC_PATHS.match(path): return err('Unknown document')
    return ok({'url': f"{path}?dt={make_doc_token(g.current_user['id'], path)}"})

def pdf_response(data, filename):
    return Response(data, mimetype='application/pdf',
                    headers={'Content-Disposition': f'inline; filename="{filename}"', 'Cache-Control': 'private, no-store'})

def bill_document(bill_id):
    """Everything a bill statement / receipt prints, or None."""
    b = query("""SELECT b.*, c.tenant_id, un.unit_number, p.name AS property_name, p.address, p.city,
               lp.user_id AS landlord_user_id, lp.business_name, lu.full_name AS landlord_name,
               lu.email AS landlord_email, lu.phone AS landlord_phone,
               tu.id AS tenant_user_id, tu.full_name AS tenant_name, tu.email AS tenant_email, tu.phone AS tenant_phone
        FROM bills b JOIN contracts c ON c.id=b.contract_id JOIN units un ON un.id=c.unit_id
        JOIN properties p ON p.id=un.property_id JOIN landlord_profiles lp ON lp.id=p.landlord_id
        JOIN users lu ON lu.id=lp.user_id JOIN tenant_profiles tp ON tp.id=c.tenant_id JOIN users tu ON tu.id=tp.user_id
        WHERE b.id=%s""", (bill_id,), fetchone=True)
    if not b:
        return None
    payments = query("SELECT * FROM payments WHERE bill_id=%s AND status!='rejected' ORDER BY paid_at", (bill_id,))
    paid = sum(float(p['amount_paid']) for p in payments if p['status'] == 'approved')
    water = query("""SELECT wmr.*, wms.price_per_cubic, wms.prev_reading_date, wms.curr_reading_date
        FROM water_meter_readings wmr JOIN water_meter_sessions wms ON wms.id=wmr.session_id
        WHERE wmr.bill_id=%s""", (bill_id,), fetchone=True)
    return {
        'bill': b, 'payments': payments, 'paid_total': paid, 'balance': float(b['amount']) - paid, 'water': water,
        'unit_number': b['unit_number'],
        'property': {'name': b['property_name'], 'address': b['address'], 'city': b['city']},
        'tenant': {'full_name': b['tenant_name'], 'email': b['tenant_email'], 'phone': b['tenant_phone']},
        'landlord': {'display_name': b['business_name'] or b['landlord_name'], 'email': b['landlord_email'],
                     'phone': b['landlord_phone']},
    }

def can_see_bill(doc):
    return g.current_user['id'] in (doc['bill']['landlord_user_id'], doc['bill']['tenant_user_id'])

@app.route('/api/bills/<int:bid>/pdf', methods=['GET'])
@require_doc_auth('landlord', 'tenant')
def bill_pdf(bid):
    doc = bill_document(bid)
    if not doc or not can_see_bill(doc): return err('Bill not found', 404)
    return pdf_response(pdfs.bill_pdf(doc), f'Bill-B-{bid:06d}.pdf')

def receipt_document(pid):
    p = query("""SELECT py.*, rv.full_name AS reviewer_name FROM payments py
                 LEFT JOIN users rv ON rv.id=py.reviewed_by WHERE py.id=%s AND py.status='approved'""", (pid,), fetchone=True)
    if not p:
        return None
    if not p['receipt_no']:   # payments approved before receipts existed
        execute("UPDATE payments SET receipt_no=CONCAT('AR-', LPAD(id, 6, '0')) WHERE id=%s AND receipt_no IS NULL", (pid,))
        p['receipt_no'] = f'AR-{pid:06d}'
    doc = bill_document(p['bill_id'])
    doc.update({'payment': p, 'reviewer_name': p['reviewer_name']})
    return doc

@app.route('/api/payments/<int:pid>/receipt.pdf', methods=['GET'])
@require_doc_auth('landlord', 'tenant')
def receipt_pdf(pid):
    doc = receipt_document(pid)
    if not doc or not can_see_bill(doc): return err('Receipt not found', 404)
    return pdf_response(pdfs.receipt_pdf(doc), f'Receipt-{doc["payment"]["receipt_no"]}.pdf')

def issue_receipt(pid, resend=False):
    """Numbers the receipt, notifies the tenant (phone + bell) and emails the PDF; records when
    it was sent. Never raises - approving must not fail because of email."""
    try:
        doc = receipt_document(pid)
        p, b = doc['payment'], doc['bill']
        push_notification(b['tenant_user_id'], f'Receipt {p["receipt_no"]}',
                          f'Payment of ₱{float(p["amount_paid"]):,.2f} for {b["description"]} approved.', 'payment')
        html_body = (f'<h2>Payment received ✓</h2><p>Hi {h(b["tenant_name"])},</p>'
                     f'<p>Your payment of <strong>₱{float(p["amount_paid"]):,.2f}</strong> for {h(b["description"])} '
                     f'has been approved. Your receipt <strong>{h(p["receipt_no"])}</strong> is attached.</p>'
                     f'<p><a href="{APP_URL}">View your bills →</a></p>')
        attachment = [(f'Receipt-{p["receipt_no"]}.pdf', pdfs.receipt_pdf(doc), 'application/pdf')]
        subject = f'Receipt {p["receipt_no"]} — {b["description"]}'
        if resend:
            send_email(b['tenant_email'], subject, html_body, attachment)
        else:
            send_email_if_opted_in(b['tenant_user_id'], 'email_payment_approved', b['tenant_email'], subject,
                                   html_body, attachment)
        execute("UPDATE payments SET receipt_sent_at=NOW() WHERE id=%s", (pid,))
        return p['receipt_no']
    except Exception as e:
        log.warning("Receipt for payment %s failed: %s", pid, e)
        return f'AR-{pid:06d}'

@app.route('/api/payments/<int:pid>/send-receipt', methods=['POST'])
@require_auth('landlord')
def resend_receipt(pid):
    lp = get_landlord_profile(g.current_user['id'])
    if not query("""SELECT 1 FROM payments py JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
                    JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
                    WHERE py.id=%s AND p.landlord_id=%s AND py.status='approved'""", (pid, lp['id']), fetchone=True):
        return err('Approved payment not found', 404)
    no = issue_receipt(pid, resend=True)
    return ok({'receipt_no': no}, msg=f'Receipt {no} sent again')


# ════════════════════════════════════════════════════════════
# FILE UPLOADS — private, on our server
# ════════════════════════════════════════════════════════════
# Payment proofs, signed contracts and repair receipts are stored in UPLOAD_DIR (inside the app
# folder, which the web server doesn't serve) and only come back through /api/files/<token>, to
# the person who uploaded it and the tenant + landlord of the record it's attached to.

UPLOAD_DIR = os.environ.get('UPLOAD_DIR') or os.path.join(BASE_DIR, 'uploads')
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_UPLOADS_PER_DAY = 60
# kind -> who may upload it, and which file types it takes
UPLOAD_KINDS = {
    'payment_proof': ('tenant', {'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'}),
    'contract': ('landlord', {'application/pdf', 'image/jpeg', 'image/png'}),
    'repair_proof': ('landlord', {'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'}),
}
FILE_EXT = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'application/pdf': '.pdf'}
FILE_URL = re.compile(r'^/api/files/([A-Za-z0-9_-]{20,64})$')

def sniff_mime(head):
    """The real type from the first bytes - never trust the name or the browser's claim."""
    if head.startswith(b'\xff\xd8\xff'): return 'image/jpeg'
    if head.startswith(b'\x89PNG\r\n\x1a\n'): return 'image/png'
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP': return 'image/webp'
    if head[4:8] == b'ftyp' and head[8:12] in (b'heic', b'heix', b'mif1', b'msf1', b'hevc'): return 'image/heic'
    if head.startswith(b'%PDF-'): return 'application/pdf'
    return None

def save_upload(data, kind, owner_user_id, original_name=''):
    """Stores bytes as a new file; returns its /api/files/<token> URL. Raises ValueError if not allowed."""
    if kind not in UPLOAD_KINDS:
        raise ValueError('Unknown upload type')
    if not data:
        raise ValueError('The file is empty')
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError('The file is too big (10 MB max)')
    mime = sniff_mime(data[:16])
    if mime not in UPLOAD_KINDS[kind][1]:
        raise ValueError('Please upload a photo (JPG, PNG, WEBP, HEIC) or a PDF')
    os.makedirs(UPLOAD_DIR, mode=0o700, exist_ok=True)
    token = secrets.token_urlsafe(24)
    with open(os.path.join(UPLOAD_DIR, token + FILE_EXT[mime]), 'wb') as f:
        f.write(data)
    execute("""INSERT INTO files (token, owner_user_id, kind, original_name, mime, size_bytes)
               VALUES (%s,%s,%s,%s,%s,%s)""",
            (token, owner_user_id, kind, (original_name or '')[:255], mime, len(data)))
    return f'/api/files/{token}'

def upload_ok(url, kind, current=None):
    """A record may point at a file the signed-in person just uploaded for this purpose (or keep
    the one it already has)."""
    if not url or url == current:
        return True
    m = FILE_URL.match(url)
    return bool(m and query("SELECT 1 FROM files WHERE token=%s AND owner_user_id=%s AND kind=%s",
                            (m.group(1), g.current_user['id'], kind), fetchone=True))

def file_parties(url):
    """User ids of the tenant and landlord of every record this file is attached to."""
    rows = query("""
        SELECT tp.user_id AS tenant_user, lp.user_id AS landlord_user FROM payments py
          JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
          JOIN tenant_profiles tp ON tp.id=c.tenant_id JOIN units un ON un.id=c.unit_id
          JOIN properties p ON p.id=un.property_id JOIN landlord_profiles lp ON lp.id=p.landlord_id
         WHERE py.proof_url=%s
        UNION ALL
        SELECT tp.user_id, lp.user_id FROM contracts c
          JOIN tenant_profiles tp ON tp.id=c.tenant_id JOIN units un ON un.id=c.unit_id
          JOIN properties p ON p.id=un.property_id JOIN landlord_profiles lp ON lp.id=p.landlord_id
         WHERE c.contract_doc_url=%s
        UNION ALL
        SELECT tp.user_id, lp.user_id FROM move_out_checklists m JOIN contracts c ON c.id=m.contract_id
          JOIN tenant_profiles tp ON tp.id=c.tenant_id JOIN units un ON un.id=c.unit_id
          JOIN properties p ON p.id=un.property_id JOIN landlord_profiles lp ON lp.id=p.landlord_id
         WHERE m.repair_proof_url=%s""", (url, url, url))
    return {u for r in rows for u in (r['tenant_user'], r['landlord_user'])}

@app.route('/api/files', methods=['POST'])
@require_auth('landlord', 'tenant')
def upload_file():
    kind = request.form.get('kind', '')
    f = request.files.get('file')
    if kind not in UPLOAD_KINDS: return err('Unknown upload type')
    if g.current_user['role'] != UPLOAD_KINDS[kind][0]: return err('Access denied', 403)
    if not f: return err('Choose a file to upload')
    recent = query("SELECT COUNT(*) AS n FROM files WHERE owner_user_id=%s AND created_at > NOW() - INTERVAL 1 DAY",
                   (g.current_user['id'],), fetchone=True)
    if recent and recent['n'] >= MAX_UPLOADS_PER_DAY:
        return err('Too many uploads today. Please try again tomorrow.', 429)
    try:
        url = save_upload(f.read(MAX_UPLOAD_BYTES + 1), kind, g.current_user['id'], f.filename)
    except ValueError as e:
        return err(str(e))
    return ok({'url': url, 'name': f.filename}, status=201)

@app.route('/api/files/<token>', methods=['GET'])
@require_doc_auth('landlord', 'tenant')
def get_file(token):
    row = query("SELECT * FROM files WHERE token=%s", (token,), fetchone=True)
    url = f'/api/files/{token}'
    if not row or (row['owner_user_id'] != g.current_user['id'] and g.current_user['id'] not in file_parties(url)):
        return err('File not found', 404)
    path = os.path.join(UPLOAD_DIR, token + FILE_EXT.get(row['mime'], ''))
    if not os.path.isfile(path):
        return err('File not found', 404)
    with open(path, 'rb') as fh:
        data = fh.read()
    name = re.sub(r'[^\w.\- ]', '_', row['original_name'] or ('file' + FILE_EXT.get(row['mime'], '')))
    return Response(data, mimetype=row['mime'],
                    headers={'Content-Disposition': f'inline; filename="{name}"', 'Cache-Control': 'private, no-store'})


# ════════════════════════════════════════════════════════════
# WATER BILLING
# ════════════════════════════════════════════════════════════

@app.route('/api/water/sessions', methods=['GET'])
@require_auth('landlord')
def list_water_sessions():
    lp=get_landlord_profile(g.current_user['id']); pid=request.args.get('property_id')
    if pid:
        sessions=query("""SELECT wms.*,p.name AS property_name FROM water_meter_sessions wms
            JOIN properties p ON p.id=wms.property_id WHERE wms.property_id=%s AND p.landlord_id=%s
            ORDER BY wms.session_year DESC,wms.session_month DESC""",(pid,lp['id']))
    else:
        sessions=query("""SELECT wms.*,p.name AS property_name FROM water_meter_sessions wms
            JOIN properties p ON p.id=wms.property_id WHERE p.landlord_id=%s
            ORDER BY wms.session_year DESC,wms.session_month DESC""",(lp['id'],))
    return ok(sessions)

@app.route('/api/water/sessions', methods=['POST'])
@require_auth('landlord')
def create_water_session():
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    property_id=data.get('property_id'); session_month=data.get('session_month'); session_year=data.get('session_year')
    prev_reading_date=data.get('prev_reading_date'); curr_reading_date=data.get('curr_reading_date')
    try:
        total_bill=float(data.get('total_bill') or 0); overall_consumption=float(data.get('overall_consumption') or 0)
    except (TypeError, ValueError):
        return err('Amounts must be numbers')
    try:
        pump_total=float(data.get('pump_total') or 0); number_of_units=int(data.get('number_of_units') or 1)
    except (TypeError, ValueError):
        return err('Amounts must be numbers')
    if not all([property_id,session_month,session_year,prev_reading_date,curr_reading_date,total_bill,overall_consumption]):
        return err('All fields required')
    p=query("SELECT id, name, features FROM properties WHERE id=%s AND landlord_id=%s AND is_active=1",(property_id,lp['id']),fetchone=True)
    if not p: return err('Property not found',404)
    if not property_features(p['features'])['water_billing']:
        return err(f"Water billing is turned off for {p['name']}. Turn it on in the property's Setup.")
    if overall_consumption<=0: return err('Consumption must be > 0')
    price_per_cubic=total_bill/overall_consumption
    pump_per_unit=pump_total/number_of_units if number_of_units>0 else 0
    try:
        sid,_=execute("""INSERT INTO water_meter_sessions (property_id,session_month,session_year,prev_reading_date,curr_reading_date,
            total_bill,overall_consumption,price_per_cubic,pump_total,number_of_units,pump_per_unit) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (property_id,session_month,session_year,prev_reading_date,curr_reading_date,total_bill,overall_consumption,price_per_cubic,pump_total,number_of_units,pump_per_unit))
    except Exception as e:
        if 'Duplicate' in str(e): return err('Session already exists for this month',409)
        raise
    return ok({'session_id':sid,'price_per_cubic':round(price_per_cubic,4),'pump_per_unit':round(pump_per_unit,4)},status=201)

@app.route('/api/water/sessions/<int:sid>', methods=['GET'])
@require_auth('landlord')
def get_water_session(sid):
    lp=get_landlord_profile(g.current_user['id'])
    session=query("""SELECT wms.*,p.name AS property_name FROM water_meter_sessions wms
        JOIN properties p ON p.id=wms.property_id WHERE wms.id=%s AND p.landlord_id=%s""",(sid,lp['id']),fetchone=True)
    if not session: return err('Not found',404)
    readings=query("""SELECT wmr.*,u.unit_number FROM water_meter_readings wmr JOIN units u ON u.id=wmr.unit_id WHERE wmr.session_id=%s ORDER BY u.unit_number""",(sid,))
    return ok({'session':session,'readings':readings})

@app.route('/api/water/sessions/<int:sid>/readings', methods=['POST'])
@require_auth('landlord')
def save_water_readings(sid):
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    session=query("""SELECT wms.* FROM water_meter_sessions wms JOIN properties p ON p.id=wms.property_id
        WHERE wms.id=%s AND p.landlord_id=%s""",(sid,lp['id']),fetchone=True)
    if not session: return err('Not found',404)
    if session['status']=='billed': return err('Already billed',409)
    readings=data.get('readings',[])
    if not readings: return err('No readings')
    price_per_cubic=float(session['price_per_cubic']); pump_per_unit=float(session['pump_per_unit'])
    # Only units of this session's property (the landlord's own)
    prop_units={u['id'] for u in query("SELECT id FROM units WHERE property_id=%s",(session['property_id'],))}
    try:
        readings=[{**r,'unit_id':int(r.get('unit_id')),'prev_reading':float(r.get('prev_reading') or 0),
                   'curr_reading':float(r.get('curr_reading') or 0)} for r in readings]
    except (TypeError, ValueError):
        return err('Readings must be numbers')
    for r in readings:
        if r['unit_id'] not in prop_units: return err('Unit not found in this property', 404)
        if r['curr_reading']<r['prev_reading'] or r['prev_reading']<0:
            return err(f"Current reading is lower than previous for unit {r['unit_id']}")
    saved=[]
    for r in readings:
        unit_id=r['unit_id']; prev_reading=r['prev_reading']
        curr_reading=r['curr_reading']; is_owner_unit=1 if r.get('is_owner_unit') else 0
        consumption=curr_reading-prev_reading; water_bill=price_per_cubic*consumption
        pump_fee=pump_per_unit; total_amount=water_bill+pump_fee
        execute("DELETE FROM water_meter_readings WHERE session_id=%s AND unit_id=%s",(sid,unit_id))
        execute("""INSERT INTO water_meter_readings (session_id,unit_id,is_owner_unit,prev_reading,curr_reading,consumption,water_bill,pump_fee,total_amount)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",(sid,unit_id,is_owner_unit,prev_reading,curr_reading,consumption,water_bill,pump_fee,total_amount))
        saved.append({'unit_id':unit_id,'consumption':consumption,'total_amount':round(total_amount,2)})
    return ok({'saved':saved})

@app.route('/api/water/sessions/<int:sid>/generate-bills', methods=['POST'])
@require_auth('landlord')
def generate_water_bills(sid):
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    due_date=data.get('due_date')
    if not due_date: return err('due_date required')
    session=query("""SELECT wms.*,p.name AS property_name FROM water_meter_sessions wms
        JOIN properties p ON p.id=wms.property_id WHERE wms.id=%s AND p.landlord_id=%s""",(sid,lp['id']),fetchone=True)
    if not session: return err('Not found',404)
    if session['status']=='billed': return err('Already billed',409)
    readings=query("""SELECT wmr.*,u.unit_number FROM water_meter_readings wmr JOIN units u ON u.id=wmr.unit_id
        WHERE wmr.session_id=%s AND wmr.is_owner_unit=0 AND u.property_id=%s""",(sid,session['property_id']))
    if not readings: return err('No readings. Save readings first.',400)
    month_names=['January','February','March','April','May','June','July','August','September','October','November','December']
    month_name=month_names[int(session['session_month'])-1]; bills_created=0
    for r in readings:
        contract=query("SELECT c.id FROM contracts c WHERE c.unit_id=%s AND c.status IN ('active','move_out_pending') ORDER BY c.id DESC LIMIT 1",(r['unit_id'],),fetchone=True)
        if not contract: continue
        description=f"Water Bill — {month_name} {session['session_year']} (Unit {r['unit_number']})"
        bid,_=execute("INSERT INTO bills (contract_id,description,bill_type,bill_month,bill_year,amount,due_date) VALUES (%s,%s,'water',%s,%s,%s,%s)",
                      (contract['id'],description,session['session_month'],session['session_year'],r['total_amount'],due_date))
        execute("UPDATE water_meter_readings SET bill_id=%s WHERE id=%s",(bid,r['id']))
        notify_new_bill(contract['id'], description, r['total_amount'], due_date)
        bills_created+=1
    execute("UPDATE water_meter_sessions SET status='billed' WHERE id=%s",(sid,))
    return ok({'bills_created':bills_created})


# ════════════════════════════════════════════════════════════
# REMINDERS
# ════════════════════════════════════════════════════════════

@app.route('/api/reminders', methods=['GET'])
@require_auth('landlord')
def list_reminders():
    lp=get_landlord_profile(g.current_user['id'])
    return ok(query("SELECT * FROM reminders WHERE landlord_id=%s ORDER BY day_of_month",(lp['id'],)))

@app.route('/api/reminders', methods=['POST'])
@require_auth('landlord')
def create_reminder():
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    title=(data.get('title') or '').strip(); reminder_type=data.get('reminder_type','custom'); day_of_month=data.get('day_of_month')
    if not title or not day_of_month: return err('Title and day required')
    if not (1<=int(day_of_month)<=28): return err('Day must be 1–28')
    rid,_=execute("INSERT INTO reminders (landlord_id,title,reminder_type,day_of_month) VALUES (%s,%s,%s,%s)",(lp['id'],title,reminder_type,day_of_month))
    return ok({'reminder_id':rid},status=201)

@app.route('/api/reminders/<int:rid>', methods=['DELETE'])
@require_auth('landlord')
def delete_reminder(rid):
    lp=get_landlord_profile(g.current_user['id'])
    execute("DELETE FROM reminders WHERE id=%s AND landlord_id=%s",(rid,lp['id']))
    return ok(msg='Deleted')


# ════════════════════════════════════════════════════════════
# DASHBOARDS
# ════════════════════════════════════════════════════════════

@app.route('/api/landlord/tenants', methods=['GET'])
@require_auth('landlord')
def landlord_tenants():
    """The landlord's tenants. Contract/unit columns only ever show this landlord's own units
    (a tenant may also rent elsewhere). A tenant renting several units here is one row."""
    lp = get_landlord_profile(g.current_user['id'])
    tenants = query("""
        SELECT tp.id, u.id AS user_id, u.full_name, u.email, u.phone, u.is_active, tl.joined_at,
               MAX(c.id) AS contract_id,
               MAX(c.status) AS contract_status,
               GROUP_CONCAT(DISTINCT un.unit_number ORDER BY un.unit_number SEPARATOR ', ') AS unit_number,
               GROUP_CONCAT(DISTINCT p.name ORDER BY p.name SEPARATOR ', ') AS property_name
        FROM tenant_landlords tl
        JOIN tenant_profiles tp ON tp.id = tl.tenant_id
        JOIN users u ON u.id = tp.user_id
        LEFT JOIN (contracts c
                   JOIN units un ON un.id = c.unit_id
                   JOIN properties p ON p.id = un.property_id AND p.landlord_id = %s)
               ON c.tenant_id = tp.id AND c.status IN ('active','move_out_pending')
        WHERE tl.landlord_id = %s AND tl.is_active = 1
        GROUP BY tp.id, u.id, u.full_name, u.email, u.phone, u.is_active, tl.joined_at
        ORDER BY tl.joined_at DESC
    """, (lp['id'], lp['id']))
    return ok(tenants)


@app.route('/api/landlord/join-code', methods=['GET', 'POST'])
@require_auth('landlord')
def landlord_join_code():
    """The landlord's join code and link. POST {"regenerate": true} replaces the code, so old
    links and printed QR codes stop working; tenants who already joined are not affected."""
    lp = get_landlord_profile(g.current_user['id'])
    code = lp['landlord_code']
    if request.method == 'POST' and (request.get_json(silent=True) or {}).get('regenerate'):
        code = gen_landlord_code()
        execute("UPDATE landlord_profiles SET landlord_code=%s WHERE id=%s", (code, lp['id']))
        log_action('REGENERATE_JOIN_CODE', 'landlord_profiles', lp['id'])
    return ok({'code': code, 'join_url': f'{APP_URL}/join/{code}', 'login_url': APP_URL + '/',
               'business_name': lp.get('business_name') or ''})


@app.route('/api/landlord/dashboard', methods=['GET'])
@require_auth('landlord')
def landlord_dashboard():
    lp=get_landlord_profile(g.current_user['id'])
    # Separate subqueries, so no count is multiplied by another join
    summary=query("""SELECT
        (SELECT COUNT(*) FROM properties WHERE landlord_id=%s AND is_active=1) AS total_properties,
        (SELECT COUNT(*) FROM units un JOIN properties p ON p.id=un.property_id
            WHERE p.landlord_id=%s AND p.is_active=1) AS total_units,
        (SELECT COUNT(*) FROM units un JOIN properties p ON p.id=un.property_id
            WHERE p.landlord_id=%s AND p.is_active=1 AND un.status='occupied') AS occupied_units,
        (SELECT COUNT(*) FROM units un JOIN properties p ON p.id=un.property_id
            WHERE p.landlord_id=%s AND p.is_active=1 AND un.status='vacant') AS vacant_units,
        (SELECT COUNT(*) FROM tenant_landlords WHERE landlord_id=%s AND is_active=1) AS total_tenants,
        (SELECT COUNT(*) FROM payments py JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
            JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
            WHERE p.landlord_id=%s AND py.status='pending') AS pending_payments,
        (SELECT COALESCE(SUM(b.amount),0) FROM bills b JOIN contracts c ON c.id=b.contract_id
            JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
            WHERE p.landlord_id=%s AND b.status IN ('pending','overdue')) AS outstanding_amount
        """, (lp['id'],)*7, fetchone=True) or {}
    recent_payments=query("""SELECT py.id,py.amount_paid,py.status,py.paid_at,u.full_name AS tenant_name,b.description AS bill_desc
        FROM payments py JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
        JOIN tenant_profiles tp ON tp.id=c.tenant_id JOIN users u ON u.id=tp.user_id
        JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
        WHERE p.landlord_id=%s ORDER BY py.paid_at DESC LIMIT 5""",(lp['id'],))
    unread_threads=query("SELECT COUNT(*) AS cnt FROM message_threads WHERE landlord_id=%s AND is_read_landlord=0",
                         (g.current_user['id'],),fetchone=True)
    due_reminders=query("SELECT * FROM reminders WHERE landlord_id=%s AND day_of_month=%s AND is_active=1",
                        (lp['id'],datetime.now().day))
    ann=query("SELECT COUNT(*) AS cnt FROM announcements WHERE landlord_id=%s AND is_active=1", (lp['id'],), fetchone=True)
    return ok({'summary':summary,'recent_payments':recent_payments,'landlord_code':lp['landlord_code'],
               'due_reminders':due_reminders,
               'unread_threads':unread_threads['cnt'] if unread_threads else 0,
               'announcement_count': ann['cnt'] if ann else 0})

@app.route('/api/tenant/dashboard', methods=['GET'])
@require_auth('tenant')
def tenant_dashboard():
    """One card per landlord the tenant joined, each with only that landlord's contracts."""
    tp = get_tenant_profile(g.current_user['id'])
    if not tp:
        return err('Tenant profile not found. Please sign in again.', 404)
    landlords = query("""SELECT lp.id AS landlord_profile_id, lu.id AS landlord_user_id, lu.full_name AS landlord_name,
               lp.business_name, tl.joined_at
        FROM tenant_landlords tl JOIN landlord_profiles lp ON lp.id=tl.landlord_id
        JOIN users lu ON lu.id=lp.user_id
        WHERE tl.tenant_id=%s AND tl.is_active=1 ORDER BY tl.joined_at""", (tp['id'],))
    contracts = query("""SELECT c.id AS contract_id, c.status AS contract_status, c.monthly_rent, c.start_date,
               c.end_date, c.is_open_term, c.minimum_months, c.contract_doc_url, c.tenant_ack,
               un.unit_number, p.name AS property_name, p.address, p.landlord_id AS landlord_profile_id
        FROM contracts c JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
        WHERE c.tenant_id=%s AND c.status IN ('active','move_out_pending')
        ORDER BY c.start_date""", (tp['id'],))
    for l in landlords:
        l['contracts'] = [c for c in contracts if c['landlord_profile_id'] == l['landlord_profile_id']]
    bills = query(f"""SELECT b.*,py.id AS payment_id,py.status AS payment_status,
               un.unit_number, p.name AS property_name FROM bills b
        {LATEST_PAYMENT_JOIN}
        JOIN contracts c ON c.id=b.contract_id JOIN units un ON un.id=c.unit_id
        JOIN properties p ON p.id=un.property_id
        WHERE c.tenant_id=%s ORDER BY (b.status='paid'), b.due_date DESC LIMIT 10""", (tp['id'],))
    unread_msgs = query("SELECT COUNT(*) AS cnt FROM message_threads WHERE tenant_id=%s AND is_read_tenant=0",
                        (g.current_user['id'],), fetchone=True)
    unread_ann = query(f"""SELECT COUNT(*) AS cnt {TENANT_ANNOUNCEMENTS_FROM}
        AND NOT EXISTS (SELECT 1 FROM announcement_reads ar WHERE ar.announcement_id=a.id AND ar.tenant_user_id=%s)""",
        (tp['id'], tp['id'], g.current_user['id']), fetchone=True)
    return ok({
        'landlords': landlords,
        'bills': bills,
        'unread_messages': unread_msgs['cnt'] if unread_msgs else 0,
        'unread_announcements': unread_ann['cnt'] if unread_ann else 0,
    })


# ════════════════════════════════════════════════════════════
# ADMIN
# ════════════════════════════════════════════════════════════

@app.route('/api/admin/stats', methods=['GET'])
@require_auth('admin')
def admin_stats():
    return ok({
        'total_landlords':  query("SELECT COUNT(*) AS c FROM users WHERE role='landlord'",fetchone=True)['c'],
        'total_tenants':    query("SELECT COUNT(*) AS c FROM users WHERE role='tenant'",fetchone=True)['c'],
        'total_properties': query("SELECT COUNT(*) AS c FROM properties WHERE is_active=1",fetchone=True)['c'],
        'total_units':      query("SELECT COUNT(*) AS c FROM units",fetchone=True)['c'],
        'active_contracts': query("SELECT COUNT(*) AS c FROM contracts WHERE status='active'",fetchone=True)['c'],
        'pending_payments': query("SELECT COUNT(*) AS c FROM payments WHERE status='pending'",fetchone=True)['c'],
        'open_tickets':     query("SELECT COUNT(*) AS c FROM support_tickets WHERE status!='resolved'",fetchone=True)['c'],
    })

@app.route('/api/admin/landlords', methods=['GET'])
@require_auth('admin')
def admin_landlords():
    rows = query("""SELECT u.id,u.email,u.full_name,u.is_active,u.created_at,lp.landlord_code,lp.business_name,
        lp.trial_ends_at,lp.paid_until,lp.billing_exempt,
        COUNT(DISTINCT p.id) AS properties,COUNT(DISTINCT tl.tenant_id) AS tenants
        FROM users u JOIN landlord_profiles lp ON lp.user_id=u.id
        LEFT JOIN properties p ON p.landlord_id=lp.id LEFT JOIN tenant_landlords tl ON tl.landlord_id=lp.id
        WHERE u.role='landlord'
        GROUP BY u.id,lp.landlord_code,lp.business_name,lp.trial_ends_at,lp.paid_until,lp.billing_exempt
        ORDER BY u.created_at DESC""")
    for r in rows:
        r['plan'] = subscription_status(r)
    return ok(rows)

@app.route('/api/admin/landlords/<int:uid>/subscription', methods=['PATCH'])
@require_auth('admin')
def admin_set_subscription(uid):
    """After a landlord pays (GCash, bank...): set paid_until. Also: exempt them, or extend the trial."""
    lp = get_landlord_profile(uid)
    if not lp: return err('Landlord not found', 404)
    data = request.get_json() or {}
    if 'paid_until' in data:
        pu = data['paid_until'] or None
        if pu:
            try: pu = date.fromisoformat(pu)
            except (TypeError, ValueError): return err('Paid until must be a date like 2026-12-31')
        execute("UPDATE landlord_profiles SET paid_until=%s WHERE id=%s", (pu, lp['id']))
    if 'billing_exempt' in data:
        execute("UPDATE landlord_profiles SET billing_exempt=%s WHERE id=%s",
                (1 if data['billing_exempt'] else 0, lp['id']))
    if data.get('extend_trial_days'):
        try: days = int(data['extend_trial_days'])
        except (TypeError, ValueError): return err('Extra trial days must be a number')
        if not 0 < days <= 365: return err('Extra trial days must be 1 to 365')
        execute("""UPDATE landlord_profiles SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + INTERVAL %s DAY
                   WHERE id=%s""", (days, lp['id']))
    log_action('ADMIN_SET_SUBSCRIPTION', 'landlord_profiles', lp['id'], str(data))
    return ok(subscription_status(get_landlord_profile(uid)), msg='Plan updated')

@app.route('/api/admin/invites', methods=['GET'])
@require_auth('admin')
def admin_invites():
    return ok(query("""SELECT i.id,i.code,i.email,i.note,i.free_forever,i.used_at,i.revoked_at,i.created_at,
        u.full_name AS used_by_name, u.email AS used_by_email
        FROM invites i LEFT JOIN users u ON u.id=i.used_by ORDER BY i.created_at DESC"""))

@app.route('/api/admin/invites', methods=['POST'])
@require_auth('admin')
def admin_create_invite():
    data  = request.get_json() or {}
    email = (data.get('email') or '').strip().lower() or None
    if email and not re.match(r'^[^@]+@[^@]+\.[^@]+$', email): return err('Invalid email format')
    note  = (data.get('note') or '').strip()[:255] or None
    code  = gen_invite_code()
    link  = f'{APP_URL}/invite/{code}'
    iid, _ = execute("INSERT INTO invites (code,email,note,free_forever,created_by) VALUES (%s,%s,%s,%s,%s)",
                     (code, email, note, 1 if data.get('free_forever') else 0, g.current_user['id']))
    log_action('ADMIN_CREATE_INVITE', 'invites', iid, note)
    emailed = False
    if email and data.get('send_email'):
        emailed = send_email(email, "You're invited to Shiloh Living",
            f"""<h2>You're invited to Shiloh Living</h2>
            <p>Use this link to create your landlord account:</p>
            <p><a href="{link}" style="background:#2D6A4F;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">Create my account</a></p>
            <p>Or choose "Register as a Landlord" and enter the invite code <strong>{code}</strong>.</p>""")
    return ok({'id': iid, 'code': code, 'link': link, 'emailed': emailed}, status=201)

@app.route('/api/admin/invites/<int:iid>', methods=['DELETE'])
@require_auth('admin')
def admin_revoke_invite(iid):
    _, n = execute("UPDATE invites SET revoked_at=NOW() WHERE id=%s AND used_at IS NULL AND revoked_at IS NULL", (iid,))
    if not n: return err('That invite was already used or revoked', 409)
    log_action('ADMIN_REVOKE_INVITE', 'invites', iid)
    return ok(msg='Invite revoked')

@app.route('/api/admin/tenants', methods=['GET'])
@require_auth('admin')
def admin_tenants():
    return ok(query("""SELECT u.id,u.email,u.full_name,u.phone,u.is_active,u.created_at,
        GROUP_CONCAT(lu.full_name SEPARATOR ', ') AS landlord_names,
        COUNT(DISTINCT tl.landlord_id) AS landlord_count
        FROM users u JOIN tenant_profiles tp ON tp.user_id=u.id
        LEFT JOIN tenant_landlords tl ON tl.tenant_id=tp.id LEFT JOIN landlord_profiles lp ON lp.id=tl.landlord_id
        LEFT JOIN users lu ON lu.id=lp.user_id
        WHERE u.role='tenant' GROUP BY u.id ORDER BY u.created_at DESC"""))

@app.route('/api/admin/users/<int:uid>/suspend', methods=['PATCH'])
@require_auth('admin')
def suspend_user(uid):
    execute("UPDATE users SET is_active=0 WHERE id=%s AND role!='admin'",(uid,))
    return ok(msg='Suspended')

@app.route('/api/admin/users/<int:uid>/activate', methods=['PATCH'])
@require_auth('admin')
def activate_user(uid):
    execute("UPDATE users SET is_active=1 WHERE id=%s",(uid,))
    return ok(msg='Activated')

@app.route('/api/admin/audit-logs', methods=['GET'])
@require_auth('admin')
def audit_logs():
    return ok(query("""SELECT al.*,u.email FROM audit_logs al LEFT JOIN users u ON u.id=al.user_id
        ORDER BY al.created_at DESC LIMIT 200"""))


# ════════════════════════════════════════════════════════════
# EMAIL VERIFICATION
# ════════════════════════════════════════════════════════════

def send_verification_email(user_id, email, full_name):
    token = secrets.token_urlsafe(32)
    expires = datetime.utcnow() + timedelta(hours=24)
    execute("DELETE FROM email_verifications WHERE user_id=%s", (user_id,))
    execute("INSERT INTO email_verifications (user_id, token, new_email, expires_at) VALUES (%s,%s,%s,%s)",
            (user_id, token, email, expires))
    link = f"{APP_URL}/?type=verify&token={token}"
    send_email(email, "Verify your Shiloh Living email",
        f"""
        <h2>Welcome to Shiloh Living!</h2>
        <p>Hi {h(full_name)},</p>
        <p>Please verify your email address by clicking the link below:</p>
        <p><a href="{link}" style="background:#2D6A4F;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">
           Verify Email Address
        </a></p>
        <p>This link expires in 24 hours.</p>
        <p>If you didn't create an account, you can ignore this email.</p>
        """)
    return token

@app.route('/api/auth/verify-email', methods=['POST'])
def verify_email():
    data  = request.get_json() or {}
    token = (data.get('token') or '').strip()
    if not token:
        return err('Token required')
    row = query("SELECT * FROM email_verifications WHERE token=%s", (token,), fetchone=True)
    if not row:
        return err('Invalid or expired verification link', 400)
    if datetime.utcnow() > row['expires_at']:
        execute("DELETE FROM email_verifications WHERE token=%s", (token,))
        return err('Verification link has expired. Please request a new one.', 400)
    if query("SELECT id FROM users WHERE email=%s AND id!=%s", (row['new_email'], row['user_id']), fetchone=True):
        return err('That email address is already used by another account.', 409)
    execute("UPDATE users SET email_verified=1, email=%s WHERE id=%s",
            (row['new_email'], row['user_id']))
    execute("DELETE FROM email_verifications WHERE user_id=%s", (row['user_id'],))
    return ok(msg='Email verified successfully!')

@app.route('/api/auth/resend-verification', methods=['POST'])
@require_auth()
def resend_verification():
    u = g.current_user
    if u.get('email_verified'):
        return err('Email already verified')
    send_verification_email(u['id'], u['email'], u['full_name'])
    return ok(msg='Verification email sent')


@app.route('/api/auth/forgot-password', methods=['POST'])
def forgot_password():
    data  = request.get_json() or {}
    email = (data.get('email') or '').strip().lower()
    if not email:
        return err('Email is required')
    user = query("SELECT id, full_name, email FROM users WHERE email=%s AND is_active=1", (email,), fetchone=True)
    # Same answer whether or not the email is registered, so nobody can probe for accounts
    recent = user and query("SELECT 1 FROM password_resets WHERE user_id=%s AND created_at > NOW() - INTERVAL 2 MINUTE",
                            (user['id'],), fetchone=True)
    if user and not recent:
        token = secrets.token_urlsafe(32)
        expires = datetime.utcnow() + timedelta(hours=1)
        execute("DELETE FROM password_resets WHERE user_id=%s", (user['id'],))
        # Only a hash is stored, so a copy of the database can't be used to reset passwords
        execute("INSERT INTO password_resets (user_id, token, expires_at) VALUES (%s,%s,%s)",
                (user['id'], token_hash(token), expires))
        link = APP_URL + "/?type=reset&token=" + token
        body = (
            "<h2>Password Reset Request</h2>"
            "<p>Hi " + h(user['full_name']) + ",</p>"
            "<p>We received a request to reset your password. Click below to set a new one:</p>"
            '<p><a href="' + link + '" style="background:#2D6A4F;color:#fff;padding:12px 24px;'
            'border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">'
            "Reset Password</a></p>"
            "<p>This link expires in <strong>1 hour</strong>.</p>"
            "<p>If you didn't request this, you can safely ignore this email.</p>"
        )
        send_email(user['email'], "Reset your Shiloh Living password", body)
    return ok(msg='If that email is registered, a reset link has been sent.')


@app.route('/api/auth/reset-password', methods=['POST'])
def reset_password():
    data     = request.get_json() or {}
    token    = (data.get('token') or '').strip()
    password = data.get('password', '')
    if not token or not password:
        return err('Token and new password are required')
    pw_err = validate_password_strength(password)
    if pw_err:
        return err(pw_err)
    row = query("SELECT * FROM password_resets WHERE token=%s", (token_hash(token),), fetchone=True)
    if not row:
        return err('Invalid or expired reset link', 400)
    if datetime.utcnow() > row['expires_at']:
        execute("DELETE FROM password_resets WHERE id=%s", (row['id'],))
        return err('Reset link has expired. Please request a new one.', 400)
    set_password(row['user_id'], password)
    execute("DELETE FROM password_resets WHERE user_id=%s", (row['user_id'],))
    execute("DELETE FROM login_failures WHERE email=(SELECT email FROM users WHERE id=%s)", (row['user_id'],))
    return ok(msg='Password reset successfully! You can now sign in.')


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()

def set_password(user_id, new_password):
    """New password, and every existing sign-in of this account ends."""
    execute("UPDATE users SET password_hash=%s, session_version=session_version+1 WHERE id=%s",
            (hash_password(new_password), user_id))
    u = query("SELECT email, full_name FROM users WHERE id=%s", (user_id,), fetchone=True)
    if u:
        send_email(u['email'], 'Your Shiloh Living password was changed',
                   f'<p>Hi {h(u["full_name"])},</p><p>The password for your Shiloh Living account was just changed, '
                   f'and you were signed out on your other devices.</p>'
                   f'<p>If this wasn\'t you, reset your password right away from the sign-in page: '
                   f'<a href="{APP_URL}">{APP_URL}</a></p>')

def fresh_token():
    u = query("SELECT id, role, session_version FROM users WHERE id=%s", (g.current_user['id'],), fetchone=True)
    return make_token(u['id'], u['role'], u['session_version'])

@app.route('/api/auth/change-password', methods=['POST'])
@require_auth()
def change_password():
    """Signed-in password change. Other devices are signed out; this one gets a new sign-in."""
    data = request.get_json() or {}
    current, new = data.get('current_password', ''), data.get('new_password', '')
    if not check_password(current, g.current_user['password_hash']):
        return err('Your current password is incorrect')
    pw_err = validate_password_strength(new)
    if pw_err: return err(pw_err)
    if current == new: return err('Choose a password different from the current one')
    set_password(g.current_user['id'], new)
    log_action('CHANGE_PASSWORD', 'users', g.current_user['id'])
    return ok({'token': fresh_token()}, msg='Password changed. You were signed out on your other devices.')

@app.route('/api/auth/sign-out-others', methods=['POST'])
@require_auth()
def sign_out_others():
    execute("UPDATE users SET session_version=session_version+1 WHERE id=%s", (g.current_user['id'],))
    log_action('SIGN_OUT_OTHERS', 'users', g.current_user['id'])
    return ok({'token': fresh_token()}, msg='Signed out on all your other devices.')

@app.route('/api/auth/resend-verification-by-email', methods=['POST'])
def resend_verification_by_email():
    """Unauthenticated resend — for users who registered but haven't logged in yet."""
    data  = request.get_json() or {}
    email = (data.get('email') or '').strip().lower()
    if not email:
        return ok(msg='If that email is registered and unverified, a link has been sent.')
    user = query("SELECT * FROM users WHERE email=%s AND is_active=1", (email,), fetchone=True)
    # Always return ok to avoid email enumeration
    if user and not bool(user.get('email_verified', 1)):
        send_verification_email(user['id'], user['email'], user['full_name'])
    return ok(msg='If that email is registered and unverified, a link has been sent.')


@app.route('/api/auth/change-email', methods=['POST'])
@require_auth()
def change_email():
    u    = g.current_user
    data = request.get_json() or {}
    new_email = (data.get('email') or '').strip().lower()
    password  = data.get('password', '')
    if not new_email or not password:
        return err('New email and current password required')
    if not re.match(r'^[^@]+@[^@]+\.[^@]+$', new_email):
        return err('Invalid email format')
    if not check_password(password, u['password_hash']):
        return err('Incorrect password', 401)
    if query("SELECT id FROM users WHERE email=%s AND id!=%s", (new_email, u['id']), fetchone=True):
        return err('Email already in use', 409)
    send_verification_email(u['id'], new_email, u['full_name'])
    return ok(msg=f'Verification email sent to {new_email}. Please verify to complete the change.')


# ════════════════════════════════════════════════════════════
# LANDLORD QR CODE
# ════════════════════════════════════════════════════════════

@app.route('/api/landlord/qr-code')
@require_auth('landlord')
def landlord_qr_code():
    lp = get_landlord_profile(g.current_user['id'])
    code = lp['landlord_code']
    return ok({'register_url': f'{APP_URL}/join/{code}', 'landlord_code': code,
               'qr_url': f'/api/join/{code}/qr.png'})


# ════════════════════════════════════════════════════════════
# LIVE SUPPORT CHAT
# ════════════════════════════════════════════════════════════

@app.route('/api/support-chat', methods=['GET'])
@require_auth('landlord', 'tenant', 'admin')
def list_support_chats():
    u = g.current_user
    if u['role'] == 'admin':
        chats = query("""
            SELECT sc.*, u.full_name AS user_name, u.email AS user_email, u.role AS user_role,
                   (SELECT body FROM support_chat_messages WHERE chat_id=sc.id ORDER BY sent_at DESC LIMIT 1) AS last_message,
                   (SELECT COUNT(*) FROM support_chat_messages WHERE chat_id=sc.id AND is_read=0 AND sender_role!='admin') AS unread_count
            FROM support_chats sc JOIN users u ON u.id=sc.user_id
            WHERE sc.status!='archived'
            ORDER BY sc.last_message_at DESC
        """)
    else:
        chats = query("""
            SELECT sc.*,
                   (SELECT body FROM support_chat_messages WHERE chat_id=sc.id ORDER BY sent_at DESC LIMIT 1) AS last_message,
                   (SELECT COUNT(*) FROM support_chat_messages WHERE chat_id=sc.id AND is_read=0 AND sender_role='admin') AS unread_count
            FROM support_chats sc WHERE sc.user_id=%s
            ORDER BY sc.last_message_at DESC
        """, (u['id'],))
    return ok(chats)

@app.route('/api/support-chat', methods=['POST'])
@require_auth('landlord', 'tenant')
def start_support_chat():
    u    = g.current_user
    data = request.get_json() or {}
    subject = (data.get('subject') or '').strip()
    body    = (data.get('body') or '').strip()
    if not subject or not body:
        return err('Subject and message are required')
    existing = query("SELECT id FROM support_chats WHERE user_id=%s AND status='open'", (u['id'],), fetchone=True)
    if existing:
        cid = existing['id']
    else:
        cid, _ = execute(
            "INSERT INTO support_chats (user_id, subject, status, last_message_at) VALUES (%s,%s,'open',NOW())",
            (u['id'], subject)
        )
    execute("INSERT INTO support_chat_messages (chat_id,sender_id,sender_role,body) VALUES (%s,%s,%s,%s)",
            (cid, u['id'], u['role'], body))
    execute("UPDATE support_chats SET last_message_at=NOW(), subject=%s WHERE id=%s", (subject, cid))
    admins = query("SELECT id FROM users WHERE role='admin' AND is_active=1")
    for a in admins:
        push_notification(a['id'], f'Support message from {u["full_name"]}', body[:80], 'support')
    return ok({'chat_id': cid}, status=201)

@app.route('/api/support-chat/<int:cid>', methods=['GET'])
@require_auth('landlord', 'tenant', 'admin')
def get_support_chat(cid):
    u = g.current_user
    chat = query("SELECT sc.*, u.full_name AS user_name, u.email AS user_email FROM support_chats sc JOIN users u ON u.id=sc.user_id WHERE sc.id=%s", (cid,), fetchone=True)
    if not chat: return err('Chat not found', 404)
    if u['role'] != 'admin' and chat['user_id'] != u['id']:
        return err('Access denied', 403)
    messages = query("""
        SELECT scm.*, u.full_name AS sender_name
        FROM support_chat_messages scm JOIN users u ON u.id=scm.sender_id
        WHERE scm.chat_id=%s ORDER BY scm.sent_at ASC
    """, (cid,))
    if u['role'] == 'admin':
        execute("UPDATE support_chat_messages SET is_read=1 WHERE chat_id=%s AND sender_role!='admin'", (cid,))
    else:
        execute("UPDATE support_chat_messages SET is_read=1 WHERE chat_id=%s AND sender_role='admin'", (cid,))
    return ok({'chat': chat, 'messages': messages})

@app.route('/api/support-chat/<int:cid>/reply', methods=['POST'])
@require_auth('landlord', 'tenant', 'admin')
def reply_support_chat(cid):
    u    = g.current_user
    data = request.get_json() or {}
    body = (data.get('body') or '').strip()
    if not body: return err('Message required')
    chat = query("SELECT * FROM support_chats WHERE id=%s", (cid,), fetchone=True)
    if not chat: return err('Chat not found', 404)
    if u['role'] != 'admin' and chat['user_id'] != u['id']:
        return err('Access denied', 403)
    if chat['status'] != 'open':
        return err('This chat is closed. Please start a new one.', 409)
    execute("INSERT INTO support_chat_messages (chat_id,sender_id,sender_role,body) VALUES (%s,%s,%s,%s)",
            (cid, u['id'], u['role'], body))
    execute("UPDATE support_chats SET last_message_at=NOW() WHERE id=%s", (cid,))
    if u['role'] == 'admin':
        push_notification(chat['user_id'], 'Support replied to your message', body[:80], 'support')
        chat_user = query("SELECT email, full_name FROM users WHERE id=%s", (chat['user_id'],), fetchone=True)
        if chat_user:
            send_email_if_opted_in(chat['user_id'], 'email_ticket_reply', chat_user['email'],
                f'Support replied: {chat["subject"]}',
                f'<h2>Support Reply</h2><p style="white-space:pre-wrap">{h(body)}</p><p><a href="{APP_URL}">View conversation →</a></p>')
    else:
        admins = query("SELECT id FROM users WHERE role='admin'")
        for a in admins:
            push_notification(a['id'], f'Reply from {u["full_name"]}', body[:80], 'support')
    return ok(msg='Sent')

@app.route('/api/support-chat/<int:cid>/convert-ticket', methods=['POST'])
@require_auth('admin')
def convert_chat_to_ticket(cid):
    chat = query("SELECT sc.*, u.full_name AS user_name FROM support_chats sc JOIN users u ON u.id=sc.user_id WHERE sc.id=%s", (cid,), fetchone=True)
    if not chat: return err('Chat not found', 404)
    data = request.get_json() or {}
    priority = data.get('priority', 'normal')
    category = data.get('category', 'other')
    tid, _ = execute(
        "INSERT INTO support_tickets (opened_by,title,category,priority) VALUES (%s,%s,%s,%s)",
        (chat['user_id'], chat['subject'], category, priority)
    )
    msgs = query("SELECT * FROM support_chat_messages WHERE chat_id=%s ORDER BY sent_at ASC", (cid,))
    for msg in msgs:
        execute("INSERT INTO ticket_replies (ticket_id,sender_id,body,sent_at) VALUES (%s,%s,%s,%s)",
                (tid, msg['sender_id'], msg['body'], msg['sent_at']))
    execute("UPDATE support_chats SET status='converted', ticket_id=%s WHERE id=%s", (tid, cid))
    push_notification(chat['user_id'], 'Your chat was converted to a support ticket',
                      f'Ticket #{tid} created for: {chat["subject"]}', 'support')
    return ok({'ticket_id': tid}, msg='Converted to ticket')

@app.route('/api/support-chat/<int:cid>/close', methods=['PATCH'])
@require_auth('admin')
def close_support_chat(cid):
    execute("UPDATE support_chats SET status='closed' WHERE id=%s", (cid,))
    return ok(msg='Chat closed')


# ════════════════════════════════════════════════════════════
# ADMIN — USER DETAIL MANAGEMENT
# ════════════════════════════════════════════════════════════

@app.route('/api/admin/users/<int:uid>', methods=['GET'])
@require_auth('admin')
def admin_get_user(uid):
    user = query("SELECT id,email,full_name,phone,role,is_active,email_verified,created_at,last_login_at FROM users WHERE id=%s", (uid,), fetchone=True)
    if not user: return err('User not found', 404)
    if user['role'] == 'landlord':
        profile = query("SELECT * FROM landlord_profiles WHERE user_id=%s", (uid,), fetchone=True)
    else:
        profile = query("SELECT * FROM tenant_profiles WHERE user_id=%s", (uid,), fetchone=True)
    return ok({'user': user, 'profile': profile})

@app.route('/api/admin/users/<int:uid>', methods=['PATCH'])
@require_auth('admin')
def admin_update_user(uid):
    data = request.get_json() or {}
    allowed = ['full_name','email','phone','is_active','email_verified']
    fields = {k:v for k,v in data.items() if k in allowed}
    if not fields: return err('No valid fields')
    if 'email' in fields:
        existing = query("SELECT id FROM users WHERE email=%s AND id!=%s", (fields['email'], uid), fetchone=True)
        if existing: return err('Email already in use', 409)
    set_clause = ', '.join(f"{k}=%s" for k in fields)
    execute(f"UPDATE users SET {set_clause} WHERE id=%s", (*fields.values(), uid))
    log_action('ADMIN_UPDATE_USER', 'users', uid, str(fields))
    return ok(msg='User updated')

@app.route('/api/admin/users/<int:uid>/reset-password', methods=['POST'])
@require_auth('admin')
def admin_reset_password(uid):
    data = request.get_json() or {}
    new_password = data.get('password', '')
    pw_err = validate_password_strength(new_password)
    if pw_err: return err(pw_err)
    set_password(uid, new_password)
    log_action('ADMIN_RESET_PASSWORD', 'users', uid)
    return ok(msg='Password reset')


@app.route('/sw.js')
def service_worker():
    # Served from the root so it controls the whole app (needed for install + push)
    resp = send_from_directory(os.path.join(BASE_DIR, 'static'), 'sw.js', mimetype='application/javascript')
    resp.headers['Cache-Control'] = 'no-cache'
    resp.headers['Service-Worker-Allowed'] = '/'
    return resp

@app.route('/manifest.webmanifest')
def web_manifest():
    resp = send_from_directory(os.path.join(BASE_DIR, 'static'), 'manifest.json',
                               mimetype='application/manifest+json')
    resp.headers['Cache-Control'] = 'no-cache'
    return resp


@app.after_request
def security_headers(resp):
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    resp.headers.setdefault('X-Frame-Options', 'DENY')
    resp.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    if request.path.startswith('/api/') and request.path != '/api/push/key' and '/qr.png' not in request.path:
        resp.headers.setdefault('Cache-Control', 'no-store')
    return resp


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)