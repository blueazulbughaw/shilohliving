print("APP RELOADED")
"""
Shiloh Living — Rental Management Platform v4
New: contract uploads (Cloudinary), contract terms, announcements,
     email notification preferences, Cloudinary proof-of-payment,
     JWT token bug fix
"""
import os, re, secrets, string, smtplib, base64, io, uuid
from datetime import datetime, timedelta, date
from functools import wraps
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

try:
    import qrcode
    from qrcode.image.svg import SvgPathImage
    QR_AVAILABLE = True
except ImportError:
    QR_AVAILABLE = False

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

from flask import Flask, request, jsonify, send_from_directory, g
import decimal, json as _json

class SafeJSONEncoder(_json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, decimal.Decimal):
            return float(obj)
        if isinstance(obj, (datetime, date)):
            return obj.isoformat()
        if isinstance(obj, bytes):
            return obj.decode('utf-8', errors='replace')
        return super().default(obj)

from flask_cors import CORS
import mysql.connector
from mysql.connector import pooling
import bcrypt

try:
    import jwt as pyjwt
except ImportError:
    import PyJWT as pyjwt

app = Flask(__name__, template_folder=os.path.join(os.path.dirname(__file__), 'templates'))
app.json_encoder = SafeJSONEncoder
CORS(app, resources={r"/api/*": {"origins": "*"}})

# ── Global error handlers — always return JSON, never HTML ────
@app.errorhandler(404)
def not_found(e):
    if request.path.startswith('/api/'):
        return jsonify({'status':'error','message':'API endpoint not found'}), 404
    return send_from_directory(os.path.join(os.path.dirname(__file__), 'templates'), 'index.html')

@app.errorhandler(405)
def method_not_allowed(e):
    return jsonify({'status':'error','message':'Method not allowed'}), 405

@app.errorhandler(500)
def server_error(e):
    import traceback
    tb = traceback.format_exc()
    return jsonify({'status': 'error', 'message': str(e), 'traceback': tb}), 500

SECRET_KEY    = os.environ.get('SECRET_KEY', 'change-me-in-production')
JWT_EXPIRES   = int(os.environ.get('JWT_EXPIRES_HOURS', 24))
SMTP_HOST     = os.environ.get('SMTP_HOST', 'mail.shilohliving.app')
SMTP_PORT     = int(os.environ.get('SMTP_PORT', 465))
SMTP_USER     = os.environ.get('SMTP_USER', 'noreply@shilohliving.app')
SMTP_PASSWORD = os.environ.get('SMTP_PASSWORD', '')
SUPPORT_EMAIL = os.environ.get('SUPPORT_EMAIL', 'support@shilohliving.app')

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
    pool = pooling.MySQLConnectionPool(pool_name='shiloh_pool', pool_size=5, **db_config)
except Exception as e:
    print(f"[ERROR] DB pool failed: {e}")
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
    except Exception as e:
        raise Exception(f"SQL ERROR → {sql} | PARAMS → {params} | ERROR → {str(e)}")
    finally:
        conn.close()

def ok(data=None, msg=None, status=200):
    resp = {'status': 'ok'}
    if msg: resp['message'] = msg
    if data is not None: resp['data'] = data
    return jsonify(resp), status

def err(msg, status=400):
    return jsonify({'status': 'error', 'message': msg}), status


# ── Email ─────────────────────────────────────────────────────
def send_email(to_email, subject, html_body):
    if not SMTP_PASSWORD:
        print(f"[EMAIL SKIP] No SMTP password set. Would send to {to_email}: {subject}")
        return
    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From']    = f'Shiloh Living <{SMTP_USER}>'
        msg['To']      = to_email
        msg.attach(MIMEText(html_body, 'html'))
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(SMTP_USER, to_email, msg.as_string())
        print(f"[EMAIL OK] Sent to {to_email}: {subject}")
    except Exception as e:
        print(f"[EMAIL ERR] {e}")

def get_notif_pref(user_id, pref_key):
    pref = query("SELECT * FROM notification_preferences WHERE user_id=%s", (user_id,), fetchone=True)
    if not pref:
        return True
    return bool(pref.get(pref_key, 1))

def send_email_if_opted_in(user_id, pref_key, to_email, subject, html_body):
    if get_notif_pref(user_id, pref_key):
        send_email(to_email, subject, html_body)

def email_new_ticket(ticket_id, title, opener_name, opener_email, category):
    send_email(
        SUPPORT_EMAIL,
        f'[New Ticket #{ticket_id}] {title}',
        f"""
        <h2>New Support Ticket</h2>
        <p><strong>Ticket #:</strong> {ticket_id}</p>
        <p><strong>From:</strong> {opener_name} ({opener_email})</p>
        <p><strong>Category:</strong> {category}</p>
        <p><strong>Title:</strong> {title}</p>
        <p><a href="https://shilohliving.app">View in Admin Dashboard →</a></p>
        """
    )

