"""Printable PDFs: bill statements and payment receipts (fpdf2).

Takes plain dicts built by app.py (bill_document / receipt_document) and returns PDF bytes.
DejaVu Sans is bundled in pdf_fonts/ because the built-in PDF fonts have no peso sign.
Colours follow the app / marketing site (deep green, lime accent, paper)."""
import os
from datetime import date, datetime

from fpdf import FPDF

FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pdf_fonts')
GREEN = (36, 87, 68)
PANEL = (36, 79, 61)
INK = (23, 55, 45)
MUTED = (105, 117, 109)
LINE = (228, 231, 223)
SAGE = (233, 239, 225)
LIME = (217, 236, 143)
RED = (147, 64, 44)

BILL_TYPES = {'rent': 'Rent', 'water': 'Water', 'electricity': 'Electricity', 'other': 'Other charges'}
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
          'September', 'October', 'November', 'December']


def peso(v):
    return f"₱{float(v or 0):,.2f}"


def fdate(v, with_time=False):
    if not v:
        return '—'
    if isinstance(v, str):
        try:
            v = datetime.fromisoformat(v)
        except ValueError:
            return v
    if with_time and isinstance(v, datetime):
        return v.strftime('%b %d, %Y %I:%M %p').replace(' 0', ' ')
    return v.strftime('%b %d, %Y')


