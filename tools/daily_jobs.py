"""Hourly job (cron on the server, installed by scripts/deploy.sh): marks unpaid bills past their
due date as overdue and, from 8 AM local time, sends the day's reminders — the landlord's own
(Settings → My Reminders) and bill reminders to tenants (per property and bill type). Each
reminder goes out once a day however often this runs. Run from the app folder:
    python tools/daily_jobs.py
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as A  # noqa: E402

if __name__ == '__main__':
    result = A.run_daily_jobs()
    A._push_pool.shutdown(wait=True)   # let the phone pushes finish before exiting
    print(A.local_now().isoformat(sep=' '), result)