def email_ticket_reply(to_email, to_name, ticket_id, title, reply_body, from_name):
    send_email(
        to_email,
        f'[Ticket #{ticket_id}] New reply: {title}',
        f"""
        <h2>New Reply on Your Support Ticket</h2>
        <p><strong>Ticket:</strong> {title}</p>
        <p><strong>From:</strong> {from_name}</p>
        <hr/>
        <p>{reply_body}</p>
        <hr/>
        <p><a href="https://shilohliving.app">View full conversation →</a></p>
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

def make_token(user_id, role):
    payload = {
        'sub': str(user_id),
        'role': role,
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

def gen_landlord_code():
    chars = string.ascii_uppercase + string.digits
    for _ in range(50):
        code = 'L' + ''.join(secrets.choice(chars) for _ in range(7))
        if not query("SELECT id FROM landlord_profiles WHERE landlord_code=%s", (code,), fetchone=True):
            return code
    raise Exception("Could not generate landlord code")

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
            except Exception as e:
                print(f"[JWT ERR] {e} | token='{raw_token[:30]}...'")
                return err('Invalid token', 401)
            if roles and payload.get('role') not in roles:
                return err('Access denied', 403)
            user = query("SELECT * FROM users WHERE id=%s AND is_active=1", (payload['sub'],), fetchone=True)
            if not user:
                return err('User not found', 401)
            g.current_user = user
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

def push_notification(user_id, title, body, notif_type='system'):
    # Map unknown types to 'system' to avoid ENUM errors
    valid_types = {'bill', 'payment', 'message', 'reminder', 'system', 'announcement', 'contract', 'support'}
    if notif_type not in valid_types:
        notif_type = 'system'
    try:
        execute("INSERT INTO notifications (user_id,title,body,type) VALUES (%s,%s,%s,%s)",
                (user_id, title, body, notif_type))
    except Exception as e:
        # Fallback: insert with 'system' type if ENUM rejects the value
        try:
            execute("INSERT INTO notifications (user_id,title,body,type) VALUES (%s,%s,%s,'system')",
                    (user_id, title, body))
        except: pass


# ── Frontend ──────────────────────────────────────────────────
@app.route('/')
def index_page():
    return send_from_directory(os.path.join(os.path.dirname(__file__), 'templates'), 'index.html')

@app.route('/<path:path>')
def frontend(path=''):
    if path.startswith('api/'):
        return err(f'Not found', 404)
    return send_from_directory(os.path.join(os.path.dirname(__file__), 'templates'), 'index.html')

@app.route('/api/health')
def health():
    try:
        query("SELECT 1", fetchone=True)
        return ok({'db': 'connected', 'server': 'Shiloh Living API v4'})
    except Exception as e:
        return err(f'DB error: {str(e)}', 500)


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

    landlord_profile = None
    if role == 'tenant' and lcode:
        landlord_profile = query("SELECT * FROM landlord_profiles WHERE landlord_code=%s", (lcode,), fetchone=True)
        if not landlord_profile: return err('Invalid landlord code — check with your landlord', 404)

    uid, _ = execute(
        "INSERT INTO users (email,password_hash,full_name,phone,role,email_verified) VALUES (%s,%s,%s,%s,%s,0)",
        (email, hash_password(password), full_name, phone, role)
    )

    if role == 'landlord':
        code = gen_landlord_code()
        execute("INSERT INTO landlord_profiles (user_id,landlord_code,business_name) VALUES (%s,%s,%s)",
                (uid, code, biz_name))
    elif role == 'tenant':
        tp_id, _ = execute("INSERT INTO tenant_profiles (user_id) VALUES (%s)", (uid,))
        if landlord_profile:
            execute("INSERT INTO tenant_landlords (tenant_id,landlord_id) VALUES (%s,%s)",
                    (tp_id, landlord_profile['id']))
            lp_user = query("SELECT id FROM users WHERE id=%s", (landlord_profile['user_id'],), fetchone=True)
            if lp_user:
                push_notification(lp_user['id'], 'New Tenant Registered',
                                  f'{full_name} joined using your landlord code.', 'system')

    send_verification_email(uid, email, full_name)
    token = make_token(uid, role)
    user  = query("SELECT id,email,full_name,role FROM users WHERE id=%s", (uid,), fetchone=True)
    return ok({'token': token, 'user': user, 'email_verification_sent': True}, status=201)


@app.route('/api/auth/join-landlord', methods=['POST'])
@require_auth('tenant')
def join_landlord():
    data  = request.get_json() or {}
    lcode = (data.get('landlord_code') or '').strip().upper()
    if not lcode: return err('Landlord code is required')

    lp = query("SELECT * FROM landlord_profiles WHERE landlord_code=%s", (lcode,), fetchone=True)
    if not lp: return err('Invalid landlord code', 404)

    tp = get_tenant_profile(g.current_user['id'])
    if not tp: return err('Tenant profile not found', 404)

    existing = query("SELECT id FROM tenant_landlords WHERE tenant_id=%s AND landlord_id=%s",
                     (tp['id'], lp['id']), fetchone=True)
    if existing: return err('You have already joined this landlord', 409)

    execute("INSERT INTO tenant_landlords (tenant_id,landlord_id) VALUES (%s,%s)", (tp['id'], lp['id']))
    landlord_name = query("SELECT full_name FROM users WHERE id=%s", (lp['user_id'],), fetchone=True)
    push_notification(lp['user_id'], 'New Tenant Joined',
                      f'{g.current_user["full_name"]} joined using your landlord code.', 'system')
    ll_user = query("SELECT email, full_name FROM users WHERE id=%s", (lp['user_id'],), fetchone=True)
    if ll_user:
        send_email_if_opted_in(lp['user_id'], 'email_new_tenant_joined', ll_user['email'],
            f'New Tenant Joined: {g.current_user["full_name"]}',
            f'<h2>New Tenant Joined</h2><p>{g.current_user["full_name"]} has joined using your landlord code.</p><p><a href="https://shilohliving.app">View in dashboard</a></p>')
    return ok({'message': f'Successfully joined {landlord_name["full_name"] if landlord_name else "landlord"}'})


@app.route('/api/auth/login', methods=['POST'])
def login():
    data     = request.get_json() or {}
    email    = (data.get('email') or '').strip().lower()
    password = data.get('password', '')
    if not email or not password: return err('Email and password required')
    user = query("SELECT * FROM users WHERE email=%s", (email,), fetchone=True)
    if not user or not check_password(password, user['password_hash']):
        return err('Invalid email or password', 401)
    if not user['is_active']: return err('Account suspended', 403)
    if not bool(user.get('email_verified', 0)):
        return err('Please verify your email before logging in. Check your inbox for the verification link.', 403)
    execute("UPDATE users SET last_login_at=NOW() WHERE id=%s", (user['id'],))
    token = make_token(user['id'], user['role'])
    return ok({'token': token, 'user': {'id': user['id'], 'email': user['email'],
               'full_name': user['full_name'], 'role': user['role'],
               'email_verified': True}})

@app.route('/api/auth/me')
@require_auth()
def me():
    u = g.current_user
    profile = None
    if u['role'] == 'landlord':
        profile = query("SELECT landlord_code,business_name FROM landlord_profiles WHERE user_id=%s",
                        (u['id'],), fetchone=True)
    elif u['role'] == 'tenant':
        tp = get_tenant_profile(u['id'])
        if tp:
            landlords = query("""
                SELECT lp.landlord_code, lu.full_name AS landlord_name, lu.email AS landlord_email
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
        announcements = query("""
            SELECT DISTINCT a.*, u.full_name AS landlord_name,
                   (SELECT read_at FROM announcement_reads
                    WHERE announcement_id=a.id AND tenant_user_id=%s LIMIT 1) AS read_at
            FROM announcements a
            JOIN landlord_profiles lp ON lp.id = a.landlord_id
            JOIN users u ON u.id = lp.user_id
            JOIN tenant_landlords tl ON tl.landlord_id = lp.id
            LEFT JOIN announcement_properties ap ON ap.announcement_id = a.id
            LEFT JOIN contracts c ON c.tenant_id = tl.tenant_id
            LEFT JOIN units un ON un.id = c.unit_id
            WHERE tl.tenant_id = %s AND tl.is_active = 1
              AND a.is_active = 1
              AND (a.target_all = 1 OR ap.property_id = un.property_id)
              AND (a.expires_at IS NULL OR a.expires_at >= CURDATE())
            ORDER BY a.created_at DESC
        """, (u['id'], tp['id']))
    return ok(announcements)


@app.route('/api/announcements', methods=['POST'])
@require_auth('landlord')
def create_announcement():
    lp   = get_landlord_profile(g.current_user['id'])
    data = request.get_json() or {}
    subject    = (data.get('subject') or '').strip()
    body       = (data.get('body') or '').strip()
    target_all = 1 if data.get('target_all') else 0
    property_ids = data.get('property_ids', [])
    expires_at = data.get('expires_at')

    if not subject or not body:
        return err('Subject and body are required')
    if not target_all and not property_ids:
        return err('Select at least one property or choose "All Properties"')

    ann_id, _ = execute(
        "INSERT INTO announcements (landlord_id, subject, body, target_all, expires_at) VALUES (%s,%s,%s,%s,%s)",
        (lp['id'], subject, body, target_all, expires_at or None)
    )

    if not target_all and property_ids:
        for pid in property_ids:
            p = query("SELECT id FROM properties WHERE id=%s AND landlord_id=%s AND is_active=1",
                      (pid, lp['id']), fetchone=True)
            if p:
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
        tenants = query("""
            SELECT DISTINCT u.id AS user_id, u.email, u.full_name
            FROM tenant_landlords tl
            JOIN tenant_profiles tp ON tp.id = tl.tenant_id
            JOIN users u ON u.id = tp.user_id
            JOIN contracts c ON c.tenant_id = tp.id AND c.status = 'active'
            JOIN units un ON un.id = c.unit_id
            WHERE tl.landlord_id = %s AND tl.is_active = 1
              AND un.property_id IN ({})
        """.format(','.join(['%s'] * len(property_ids))),
            (lp['id'], *property_ids))

    landlord_name = g.current_user['full_name']
    for t in tenants:
        push_notification(t['user_id'], f'Announcement: {subject}', body[:80], 'announcement')
        send_email_if_opted_in(
            t['user_id'], 'email_new_announcement',
            t['email'],
            f'Announcement from {landlord_name}: {subject}',
            f"""
            <h2>New Announcement</h2>
            <p><strong>From:</strong> {landlord_name}</p>
            <p><strong>Subject:</strong> {subject}</p>
            <hr/>
            <p>{body}</p>
            <hr/>
            <p><a href="https://shilohliving.app">View in your dashboard →</a></p>
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
        print(f"[THREADS ERR] {e}")
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

    if u['role'] == 'tenant':
        tp = get_tenant_profile(u['id'])
        if contract_id:
            c = query("""SELECT lu.id AS landlord_user_id FROM contracts c
                         JOIN tenant_profiles tp2 ON tp2.id=c.tenant_id
                         JOIN tenant_landlords tl ON tl.tenant_id=tp2.id
                         JOIN landlord_profiles lp ON lp.id=tl.landlord_id
                         JOIN users lu ON lu.id=lp.user_id
                         WHERE c.id=%s AND c.tenant_id=%s""", (contract_id, tp['id']), fetchone=True)
            if not c: return err('Contract not found', 404)
            landlord_user_id = c['landlord_user_id']
        else:
            landlord_user_id = data.get('landlord_user_id')
            if not landlord_user_id: return err('landlord_user_id or contract_id required')

        tid, _ = execute(
            "INSERT INTO message_threads (subject,started_by,landlord_id,tenant_id,contract_id,is_read_landlord) VALUES (%s,%s,%s,%s,%s,0)",
            (subject, u['id'], landlord_user_id, u['id'], contract_id)
        )
        push_notification(landlord_user_id, f'New message: {subject}', body[:80], 'message')

    elif u['role'] == 'landlord':
        tenant_user_id = data.get('tenant_user_id')
        if not tenant_user_id: return err('tenant_user_id is required')
        tid, _ = execute(
            "INSERT INTO message_threads (subject,started_by,landlord_id,tenant_id,contract_id,is_read_tenant) VALUES (%s,%s,%s,%s,%s,0)",
            (subject, u['id'], u['id'], tenant_user_id, contract_id)
        )
        push_notification(tenant_user_id, f'New message from landlord: {subject}', body[:80], 'message')

    execute("INSERT INTO message_replies (thread_id,sender_id,body) VALUES (%s,%s,%s)",
            (tid, u['id'], body))
    return ok({'thread_id': tid}, status=201)


@app.route('/api/threads/<int:tid>', methods=['GET'])
@require_auth('landlord', 'tenant')
def get_thread(tid):
    u = g.current_user
    thread = query("SELECT * FROM message_threads WHERE id=%s", (tid,), fetchone=True)
    if not thread: return err('Thread not found', 404)
    if u['id'] not in (thread['landlord_id'], thread['tenant_id']):
        return err('Access denied', 403)
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

    execute("INSERT INTO message_replies (thread_id,sender_id,body) VALUES (%s,%s,%s)",
            (tid, u['id'], body))

    other_id = thread['tenant_id'] if u['id'] == thread['landlord_id'] else thread['landlord_id']
    push_notification(other_id, f'New reply: {thread["subject"]}', body[:80], 'message')

    other_user = query("SELECT email, full_name, role FROM users WHERE id=%s", (other_id,), fetchone=True)
    if other_user:
        pref_key = 'email_tenant_message' if other_user.get('role') == 'landlord' else 'email_new_message'
        send_email_if_opted_in(
            other_id, pref_key,
            other_user['email'],
            f'New reply: {thread["subject"]}',
            f"""
            <h2>New Message</h2>
            <p><strong>From:</strong> {u['full_name']}</p>
            <p><strong>Subject:</strong> {thread['subject']}</p>
            <hr/><p>{body}</p><hr/>
            <p><a href="https://shilohliving.app">View conversation →</a></p>
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

    tid, _ = execute(
        "INSERT INTO support_tickets (opened_by,title,category,priority) VALUES (%s,%s,%s,%s)",
        (u['id'], title, category, priority)
    )
    execute("INSERT INTO ticket_replies (ticket_id,sender_id,body) VALUES (%s,%s,%s)",
            (tid, u['id'], body))
    email_new_ticket(tid, title, u['full_name'], u['email'], category)
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
            # FIX: correct call signature for send_email_if_opted_in
            send_email_if_opted_in(
                ticket['opened_by'], 'email_ticket_reply',
                opener['email'],
                f'[Ticket #{tid}] New reply: {ticket["title"]}',
                f"""
                <h2>New Reply on Your Support Ticket</h2>
                <p><strong>Ticket:</strong> {ticket['title']}</p>
                <p><strong>From:</strong> Support Team</p>
                <hr/>
                <p>{body}</p>
                <hr/>
                <p><a href="https://shilohliving.app">View full conversation →</a></p>
                """
            )
        push_notification(ticket['opened_by'], 'Support replied to your ticket',
                          f'Ticket: {ticket["title"]}', 'system')
    else:
        send_email(SUPPORT_EMAIL,
                   f'[Ticket #{tid} Reply] {ticket["title"]}',
                   f'<p><strong>{u["full_name"]}</strong> replied:</p><p>{body}</p>')

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
                       f'<p>Hi {opener["full_name"]},</p><p>Your support ticket <strong>"{ticket["title"]}"</strong> has been marked as resolved.</p><p>If you need further help, please open a new ticket.</p>')
        push_notification(ticket['opened_by'], 'Support ticket resolved',
                          f'Your ticket "{ticket["title"]}" has been resolved.', 'system')
    log_action('RESOLVE_TICKET', 'support_tickets', tid)
    return ok(msg='Ticket resolved')


# ════════════════════════════════════════════════════════════
# PROPERTIES
# ════════════════════════════════════════════════════════════

@app.route('/api/properties', methods=['GET'])
@require_auth('landlord')
def list_properties():
    lp = get_landlord_profile(g.current_user['id'])
    props = query("""SELECT p.*,COUNT(u.id) AS unit_count,SUM(u.status='occupied') AS occupied,SUM(u.status='vacant') AS vacant
        FROM properties p LEFT JOIN units u ON u.property_id=p.id
        WHERE p.landlord_id=%s AND p.is_active=1 GROUP BY p.id ORDER BY p.created_at DESC""", (lp['id'],))
    return ok(props)

@app.route('/api/properties', methods=['POST'])
@require_auth('landlord')
def create_property():
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    name=(data.get('name') or '').strip(); address=(data.get('address') or '').strip()
    if not name or not address: return err('Name and address required')
    pid,_=execute("INSERT INTO properties (landlord_id,name,address,city,country) VALUES (%s,%s,%s,%s,%s)",
                  (lp['id'],name,address,data.get('city',''),data.get('country','')))
    return ok({'id':pid,'name':name},status=201)

@app.route('/api/properties/<int:pid>', methods=['PATCH'])
@require_auth('landlord')
def update_property(pid):
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    p=query("SELECT id FROM properties WHERE id=%s AND landlord_id=%s",(pid,lp['id']),fetchone=True)
    if not p: return err('Not found',404)
    fields={k:v for k,v in data.items() if k in ('name','address','city','country')}
    if not fields: return err('No fields')
    set_clause=', '.join(f"{k}=%s" for k in fields)
    execute(f"UPDATE properties SET {set_clause} WHERE id=%s",(*fields.values(),pid))
    return ok(msg='Updated')

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
            WHERE p.landlord_id=%s ORDER BY p.name,u.unit_number""",(lp['id'],))
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
                   un.unit_number,p.name AS property_name
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

    p = query("SELECT pr.landlord_id FROM units u JOIN properties pr ON pr.id=u.property_id WHERE u.id=%s", (unit_id,), fetchone=True)
    if not p or p['landlord_id'] != lp['id']: return err('Unit not found or not yours', 403)
    tp_check = query("SELECT tp.id FROM tenant_profiles tp JOIN tenant_landlords tl ON tl.tenant_id=tp.id WHERE tp.id=%s AND tl.landlord_id=%s",
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
        if 'already has an active contract' in str(e): return err(str(e), 409)
        return err(f'Could not create: {str(e)}', 500)

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
            '<p>Hi ' + tenant_user['full_name'] + ',</p>'
            '<p>Your landlord has uploaded your signed rental contract.</p>'
            '<p>Please log in to your dashboard to view and acknowledge it.</p>'
            '<p><a href="https://shilohliving.app">Go to Dashboard →</a></p>'
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
            f'<h2>Contract Acknowledged</h2><p>{g.current_user["full_name"]} acknowledged the contract for Unit {ci["unit_number"]}.</p><p><a href="https://shilohliving.app">View in dashboard</a></p>'
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
    if fields:
        set_cl = ', '.join(f"{k}=%s" for k in fields)
        execute(f"UPDATE move_out_checklists SET {set_cl}, updated_at=NOW() WHERE contract_id=%s",
                (*fields.values(), cid))

    if data.get('deposit_status') == 'ready':
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
                          'Your move-out has been completed and the unit has been released.', 'contract')
    log_action('COMPLETE_MOVE_OUT', 'contracts', cid)
    return ok(msg='Move-out complete. Unit is now vacant.')

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

@app.route('/api/bills', methods=['GET'])
@require_auth('landlord','tenant')
def list_bills():
    u=g.current_user; contract_id=request.args.get('contract_id')
    if u['role']=='landlord':
        lp=get_landlord_profile(u['id'])
        if contract_id:
            bills=query("""SELECT b.*,py.id AS payment_id,py.status AS payment_status,py.amount_paid FROM bills b
                LEFT JOIN payments py ON py.bill_id=b.id JOIN contracts c ON c.id=b.contract_id
                JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
                WHERE b.contract_id=%s AND p.landlord_id=%s ORDER BY b.due_date DESC""",(contract_id,lp['id']))
        else:
            bills=query("""SELECT b.*,u.full_name AS tenant_name,un.unit_number,p.name AS property_name FROM bills b
                JOIN contracts c ON c.id=b.contract_id JOIN tenant_profiles tp ON tp.id=c.tenant_id
                JOIN users u ON u.id=tp.user_id JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
                WHERE p.landlord_id=%s ORDER BY b.due_date DESC LIMIT 100""",(lp['id'],))
    else:
        tp=get_tenant_profile(u['id'])
        bills=query("""SELECT b.*,py.id AS payment_id,py.status AS payment_status,py.amount_paid FROM bills b
            LEFT JOIN payments py ON py.bill_id=b.id AND py.status!='rejected'
            JOIN contracts c ON c.id=b.contract_id WHERE c.tenant_id=%s ORDER BY b.due_date DESC""",(tp['id'],))
    return ok(bills)

@app.route('/api/bills', methods=['POST'])
@require_auth('landlord')
def create_bill():
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    contract_id=data.get('contract_id'); description=(data.get('description') or '').strip()
    amount=data.get('amount'); due_date=data.get('due_date')
    bill_type=data.get('bill_type','rent'); bill_month=data.get('bill_month'); bill_year=data.get('bill_year')
    if not all([contract_id,description,amount,due_date]): return err('All fields required')
    c=query("""SELECT c.id, c.tenant_id FROM contracts c JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
               WHERE c.id=%s AND p.landlord_id=%s""",(contract_id,lp['id']),fetchone=True)
    if not c: return err('Contract not found',404)
    bid,_=execute("INSERT INTO bills (contract_id,description,bill_type,bill_month,bill_year,amount,due_date) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                  (contract_id,description,bill_type,bill_month,bill_year,amount,due_date))

    tenant_user = query(
        "SELECT u.id, u.email, u.full_name FROM users u JOIN tenant_profiles tp ON tp.user_id=u.id WHERE tp.id=%s",
        (c['tenant_id'],), fetchone=True
    )
    if tenant_user:
        push_notification(tenant_user['id'], f'New Bill: {description}',
                          f'Amount due: {amount} by {due_date}', 'bill')
        send_email_if_opted_in(
            tenant_user['id'], 'email_new_bill',
            tenant_user['email'],
            f'New Bill: {description}',
            f"""
            <h2>New Bill</h2>
            <p>Hi {tenant_user['full_name']},</p>
            <p><strong>Description:</strong> {description}</p>
            <p><strong>Amount:</strong> {amount}</p>
            <p><strong>Due Date:</strong> {due_date}</p>
            <p><a href="https://shilohliving.app">View and Pay →</a></p>
            """
        )

    return ok({'bill_id':bid},status=201)

@app.route('/api/bills/generate-monthly', methods=['POST'])
@require_auth('landlord','admin')
def generate_monthly_bills():
    conn=get_conn()
    try:
        cur=conn.cursor()
        cur.callproc('sp_generate_monthly_bills')
        result=[]
        for r in cur.stored_results(): result=r.fetchall()
        conn.commit()
        count=result[0][0] if result else 0
        return ok({'bills_generated':count})
    finally: conn.close()


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

    if not bill_id or not amount_paid: return err('bill_id and amount_paid required')
    if not proof_url: return err('Proof of payment is required')
    if proof_url and not proof_url.startswith('https://res.cloudinary.com'):
        return err('Invalid proof URL. Please upload via the file picker.')
    b=query("""SELECT b.id, c.tenant_id,
                      (SELECT lp.user_id FROM units u JOIN properties p ON p.id=u.property_id
                       JOIN landlord_profiles lp ON lp.id=p.landlord_id WHERE u.id=c.unit_id) AS landlord_user_id
               FROM bills b JOIN contracts c ON c.id=b.contract_id
               WHERE b.id=%s AND c.tenant_id=%s""",(bill_id,tp['id']),fetchone=True)
    if not b: return err('Bill not found',404)

    try:
        pid,_=execute(
            "INSERT INTO payments (bill_id,amount_paid,proof_url,proof_public_id) VALUES (%s,%s,%s,%s)",
            (bill_id, amount_paid, proof_url, proof_public_id)
        )
    except Exception as ep:
        ep_str = str(ep)
        if 'proof_public_id' in ep_str:
            try:
                pid,_=execute(
                    "INSERT INTO payments (bill_id,amount_paid,proof_url) VALUES (%s,%s,%s)",
                    (bill_id, amount_paid, proof_url)
                )
            except Exception as ep2:
                if 'proof_url' in str(ep2):
                    pid,_=execute(
                        "INSERT INTO payments (bill_id,amount_paid) VALUES (%s,%s)",
                        (bill_id, amount_paid)
                    )
                else:
                    raise
        elif 'proof_url' in ep_str:
            pid,_=execute(
                "INSERT INTO payments (bill_id,amount_paid) VALUES (%s,%s)",
                (bill_id, amount_paid)
            )
        else:
            raise

    if b.get('landlord_user_id'):
        push_notification(b['landlord_user_id'], 'New Payment Submitted',
                          f'{g.current_user["full_name"]} submitted a payment.', 'payment')
        ll_user = query("SELECT email, full_name FROM users WHERE id=%s", (b['landlord_user_id'],), fetchone=True)
        if ll_user:
            proof_link = ''  # Do not include file URL in email — tenant must log in to view proof
            send_email_if_opted_in(
                b['landlord_user_id'], 'email_payment_submitted',
                ll_user['email'],
                f'Payment Submitted by {g.current_user["full_name"]}',
                f'<h2>New Payment Submitted</h2><p>{g.current_user["full_name"]} submitted a payment of {amount_paid}.</p>' + proof_link + '<p><a href="https://shilohliving.app">Review in dashboard</a></p>'
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
    p=query("""SELECT py.id, c.tenant_id FROM payments py
               JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
               JOIN units un ON un.id=c.unit_id JOIN properties pr ON pr.id=un.property_id
               WHERE py.id=%s AND pr.landlord_id=%s""",(pid,lp['id']),fetchone=True)
    if not p: return err('Not found',404)
    execute("UPDATE payments SET status='approved',reviewed_at=NOW(),reviewed_by=%s WHERE id=%s",(g.current_user['id'],pid))

    tenant_user = query(
        "SELECT u.id, u.email, u.full_name FROM users u JOIN tenant_profiles tp ON tp.user_id=u.id WHERE tp.id=%s",
        (p['tenant_id'],), fetchone=True
    )
    if tenant_user:
        push_notification(tenant_user['id'], 'Payment Approved', 'Your payment has been approved.', 'payment')
        send_email_if_opted_in(
            tenant_user['id'], 'email_payment_approved',
            tenant_user['email'],
            'Your Payment Has Been Approved',
            f"""
            <h2>Payment Approved ✓</h2>
            <p>Hi {tenant_user['full_name']},</p>
            <p>Your payment has been reviewed and <strong>approved</strong>.</p>
            <p><a href="https://shilohliving.app">View your dashboard →</a></p>
            """
        )

    return ok(msg='Approved')

@app.route('/api/payments/<int:pid>/reject', methods=['PATCH'])
@require_auth('landlord')
def reject_payment(pid):
    lp=get_landlord_profile(g.current_user['id']); data=request.get_json() or {}
    notes=data.get('notes','')
    p=query("""SELECT py.id, c.tenant_id FROM payments py
               JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
               JOIN units un ON un.id=c.unit_id JOIN properties pr ON pr.id=un.property_id
               WHERE py.id=%s AND pr.landlord_id=%s""",(pid,lp['id']),fetchone=True)
    if not p: return err('Not found',404)
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
            <p>Hi {tenant_user['full_name']},</p>
            <p>Your payment submission was <strong>rejected</strong>.</p>
            {f'<p><strong>Reason:</strong> {notes}</p>' if notes else ''}
            <p>Please resubmit with the correct proof of payment.</p>
            <p><a href="https://shilohliving.app">Go to dashboard →</a></p>
            """
        )

    return ok(msg='Rejected')


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
    total_bill=float(data.get('total_bill',0)); overall_consumption=float(data.get('overall_consumption',0))
    pump_total=float(data.get('pump_total',0)); number_of_units=int(data.get('number_of_units',1))
    if not all([property_id,session_month,session_year,prev_reading_date,curr_reading_date,total_bill,overall_consumption]):
        return err('All fields required')
    p=query("SELECT id FROM properties WHERE id=%s AND landlord_id=%s",(property_id,lp['id']),fetchone=True)
    if not p: return err('Property not found',404)
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
    saved=[]
    for r in readings:
        unit_id=r.get('unit_id'); prev_reading=float(r.get('prev_reading',0))
        curr_reading=float(r.get('curr_reading',0)); is_owner_unit=1 if r.get('is_owner_unit') else 0
        if curr_reading<prev_reading: return err(f'Current < previous for unit {unit_id}')
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
        WHERE wmr.session_id=%s AND wmr.is_owner_unit=0""",(sid,))
    if not readings: return err('No readings. Save readings first.',400)
    month_names=['January','February','March','April','May','June','July','August','September','October','November','December']
    month_name=month_names[int(session['session_month'])-1]; bills_created=0
    for r in readings:
        contract=query("SELECT c.id FROM contracts c WHERE c.unit_id=%s AND c.status='active'",(r['unit_id'],),fetchone=True)
        if not contract: continue
        description=f"Water Bill — {month_name} {session['session_year']} (Unit {r['unit_number']})"
        bid,_=execute("INSERT INTO bills (contract_id,description,bill_type,bill_month,bill_year,amount,due_date) VALUES (%s,%s,'water',%s,%s,%s,%s)",
                      (contract['id'],description,session['session_month'],session['session_year'],r['total_amount'],due_date))
        execute("UPDATE water_meter_readings SET bill_id=%s WHERE id=%s",(bid,r['id']))
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
    lp = get_landlord_profile(g.current_user['id'])
    tenants = query("""
        SELECT tp.id, u.id AS user_id, u.full_name, u.email, u.phone, u.is_active, tl.joined_at,
               c.id AS contract_id, c.status AS contract_status, un.unit_number, p.name AS property_name
        FROM tenant_landlords tl
        JOIN tenant_profiles tp ON tp.id = tl.tenant_id
        JOIN users u ON u.id = tp.user_id
        LEFT JOIN contracts c ON c.tenant_id = tp.id AND c.status = 'active'
        LEFT JOIN units un ON un.id = c.unit_id
        LEFT JOIN properties p ON p.id = un.property_id
        WHERE tl.landlord_id = %s AND tl.is_active = 1
        ORDER BY tl.joined_at DESC
    """, (lp['id'],))
    return ok(tenants)


@app.route('/api/landlord/dashboard', methods=['GET'])
@require_auth('landlord')
def landlord_dashboard():
    lp=get_landlord_profile(g.current_user['id'])
    try:
        summary=query("SELECT * FROM v_landlord_summary WHERE landlord_id=%s",(lp['id'],),fetchone=True)
    except:
        summary=query("""SELECT lp2.id AS landlord_id,
            COUNT(DISTINCT p.id) AS total_properties,
            COUNT(DISTINCT u.id) AS total_units,
            COALESCE(SUM(u.status='occupied'),0) AS occupied_units,
            COALESCE(SUM(u.status='vacant'),0) AS vacant_units,
            COUNT(DISTINCT tl.tenant_id) AS total_tenants
            FROM landlord_profiles lp2
            LEFT JOIN properties p ON p.landlord_id=lp2.id AND p.is_active=1
            LEFT JOIN units u ON u.property_id=p.id
            LEFT JOIN tenant_landlords tl ON tl.landlord_id=lp2.id AND tl.is_active=1
            WHERE lp2.id=%s GROUP BY lp2.id""", (lp['id'],), fetchone=True) or {}
    try:
        recent_payments=query("""SELECT py.id,py.amount_paid,py.status,py.paid_at,u.full_name AS tenant_name,b.description AS bill_desc
            FROM payments py JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
            JOIN tenant_profiles tp ON tp.id=c.tenant_id JOIN users u ON u.id=tp.user_id
            JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
            WHERE p.landlord_id=%s ORDER BY py.paid_at DESC LIMIT 5""",(lp['id'],))
    except Exception as e:
        print(f"[LANDLORD DASH recent_payments ERR] {e}")
        recent_payments=[]
    try:
        unread_threads=query("SELECT COUNT(*) AS cnt FROM message_threads WHERE landlord_id=%s AND is_read_landlord=0",
                             (g.current_user['id'],),fetchone=True)
    except:
        unread_threads=None
    today=datetime.now().day
    try:
        due_reminders=query("SELECT * FROM reminders WHERE landlord_id=%s AND day_of_month=%s AND is_active=1",(lp['id'],today))
    except:
        due_reminders=[]
    try:
        unread_ann = query("""
            SELECT COUNT(*) AS cnt FROM announcements WHERE landlord_id=%s AND is_active=1
        """, (lp['id'],), fetchone=True)
        ann_count = unread_ann['cnt'] if unread_ann else 0
    except:
        ann_count = 0
    return ok({'summary':summary,'recent_payments':recent_payments,'landlord_code':lp['landlord_code'],
               'due_reminders':due_reminders,
               'unread_threads':unread_threads['cnt'] if unread_threads else 0,
               'announcement_count': ann_count})

@app.route('/api/tenant/dashboard', methods=['GET'])
@require_auth('tenant')
def tenant_dashboard():
    try:
        tp = get_tenant_profile(g.current_user['id'])
        if not tp:
            return err('Tenant profile not found. Please re-login.', 404)

        try:
            landlords = query("""SELECT lp.id AS landlord_profile_id, lu.id AS landlord_user_id, lu.full_name AS landlord_name,
                       lp.landlord_code, tl.joined_at,
                       c.id AS contract_id, c.status AS contract_status, c.monthly_rent,
                       c.is_open_term, c.minimum_months, c.contract_doc_url, c.tenant_ack,
                       un.unit_number, p.name AS property_name, p.address
                FROM tenant_landlords tl JOIN landlord_profiles lp ON lp.id=tl.landlord_id
                JOIN users lu ON lu.id=lp.user_id
                LEFT JOIN contracts c ON c.tenant_id=%s AND c.status='active'
                LEFT JOIN units un ON un.id=c.unit_id LEFT JOIN properties p ON p.id=un.property_id
                WHERE tl.tenant_id=%s AND tl.is_active=1""",(tp['id'], tp['id']))
        except Exception as e:
            print("🔥 LANDLORDS ERROR:", e)
            raise

        try:
            bills = query("""SELECT b.*,py.id AS payment_id,py.status AS payment_status FROM bills b
                LEFT JOIN payments py ON py.bill_id=b.id AND py.status!='rejected'
                JOIN contracts c ON c.id=b.contract_id WHERE c.tenant_id=%s ORDER BY b.due_date DESC LIMIT 10""",(tp['id'],))
        except Exception as e:
            print("🔥 BILLS ERROR:", e)
            raise

        try:
            unread_msgs = query(
                "SELECT COUNT(*) AS cnt FROM message_threads WHERE tenant_id=%s AND is_read_tenant=0",
                (g.current_user['id'],), fetchone=True
            )
        except Exception as e:
            print("🔥 UNREAD MSG ERROR:", e)
            raise

        try:
            unread_ann = query("""
                SELECT COUNT(*) AS cnt FROM announcements a
                JOIN landlord_profiles lp ON lp.id=a.landlord_id
                JOIN tenant_landlords tl ON tl.landlord_id=lp.id
                LEFT JOIN announcement_reads ar ON ar.announcement_id=a.id AND ar.tenant_user_id=%s
                WHERE tl.tenant_id=%s AND tl.is_active=1 AND a.is_active=1 AND ar.id IS NULL
            """,(g.current_user['id'], tp['id']), fetchone=True)
        except Exception as e:
            print("🔥 ANNOUNCEMENTS ERROR:", e)
            raise

        return ok({
            'landlords': landlords or [],
            'bills': bills or [],
            'unread_messages': unread_msgs.get('cnt', 0) if unread_msgs else 0,
            'unread_announcements': unread_ann.get('cnt', 0) if unread_ann else 0
        })

    except Exception as e:
        print("🔥 FINAL ERROR:", e)
        return err(str(e), 500)


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
    return ok(query("""SELECT u.id,u.email,u.full_name,u.is_active,u.created_at,lp.landlord_code,lp.business_name,
        COUNT(DISTINCT p.id) AS properties,COUNT(DISTINCT tl.tenant_id) AS tenants
        FROM users u JOIN landlord_profiles lp ON lp.user_id=u.id
        LEFT JOIN properties p ON p.landlord_id=lp.id LEFT JOIN tenant_landlords tl ON tl.landlord_id=lp.id
        WHERE u.role='landlord' GROUP BY u.id,lp.landlord_code,lp.business_name ORDER BY u.created_at DESC"""))

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
    link = f"https://shilohliving.app/?type=verify&token={token}"
    send_email(email, "Verify your Shiloh Living email",
        f"""
        <h2>Welcome to Shiloh Living!</h2>
        <p>Hi {full_name},</p>
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
    # Always return ok to avoid email enumeration
    if user:
        token = secrets.token_urlsafe(32)
        expires = datetime.utcnow() + timedelta(hours=1)
        execute("DELETE FROM password_resets WHERE user_id=%s", (user['id'],))
        execute("INSERT INTO password_resets (user_id, token, expires_at) VALUES (%s,%s,%s)",
                (user['id'], token, expires))
        link = "https://shilohliving.app/?type=reset&token=" + token
        body = (
            "<h2>Password Reset Request</h2>"
            "<p>Hi " + user['full_name'] + ",</p>"
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
    row = query("SELECT * FROM password_resets WHERE token=%s", (token,), fetchone=True)
    if not row:
        return err('Invalid or expired reset link', 400)
    if datetime.utcnow() > row['expires_at']:
        execute("DELETE FROM password_resets WHERE token=%s", (token,))
        return err('Reset link has expired. Please request a new one.', 400)
    execute("UPDATE users SET password_hash=%s WHERE id=%s",
            (hash_password(password), row['user_id']))
    execute("DELETE FROM password_resets WHERE user_id=%s", (row['user_id'],))
    return ok(msg='Password reset successfully! You can now log in.')

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
    if not lp:
        return err('Landlord profile not found', 404)
    code = lp['landlord_code']
    register_url = f"https://shilohliving.app/?register=tenant&code={code}"
    if not QR_AVAILABLE:
        return ok({'register_url': register_url, 'landlord_code': code, 'qr_base64': None})
    img = qrcode.make(register_url)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    b64 = base64.b64encode(buf.getvalue()).decode()
    return ok({'register_url': register_url, 'landlord_code': code, 'qr_base64': b64})


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
    admins = query("SELECT id FROM users WHERE role='admin'")
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
    execute("INSERT INTO support_chat_messages (chat_id,sender_id,sender_role,body) VALUES (%s,%s,%s,%s)",
            (cid, u['id'], u['role'], body))
    execute("UPDATE support_chats SET last_message_at=NOW() WHERE id=%s", (cid,))
    if u['role'] == 'admin':
        push_notification(chat['user_id'], 'Support replied to your message', body[:80], 'support')
        chat_user = query("SELECT email, full_name FROM users WHERE id=%s", (chat['user_id'],), fetchone=True)
        if chat_user:
            send_email_if_opted_in(chat['user_id'], 'email_ticket_reply', chat_user['email'],
                f'Support replied: {chat["subject"]}',
                f'<h2>Support Reply</h2><p>{body}</p><p><a href="https://shilohliving.app">View conversation →</a></p>')
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
    if len(new_password) < 8: return err('Password must be at least 8 characters')
    execute("UPDATE users SET password_hash=%s WHERE id=%s", (hash_password(new_password), uid))
    log_action('ADMIN_RESET_PASSWORD', 'users', uid)
    return ok(msg='Password reset')


@app.route('/sw.js')
def service_worker():
    return send_from_directory(
        os.path.join(os.path.dirname(__file__), 'static', 'js'),
        'sw.js',
        mimetype='application/javascript'
    )


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)