class _Doc(FPDF):
    def __init__(self, kind, number, landlord):
        super().__init__(format='A4', unit='mm')
        self.kind, self.number, self.landlord = kind, number, landlord
        self.add_font('DejaVu', '', os.path.join(FONT_DIR, 'DejaVuSans.ttf'))
        self.add_font('DejaVu', 'B', os.path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'))
        self.set_margins(16, 16, 16)
        self.set_auto_page_break(True, 20)
        self.set_title(f'{kind} {number}')
        self.set_author(landlord.get('display_name') or 'Shiloh Living')
        self.set_creator('Shiloh Living')
        self.add_page()

    def header(self):
        # Green band: landlord (issuer) on the left, document type and number on the right
        self.set_fill_color(*PANEL)
        self.rect(0, 0, 210, 34, 'F')
        self.set_fill_color(*LIME)
        self.rect(0, 34, 210, 1.4, 'F')
        self.set_xy(16, 9)
        self.set_text_color(246, 247, 238)
        self.set_font('DejaVu', 'B', 15)
        self.cell(110, 8, self.landlord.get('display_name') or 'Shiloh Living')
        self.set_font('DejaVu', 'B', 13)
        self.set_text_color(*LIME)
        self.cell(0, 8, self.kind.upper(), align='R', new_x='LMARGIN', new_y='NEXT')
        self.set_x(16)
        self.set_font('DejaVu', '', 8.5)
        self.set_text_color(197, 209, 196)
        contact = ' · '.join(x for x in (self.landlord.get('email'), self.landlord.get('phone')) if x)
        self.cell(110, 5, contact)
        self.set_text_color(246, 247, 238)
        self.cell(0, 5, f'No. {self.number}', align='R')
        self.set_y(44)

    def footer(self):
        self.set_y(-14)
        self.set_draw_color(*LINE)
        self.line(16, self.get_y() - 2, 194, self.get_y() - 2)
        self.set_font('DejaVu', '', 7.5)
        self.set_text_color(*MUTED)
        self.cell(0, 5, f'Generated {fdate(datetime.now(), True)} · Shiloh Living (hub.shilohliving.app)')
        self.cell(0, 5, f'Page {self.page_no()}/{{nb}}', align='R')

    # ── building blocks ──
    def label(self, text, w=0, ln=False):
        self.set_font('DejaVu', 'B', 7)
        self.set_text_color(*MUTED)
        self.cell(w, 4.5, text.upper(), new_x='LMARGIN' if ln else 'RIGHT', new_y='NEXT' if ln else 'TOP')

    def value(self, text, w=0, ln=True, bold=False, size=10, color=INK):
        self.set_font('DejaVu', 'B' if bold else '', size)
        self.set_text_color(*color)
        self.cell(w, 6, str(text), new_x='LMARGIN' if ln else 'RIGHT', new_y='NEXT' if ln else 'TOP')

    def two_columns(self, left, right):
        """left/right: lists of (label, value). Billed-to vs details blocks."""
        y0 = self.get_y()
        for col, items in ((16, left), (110, right)):
            self.set_xy(col, y0)
            for lab, val in items:
                self.set_x(col)
                self.label(lab, 84, ln=True)
                self.set_x(col)
                self.set_font('DejaVu', '', 10)
                self.set_text_color(*INK)
                self.multi_cell(84, 5.4, str(val or '—'), align='L', new_x='LMARGIN', new_y='NEXT')
                self.ln(1.2)
            if col == 16:
                y_left = self.get_y()
        self.set_y(max(y_left, self.get_y()) + 3)

    def table(self, headers, widths, rows, aligns=None):
        aligns = aligns or ['L'] * len(headers)
        self.set_fill_color(*SAGE)
        self.set_font('DejaVu', 'B', 7.5)
        self.set_text_color(*MUTED)
        for h, w, a in zip(headers, widths, aligns):
            self.cell(w, 7, h.upper(), fill=True, align=a)
        self.ln(7)
        self.set_font('DejaVu', '', 9)
        self.set_text_color(*INK)
        self.set_draw_color(*LINE)
        for row in rows:
            for v, w, a in zip(row, widths, aligns):
                self.cell(w, 7, str(v), align=a)
            self.ln(7)
            self.line(16, self.get_y(), 194, self.get_y())

    def total_box(self, label, amount, sub=None, color=GREEN):
        self.ln(3)
        x = 112
        self.set_fill_color(*SAGE)
        self.rect(x, self.get_y(), 82, 18 if sub else 14, 'F')
        self.set_xy(x + 4, self.get_y() + 2)
        self.label(label, 74, ln=True)
        self.set_x(x + 4)
        self.value(amount, 74, bold=True, size=14, color=color)
        if sub:
            self.set_x(x + 4)
            self.set_font('DejaVu', '', 8)
            self.set_text_color(*MUTED)
            self.cell(74, 4, sub, new_x='LMARGIN', new_y='NEXT')
        self.ln(4)

    def note(self, text):
        self.ln(2)
        self.set_font('DejaVu', '', 8.5)
        self.set_text_color(*MUTED)
        self.multi_cell(0, 4.6, text)

    def stamp(self, text, color):
        """A small status stamp under the header (PAID / UNPAID / OVERDUE)."""
        self.set_font('DejaVu', 'B', 9)
        self.set_text_color(*color)
        self.set_draw_color(*color)
        w = self.get_string_width(text) + 8
        self.set_xy(194 - w, 40)
        self.cell(w, 7, text, border=1, align='C')
        self.set_y(50)


def _period(bill):
    if bill.get('bill_month') and bill.get('bill_year'):
        return f"{MONTHS[int(bill['bill_month']) - 1]} {bill['bill_year']}"
    return '—'


def bill_pdf(d):
    """Bill statement. d: bill, tenant, landlord, property, unit_number, water (or None),
    payments (approved/pending), paid_total, balance."""
    b = d['bill']
    pdf = _Doc('Billing Statement', f"B-{int(b['id']):06d}", d['landlord'])
    pdf.alias_nb_pages()
    status = (b.get('status') or 'pending').upper()
    if status == 'PENDING':
        status = 'UNPAID'
    pdf.stamp(status, GREEN if status == 'PAID' else RED)

    prop = d['property']
    pdf.two_columns(
        [('Billed to', d['tenant']['full_name']),
         ('Contact', ' · '.join(x for x in (d['tenant'].get('email'), d['tenant'].get('phone')) if x)),
         ('Property / Unit', f"{prop['name']} — Unit {d['unit_number']}\n{prop.get('address') or ''}"
                             + (f", {prop['city']}" if prop.get('city') else ''))],
        [('Statement date', fdate(b.get('created_at'))),
         ('Due date', fdate(b.get('due_date'))),
         ('Billing period', _period(b)),
         ('Type', BILL_TYPES.get(b.get('bill_type'), 'Other'))])

    pdf.table(['Description', 'Amount'], [138, 40], [[b['description'], peso(b['amount'])]], ['L', 'R'])

    w = d.get('water')
    if w:
        pdf.ln(4)
        pdf.label('Water meter computation', ln=True)
        pdf.ln(1)
        pdf.table(['Previous', 'Current', 'Used (cu.m)', 'Rate / cu.m', 'Water', 'Pump fee'],
                  [28, 28, 30, 30, 32, 30],
                  [[f"{float(w['prev_reading']):,.2f}", f"{float(w['curr_reading']):,.2f}",
                    f"{float(w['consumption']):,.2f}", peso(w['price_per_cubic']),
                    peso(w['water_bill']), peso(w['pump_fee'])]],
                  ['R'] * 6)
        pdf.note(f"Reading dates: {fdate(w.get('prev_reading_date'))} to {fdate(w.get('curr_reading_date'))}.")

    if d['payments']:
        pdf.ln(4)
        pdf.label('Payments received', ln=True)
        pdf.ln(1)
        pdf.table(['Paid on', 'Status', 'Receipt no.', 'Amount'], [45, 45, 48, 40],
                  [[fdate(p['paid_at']), (p['status'] or '').title(), p.get('receipt_no') or '—', peso(p['amount_paid'])]
                   for p in d['payments']], ['L', 'L', 'L', 'R'])

    pdf.total_box('Balance due' if float(d['balance']) > 0 else 'Fully paid', peso(max(float(d['balance']), 0)),
                  f"Total {peso(b['amount'])} · Paid {peso(d['paid_total'])}")
    pdf.note('Pay through the Shiloh Living app (My Bills → Pay) and upload your proof of payment. '
             'A receipt is issued once your landlord approves the payment.')
    return bytes(pdf.output())


def receipt_pdf(d):
    """Acknowledgement receipt for an approved payment. d: payment, bill, tenant, landlord,
    property, unit_number, reviewer_name, balance."""
    p, b = d['payment'], d['bill']
    pdf = _Doc('Acknowledgement Receipt', p['receipt_no'], d['landlord'])
    pdf.alias_nb_pages()
    pdf.stamp('PAID', GREEN)
    prop = d['property']
    pdf.two_columns(
        [('Received from', d['tenant']['full_name']),
         ('Property / Unit', f"{prop['name']} — Unit {d['unit_number']}"),
         ('For', f"{b['description']} ({BILL_TYPES.get(b.get('bill_type'), 'Other')})")],
        [('Receipt date', fdate(p.get('reviewed_at'))),
         ('Payment submitted', fdate(p.get('paid_at'), True)),
         ('Approved', f"{fdate(p.get('reviewed_at'), True)}" + (f" by {d['reviewer_name']}" if d.get('reviewer_name') else '')),
         ('Bill no.', f"B-{int(b['id']):06d} · due {fdate(b.get('due_date'))}")])
    pdf.table(['Description', 'Bill amount', 'Amount received'], [98, 40, 40],
              [[b['description'], peso(b['amount']), peso(p['amount_paid'])]], ['L', 'R', 'R'])
    pdf.total_box('Amount received', peso(p['amount_paid']),
                  'Bill fully paid' if float(d['balance']) <= 0 else f"Remaining balance {peso(d['balance'])}")
    pdf.note('This acknowledges receipt of the payment above. It is not a BIR official receipt.')
    return bytes(pdf.output())
