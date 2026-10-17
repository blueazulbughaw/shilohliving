"""Applies migrations/NNN_*.sql in order, once each, recording them in schema_migrations.

Run on the server by scripts/deploy.sh --migrate (after a backup). Uses the app's .env.
Statements are split on ';' at line ends, so migration files must not contain procedures
or triggers with bodies."""
import glob
import os
import sys

from dotenv import load_dotenv
import mysql.connector

HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(HERE, '..', '.env'))


def statements(sql):
    buf = []
    for line in sql.splitlines():
        if line.strip().startswith('--'):
            continue
        buf.append(line)
        if line.rstrip().endswith(';'):
            stmt = '\n'.join(buf).strip().rstrip(';').strip()
            if stmt:
                yield stmt
            buf = []
    tail = '\n'.join(buf).strip()
    if tail:
        yield tail


def main():
    conn = mysql.connector.connect(
        host=os.environ.get('DB_HOST', '127.0.0.1'), port=int(os.environ.get('DB_PORT', 3306)),
        user=os.environ['DB_USER'], password=os.environ['DB_PASSWORD'],
        database=os.environ['DB_NAME'], charset='utf8mb4')
    cur = conn.cursor()
    cur.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
    cur.execute("SELECT name FROM schema_migrations")
    done = {r[0] for r in cur.fetchall()}
    pending = [p for p in sorted(glob.glob(os.path.join(HERE, '[0-9]*.sql')))
               if os.path.basename(p) not in done]
    if not pending:
        print('No pending migrations.')
        return
    for path in pending:
        name = os.path.basename(path)
        print(f'Applying {name}')
        with open(path, encoding='utf-8') as f:
            for stmt in statements(f.read()):
                cur.execute(stmt)
        cur.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (name,))
        conn.commit()
    print('Done.')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'Migration failed: {e}', file=sys.stderr)
        sys.exit(1)
