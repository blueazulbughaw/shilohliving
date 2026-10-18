"""Sample data for the LOCAL database only (scripts/dev.sh). Refuses to run against anything
but the local dev database. Every account's password is in LOGINS below."""
import os
import sys
from datetime import date, datetime, timedelta

import bcrypt
import mysql.connector

if os.environ.get('DB_NAME') != 'shiloh_local' or os.environ.get('DB_PORT') != '3310':
    sys.exit('seed_local.py only runs against the local dev database (scripts/dev.sh).')

LOGINS = [  # email, password, name, role
    ('landlord@local.test', 'Landlord#1', 'Juan Dela Cruz', 'landlord'),
    ('maria@local.test', 'Tenant#123', 'Maria Santos', 'tenant'),
    ('pedro@local.test', 'Tenant#123', 'Pedro Penduko', 'tenant'),
    ('ana@local.test', 'Tenant#123', 'Ana Reyes', 'tenant'),
    ('liza@local.test', 'Tenant#123', 'Liza Soberano', 'tenant'),
    ('old@local.test', 'Tenant#123', 'Ramon Bautista', 'tenant'),
    ('admin@local.test', 'Admin#123', 'Site Admin', 'admin'),
]

db = mysql.connector.connect(host='127.0.0.1', port=3310, user='root', password='', database='shiloh_local', charset='utf8mb4')
cur = db.cursor()
def run(sql, args=()):
    cur.execute(sql, args)
    return cur.lastrowid
def one(sql, args=()):
    cur.execute(sql, args)
    return cur.fetchone()

if one("SELECT COUNT(*) FROM users")[0]:
    print('Sample data already loaded.')
    sys.exit(0)

today = date.today()
first = today.replace(day=1)
def months_ago(n):
    y, m = first.year, first.month - n
    while m <= 0:
        m += 12; y -= 1
    return date(y, m, 1)

users = {}
for email, pw, name, role in LOGINS:
    users[email] = run("""INSERT INTO users (email,password_hash,full_name,phone,role,email_verified)
                          VALUES (%s,%s,%s,%s,%s,1)""",
                       (email, bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=10)).decode(), name, '+63 917 555 0100', role))
lp = run("INSERT INTO landlord_profiles (user_id,landlord_code,business_name) VALUES (%s,'LDEMO234','Shiloh Apartments')",
         (users['landlord@local.test'],))
tp = {e: run("INSERT INTO tenant_profiles (user_id) VALUES (%s)", (users[e],))
      for e, _, _, r in LOGINS if r == 'tenant'}

p1 = run("""INSERT INTO properties (landlord_id,name,address,city,country) VALUES (%s,'Sunrise Residences','12 Mabini St','Cebu City','Philippines')""", (lp,))
p2 = run("""INSERT INTO properties (landlord_id,name,address,city,country,features)
            VALUES (%s,'Garden Villas','5 Rizal Ave','Mandaue','Philippines',
                    '{"rent_billing": true, "water_billing": false, "electricity_billing": true, "other_charges": false}')""", (lp,))
units = {}
for prop, nums, rent in ((p1, ['1A', '2B', '3A', '10'], 12500), (p2, ['V1', 'V2'], 18000)):
    for n in nums:
        units[n] = run("INSERT INTO units (property_id,unit_number,bedrooms,rent_amount) VALUES (%s,%s,2,%s)", (prop, n, rent))

for e in ('maria@local.test', 'pedro@local.test', 'ana@local.test', 'liza@local.test'):
    run("INSERT INTO tenant_landlords (tenant_id,landlord_id,joined_at) VALUES (%s,%s,%s)", (tp[e], lp, months_ago(8)))
# moved out last month: a past tenant with a full history
run("INSERT INTO tenant_landlords (tenant_id,landlord_id,joined_at,is_active,left_at) VALUES (%s,%s,%s,0,%s)",
    (tp['old@local.test'], lp, months_ago(14), months_ago(1)))

def contract(email, unit, rent, start, status='active', end=None):
    return run("""INSERT INTO contracts (unit_id,tenant_id,start_date,end_date,monthly_rent,deposit,is_open_term,status,move_out_date)
                  VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
               (units[unit], tp[email], start, end, rent, rent * 2, 0 if end else 1, status, end if status == 'terminated' else None))
c_old = contract('old@local.test', '3A', 11000, months_ago(14), 'terminated', months_ago(1) - timedelta(days=1))
run("UPDATE units SET status='vacant' WHERE id=%s", (units['3A'],))
c_maria = contract('maria@local.test', '10', 12500, months_ago(7))
c_pedro = contract('pedro@local.test', '2B', 12500, months_ago(6))
c_ana = contract('ana@local.test', 'V1', 18000, months_ago(5))
# Pedro is in the middle of moving out
run("UPDATE contracts SET status='move_out_pending', move_out_date=%s WHERE id=%s", (today + timedelta(days=10), c_pedro))
run("INSERT INTO move_out_checklists (contract_id) VALUES (%s)", (c_pedro,))

def bill(cid, desc, kind, amount, due, month=None, year=None, created=None):
    return run("""INSERT INTO bills (contract_id,description,bill_type,bill_month,bill_year,amount,due_date,status,created_at)
                  VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
               (cid, desc, kind, month, year, amount, due, 'pending' if due >= today else 'overdue',
                created or due - timedelta(days=7)))
