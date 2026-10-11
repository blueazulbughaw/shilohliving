import sys
import os

APP_ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, APP_ROOT)

from dotenv import load_dotenv
load_dotenv(os.path.join(APP_ROOT, '.env'))

from app import app as application
