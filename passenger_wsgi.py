import sys
import os

sys.path.insert(0, '/home/shilzikx/public_html/shilohliving')

from dotenv import load_dotenv
load_dotenv('/home/shilzikx/public_html/shilohliving/.env')

from app import app as application