"""One-time move of old uploads from public Cloudinary links to private storage (/api/files/...).

Run on the server from the app folder:
    ~/virtualenv/shilohliving_hub/3.12/bin/python tools/import_cloudinary_uploads.py           # count only
    ~/virtualenv/shilohliving_hub/3.12/bin/python tools/import_cloudinary_uploads.py --apply   # move them

Each record (payment proof, signed contract, repair receipt) gets the private copy; a list of old
link -> new link is written to ~/backups so nothing is lost. A link that can't be downloaded or
isn't a photo/PDF is left as it was and reported. Deleting the old files from Cloudinary is done
in the Cloudinary console afterwards."""
import os
import sys
from datetime import datetime

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app as A  # noqa: E402

APPLY = '--apply' in sys.argv
SOURCES = [  # (table, id column, url column, kind, owner query)
    ('payments', 'id', 'proof_url', 'payment_proof',
     """SELECT tp.user_id FROM payments py JOIN bills b ON b.id=py.bill_id JOIN contracts c ON c.id=b.contract_id
        JOIN tenant_profiles tp ON tp.id=c.tenant_id WHERE py.id=%s"""),
    ('contracts', 'id', 'contract_doc_url', 'contract',
     """SELECT lp.user_id FROM contracts c JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
        JOIN landlord_profiles lp ON lp.id=p.landlord_id WHERE c.id=%s"""),
    ('move_out_checklists', 'contract_id', 'repair_proof_url', 'repair_proof',
     """SELECT lp.user_id FROM contracts c JOIN units un ON un.id=c.unit_id JOIN properties p ON p.id=un.property_id
        JOIN landlord_profiles lp ON lp.id=p.landlord_id WHERE c.id=%s"""),
]

moved, failed, log_lines = 0, [], []
for table, idcol, col, kind, owner_sql in SOURCES:
    rows = A.query(f"SELECT {idcol} AS id, {col} AS url FROM {table} WHERE {col} LIKE 'https://res.cloudinary.com/%%'")
    print(f'{table}.{col}: {len(rows)} on Cloudinary')
    if not APPLY:
        continue
    for r in rows:
        try:
            owner = A.query(owner_sql, (r['id'],), fetchone=True)
            resp = requests.get(r['url'], timeout=30)
            resp.raise_for_status()
            new_url = A.save_upload(resp.content, kind, list(owner.values())[0], os.path.basename(r['url'].split('?')[0]))
            A.execute(f"UPDATE {table} SET {col}=%s WHERE {idcol}=%s AND {col}=%s", (new_url, r['id'], r['url']))
            log_lines.append(f"{table}\t{r['id']}\t{r['url']}\t{new_url}")
            moved += 1
        except Exception as e:
            failed.append(f"{table} {r['id']}: {type(e).__name__}: {e}")

if APPLY:
    os.makedirs(os.path.expanduser('~/backups'), exist_ok=True)
    path = os.path.expanduser(f"~/backups/cloudinary-import-{datetime.now():%Y%m%d-%H%M%S}.tsv")
    with open(os.open(path, os.O_WRONLY | os.O_CREAT, 0o600), 'w') as f:
        f.write('table\tid\told_url\tnew_url\n' + '\n'.join(log_lines) + '\n')
    print(f'Moved {moved} file(s); list saved to {path}')
    for line in failed:
        print('Not moved (left as is):', line)
else:
    print('Count only. Run with --apply to move them.')