def pay(bid, amount, paid_on, approved_after_days=1):
    paid_at = datetime.combine(paid_on, datetime.min.time()) + timedelta(hours=10)
    reviewed = paid_at + timedelta(days=approved_after_days)
    pid = run("""INSERT INTO payments (bill_id,amount_paid,proof_url,status,paid_at,reviewed_at,reviewed_by)
                 VALUES (%s,%s,'https://res.cloudinary.com/dyyi3mtm0/image/upload/sample.jpg','approved',%s,%s,%s)""",
              (bid, amount, paid_at, reviewed, users['landlord@local.test']))
    run("UPDATE payments SET receipt_no=CONCAT('AR-',LPAD(id,6,'0')), receipt_sent_at=reviewed_at WHERE id=%s", (pid,))
    run("UPDATE bills SET status='paid' WHERE id=%s", (bid,))

# Monthly rent: Maria pays on time, Pedro is often late, Ana always on time; this month unpaid
for cid, rent, months, late_months in ((c_maria, 12500, 7, {3}), (c_pedro, 12500, 6, {1, 2, 4, 5}), (c_ana, 18000, 5, set()),
                                        (c_old, 11000, 13, {6})):
    for n in range(months, 0 if cid != c_old else 1, -1):
        m = months_ago(n)
        due = m.replace(day=7)
        b = bill(cid, f"Monthly Rent — {m.strftime('%B %Y')}", 'rent', rent, due, m.month, m.year)
        pay(b, rent, due + timedelta(days=12 if n in late_months else -2))
    if cid != c_old:
        bill(cid, f"Monthly Rent — {first.strftime('%B %Y')}", 'rent', rent, first.replace(day=7) if today.day <= 7 else today + timedelta(days=5),
             first.month, first.year)

# Water billing for Sunrise Residences last month, with readings per unit
m = months_ago(1)
sess = run("""INSERT INTO water_meter_sessions (property_id,session_month,session_year,prev_reading_date,curr_reading_date,
              total_bill,overall_consumption,price_per_cubic,pump_total,number_of_units,pump_per_unit,status)
              VALUES (%s,%s,%s,%s,%s,2500,80,31.25,400,4,100,'billed')""",
           (p1, m.month, m.year, m, m.replace(day=28)))
for unit, cid, prev, curr, paid in (('10', c_maria, 1520, 1543.5, True), ('2B', c_pedro, 880, 905, False)):
    used = curr - prev; water = used * 31.25; total = water + 100
    b = bill(cid, f"Water Bill — {m.strftime('%B %Y')} (Unit {unit})", 'water', round(total, 2),
             today - timedelta(days=3) if not paid else first.replace(day=15), m.month, m.year)
    run("""INSERT INTO water_meter_readings (session_id,unit_id,prev_reading,curr_reading,consumption,water_bill,pump_fee,total_amount,bill_id)
           VALUES (%s,%s,%s,%s,%s,%s,100,%s,%s)""", (sess, units[unit], prev, curr, used, water, total, b))
    if paid:
        pay(b, round(total, 2), first.replace(day=10))
# An electricity bill at Garden Villas, paid, with a proof waiting for approval on another
b = bill(c_ana, f"Electricity — {m.strftime('%B %Y')}", 'electricity', 3250.40, first.replace(day=20), m.month, m.year)
run("""INSERT INTO payments (bill_id,amount_paid,proof_url,status,paid_at) VALUES
       (%s,3250.40,'https://res.cloudinary.com/dyyi3mtm0/image/upload/sample.jpg','pending',NOW())""", (b,))

# A conversation and an announcement
th = run("""INSERT INTO message_threads (subject,started_by,landlord_id,tenant_id,is_read_landlord,is_read_tenant)
            VALUES ('Maintenance Request',%s,%s,%s,0,1)""",
         (users['maria@local.test'], users['landlord@local.test'], users['maria@local.test']))
run("INSERT INTO message_replies (thread_id,sender_id,body) VALUES (%s,%s,'The kitchen faucet is leaking. Can someone check it this week?')",
    (th, users['maria@local.test']))
run("""INSERT INTO announcements (landlord_id,subject,body,target_all) VALUES
       (%s,'Water interruption on Saturday','Water will be off from 9 AM to 1 PM for tank cleaning.',1)""", (lp,))
db.commit()
print('Sample data loaded. Sign in with:')
for email, pw, name, role in LOGINS:
    print(f'  {role:<9} {email:<22} {pw}')
