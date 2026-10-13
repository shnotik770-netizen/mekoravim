import express from 'express';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, migrate } from './lib/db.js';
import {
  HEB_MONTHS, DAY_NAMES, todayIL, eventsInRange, nextEvents, weekRange, monthRange,
  addDays, fmtGreg,
} from './lib/dates.js';
import { parseContact, parseFamily, parseBirth, birthText, formValues, whatsappLink, RELATIONS } from './lib/person.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROD = process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error('חובה להגדיר ADMIN_PASSWORD ו-SESSION_SECRET');
  process.exit(1);
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '1d' : 0 }));
app.use(cookieSession({
  name: 'mk', keys: [SESSION_SECRET], httpOnly: true, sameSite: 'lax', secure: PROD,
  maxAge: 30 * 24 * 3600 * 1000,
}));
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Content-Type-Options', 'nosniff');
  res.locals.HEB_MONTHS = HEB_MONTHS;
  res.locals.RELATIONS = RELATIONS;
  res.locals.birthText = birthText;
  res.locals.fmtGreg = fmtGreg;
  res.locals.DAY_NAMES = DAY_NAMES;
  res.locals.flash = req.session.flash;
  req.session.flash = undefined;
  next();
});

const flash = (req, msg) => { req.session.flash = msg; };
const randomToken = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// הגבלת ניסיונות התחברות פשוטה (בזיכרון)
const attempts = new Map();
function tooMany(key) {
  const a = attempts.get(key);
  return a && a.count >= 8 && Date.now() - a.first < 15 * 60 * 1000;
}
function failed(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > 15 * 60 * 1000) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}

/* ------------------------------ דף ראשי ומנהל ------------------------------ */

app.get('/', (req, res) => res.render('home'));

app.get('/admin/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin_login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const key = 'admin:' + req.ip;
  if (tooMany(key)) return res.status(429).render('admin_login', { error: 'יותר מדי ניסיונות. נסה שוב בעוד רבע שעה.' });
  if (!crypto.timingSafeEqual(sha(req.body.password || ''), sha(ADMIN_PASSWORD))) {
    failed(key);
    return res.status(401).render('admin_login', { error: 'סיסמה שגויה' });
  }
  attempts.delete(key);
  req.session = { admin: true };
  res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => { req.session = null; res.redirect('/'); });

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}

// המנהל רואה רק שם, קישור וסטטוס — לא את נתוני המקורבים
app.get('/admin', requireAdmin, async (req, res) => {
  const { rows } = await q(`SELECT id, name, slug, active, created_at, password_hash IS NOT NULL AS activated
                            FROM shluchim ORDER BY created_at DESC`);
  const newCode = req.session.newCode;
  req.session.newCode = undefined;
  res.render('admin', { shluchim: rows, base: baseUrl(req), newCode });
});

async function issueSetupCode(req, id) {
  const code = String(crypto.randomInt(100000, 1000000));
  await q('UPDATE shluchim SET setup_code_hash=$1, password_hash=NULL WHERE id=$2', [await bcrypt.hash(code, 10), id]);
  const { rows } = await q('SELECT name, slug FROM shluchim WHERE id=$1', [id]);
  req.session.newCode = { ...rows[0], code };
}

app.post('/admin/shluchim', requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) { flash(req, 'יש להזין שם'); return res.redirect('/admin'); }
  const { rows } = await q('INSERT INTO shluchim (name, slug) VALUES ($1,$2) RETURNING id', [name, randomToken(9)]);
  await issueSetupCode(req, rows[0].id);
  res.redirect('/admin');
});

app.post('/admin/shluchim/:id/reset', requireAdmin, async (req, res) => {
  await issueSetupCode(req, parseInt(req.params.id, 10));
  res.redirect('/admin');
});

app.post('/admin/shluchim/:id/toggle', requireAdmin, async (req, res) => {
  await q('UPDATE shluchim SET active = NOT active WHERE id=$1', [parseInt(req.params.id, 10)]);
  res.redirect('/admin');
});

/* ---------------------------------- שליח ---------------------------------- */

const router = express.Router({ mergeParams: true });
app.use('/s/:slug', router);

router.use(async (req, res, next) => {
  const { rows } = await q('SELECT * FROM shluchim WHERE slug=$1 AND active', [req.params.slug]);
  if (!rows[0]) return res.status(404).render('error', { message: 'הקישור אינו פעיל' });
  req.shliach = res.locals.shliach = rows[0];
  res.locals.base = `/s/${rows[0].slug}`;
  next();
});

function requireShliach(req, res, next) {
  if (req.session.shliachId !== req.shliach.id || !req.shliach.password_hash) return res.redirect(`/s/${req.shliach.slug}/login`);
  next();
}

async function saveContact(shliachId, c, family, source) {
  const { rows } = await q(
    `INSERT INTO contacts (shliach_id, first_name, last_name, phone, notes, g_date, g_after_sunset, h_day, h_month, h_year, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [shliachId, c.first_name, c.last_name, c.phone, c.notes, c.g_date, c.g_after_sunset, c.h_day, c.h_month, c.h_year, source]);
  for (const f of family) await addFamily(rows[0].id, f);
  return rows[0].id;
}

const addFamily = (contactId, f) => q(
  `INSERT INTO family_members (contact_id, relation, first_name, g_date, g_after_sunset, h_day, h_month, h_year)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [contactId, f.relation, f.first_name, f.g_date, f.g_after_sunset, f.h_day, f.h_month, f.h_year]);

// טופס רישום ציבורי למקורבים
router.get('/', (req, res) => res.render('register', { values: { date_type: 'g' }, family: [], error: null, internal: false }));

router.post('/', async (req, res) => {
  if (req.body.website) return res.render('register_done'); // מלכודת לבוטים
  const c = parseContact(req.body);
  const fam = c.error ? {} : parseFamily(req.body.fam);
  const error = c.error || fam.error;
  if (error) return res.status(400).render('register', { values: req.body, family: Object.values(req.body.fam || {}), error, internal: false });
  await saveContact(req.shliach.id, c.value, fam.value, 'form');
  res.render('register_done');
});

// כניסה / הגדרת סיסמה ראשונה
router.get('/login', (req, res) => {
  if (req.session.shliachId === req.shliach.id && req.shliach.password_hash) return res.redirect(`${res.locals.base}/dashboard`);
  res.render('shliach_login', { setup: !req.shliach.password_hash, error: null });
});

router.post('/login', async (req, res) => {
  const s = req.shliach;
  const key = `s${s.id}:${req.ip}`;
  const setup = !s.password_hash;
  const fail = (error, status = 401) => res.status(status).render('shliach_login', { setup, error });
  if (tooMany(key)) return fail('יותר מדי ניסיונות. נסה שוב בעוד רבע שעה.', 429);
  if (setup) {
    const pw = String(req.body.password || '');
    if (!s.setup_code_hash || !(await bcrypt.compare(String(req.body.code || '').trim(), s.setup_code_hash))) {
      failed(key);
      return fail('קוד ההפעלה שגוי');
    }
    if (pw.length < 8) return fail('הסיסמה צריכה להכיל לפחות 8 תווים', 400);
    if (pw !== req.body.password2) return fail('הסיסמאות אינן תואמות', 400);
    await q('UPDATE shluchim SET password_hash=$1, setup_code_hash=NULL WHERE id=$2', [await bcrypt.hash(pw, 10), s.id]);
  } else if (!(await bcrypt.compare(String(req.body.password || ''), s.password_hash))) {
    failed(key);
    return fail('סיסמה שגויה');
  }
  attempts.delete(key);
  req.session = { shliachId: s.id };
  res.redirect(`${res.locals.base}/dashboard`);
});

router.post('/logout', (req, res) => { req.session = null; res.redirect(`/s/${req.shliach.slug}/login`); });

async function loadPeople(shliachId) {
  const contacts = (await q('SELECT * FROM contacts WHERE shliach_id=$1 ORDER BY first_name, last_name', [shliachId])).rows;
  const family = (await q(`SELECT f.* FROM family_members f JOIN contacts c ON c.id=f.contact_id WHERE c.shliach_id=$1`, [shliachId])).rows;
  return { contacts, family };
}

// כל ימי ההולדת (מקורבים + בני משפחה) בטווח
function collectEvents({ contacts, family }, start, end, mode) {
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const out = [];
  for (const c of contacts) {
    for (const e of eventsInRange(c, start, end, mode)) out.push({ ...e, contact: c, member: null, name: `${c.first_name} ${c.last_name}` });
  }
  for (const f of family) {
    const c = byId.get(f.contact_id);
    for (const e of eventsInRange(f, start, end, mode)) {
      out.push({ ...e, contact: c, member: f, name: `${f.first_name}`, sub: `${f.relation} של ${c.first_name} ${c.last_name}` });
    }
  }
  return out.sort((a, b) => a.date - b.date || a.name.localeCompare(b.name, 'he'));
}

// "נוצר קשר" = קיים רישום יצירת קשר לאותו אדם מ-14 יום לפני יום ההולדת ואילך
async function markContacted(shliachId, events) {
  const { rows } = await q(
    `SELECT l.contact_id, l.family_member_id, l.created_at FROM contact_log l JOIN contacts c ON c.id=l.contact_id
     WHERE c.shliach_id=$1 AND l.created_at > now() - interval '75 days'`, [shliachId]);
  for (const e of events) {
    const from = addDays(e.date, -14);
    e.contacted = rows.some((l) => l.contact_id === e.contact.id && (l.family_member_id ?? null) === (e.member?.id ?? null) && l.created_at >= from);
  }
}

router.get('/dashboard', requireShliach, async (req, res) => {
  const people = await loadPeople(req.shliach.id);
  const today = todayIL();
  const mode = req.shliach.display_mode;
  const w = weekRange(today), m = monthRange(today);
  const week = collectEvents(people, w.start, w.end, mode);
  const month = collectEvents(people, m.start, m.end, mode);
  const upcoming = collectEvents(people, today, addDays(today, 30), mode);
  await markContacted(req.shliach.id, [...week, ...month, ...upcoming]);
  res.render('dashboard', {
    today, week, month, upcoming, weekRange: w, total: people.contacts.length,
    monthName: today.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' }),
    regLink: `${baseUrl(req)}/s/${req.shliach.slug}`,
  });
});

router.get('/contacts', requireShliach, async (req, res) => {
  const term = String(req.query.q || '').trim();
  const { rows } = await q(
    `SELECT c.*, (SELECT count(*) FROM family_members f WHERE f.contact_id=c.id)::int AS fam_count,
            (SELECT max(created_at) FROM contact_log l WHERE l.contact_id=c.id) AS last_contact
     FROM contacts c WHERE shliach_id=$1
       AND ($2 = '' OR (first_name || ' ' || last_name) ILIKE '%' || $2 || '%' OR phone LIKE '%' || $2 || '%')
     ORDER BY first_name, last_name`, [req.shliach.id, term]);
  const today = todayIL();
  for (const c of rows) {
    const n = nextEvents(c, today, req.shliach.display_mode);
    c.next = [n.hebrew, n.gregorian].filter(Boolean).sort((a, b) => a.date - b.date)[0] || null;
  }
  res.render('contacts', { contacts: rows, term });
});

router.get('/contacts/new', requireShliach, (req, res) => {
  res.render('register', { values: { date_type: 'g' }, family: [], error: null, internal: true });
});

router.post('/contacts/new', requireShliach, async (req, res) => {
  const c = parseContact(req.body);
  const fam = c.error ? {} : parseFamily(req.body.fam);
  const error = c.error || fam.error;
  if (error) return res.status(400).render('register', { values: req.body, family: Object.values(req.body.fam || {}), error, internal: true });
  const id = await saveContact(req.shliach.id, c.value, fam.value, 'manual');
  flash(req, 'המקורב נוסף');
  res.redirect(`${res.locals.base}/contacts/${id}`);
});

async function loadContact(req, res, next) {
  const id = parseInt(req.params.id, 10);
  const { rows } = await q('SELECT * FROM contacts WHERE id=$1 AND shliach_id=$2', [id, req.shliach.id]);
  if (!rows[0]) return res.status(404).render('error', { message: 'המקורב לא נמצא' });
  req.contact = rows[0];
  next();
}

router.get('/contacts/:id', requireShliach, loadContact, async (req, res) => {
  const c = req.contact;
  const family = (await q('SELECT * FROM family_members WHERE contact_id=$1 ORDER BY id', [c.id])).rows;
  const log = (await q(
    `SELECT l.*, f.first_name AS member_name FROM contact_log l LEFT JOIN family_members f ON f.id=l.family_member_id
     WHERE l.contact_id=$1 ORDER BY l.created_at DESC`, [c.id])).rows;
  const today = todayIL();
  const mode = req.shliach.display_mode;
  c.nextEv = nextEvents(c, today, mode);
  for (const f of family) f.nextEv = nextEvents(f, today, mode);
  res.render('contact', {
    c, family, log, values: formValues(c), wa: whatsappLink(c.phone),
    fmtTime: (t) => new Date(t).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }),
    error: req.query.err || null,
  });
});

router.post('/contacts/:id', requireShliach, loadContact, async (req, res) => {
  const c = parseContact(req.body);
  const url = `${res.locals.base}/contacts/${req.contact.id}`;
  if (c.error) return res.redirect(`${url}?err=${encodeURIComponent(c.error)}#edit`);
  const v = c.value;
  await q(`UPDATE contacts SET first_name=$1, last_name=$2, phone=$3, notes=$4, g_date=$5, g_after_sunset=$6, h_day=$7, h_month=$8, h_year=$9
           WHERE id=$10`, [v.first_name, v.last_name, v.phone, v.notes, v.g_date, v.g_after_sunset, v.h_day, v.h_month, v.h_year, req.contact.id]);
  flash(req, 'הפרטים עודכנו');
  res.redirect(url);
});

router.post('/contacts/:id/delete', requireShliach, loadContact, async (req, res) => {
  await q('DELETE FROM contacts WHERE id=$1', [req.contact.id]);
  flash(req, 'המקורב נמחק');
  res.redirect(`${res.locals.base}/contacts`);
});

router.post('/contacts/:id/family', requireShliach, loadContact, async (req, res) => {
  const url = `${res.locals.base}/contacts/${req.contact.id}`;
  const fam = parseFamily([req.body]);
  if (fam.error || !fam.value.length) return res.redirect(`${url}?err=${encodeURIComponent(fam.error || 'יש להזין שם')}#family`);
  await addFamily(req.contact.id, fam.value[0]);
  flash(req, 'בן המשפחה נוסף');
  res.redirect(url + '#family');
});

router.post('/contacts/:id/family/:fid/delete', requireShliach, loadContact, async (req, res) => {
  await q('DELETE FROM family_members WHERE id=$1 AND contact_id=$2', [parseInt(req.params.fid, 10), req.contact.id]);
  res.redirect(`${res.locals.base}/contacts/${req.contact.id}#family`);
});

// "יצרתי קשר"
router.post('/contacts/:id/log', requireShliach, loadContact, async (req, res) => {
  let fid = parseInt(req.body.family_member_id, 10) || null;
  if (fid) {
    const ok = await q('SELECT 1 FROM family_members WHERE id=$1 AND contact_id=$2', [fid, req.contact.id]);
    if (!ok.rowCount) fid = null;
  }
  await q('INSERT INTO contact_log (contact_id, family_member_id, note) VALUES ($1,$2,$3)',
    [req.contact.id, fid, String(req.body.note || '').trim().slice(0, 500)]);
  flash(req, 'נרשם שנוצר קשר ✓');
  const back = req.body.back === 'dashboard' ? `${res.locals.base}/dashboard` : `${res.locals.base}/contacts/${req.contact.id}#log`;
  res.redirect(back);
});

router.post('/contacts/:id/log/:lid/delete', requireShliach, loadContact, async (req, res) => {
  await q('DELETE FROM contact_log WHERE id=$1 AND contact_id=$2', [parseInt(req.params.lid, 10), req.contact.id]);
  res.redirect(`${res.locals.base}/contacts/${req.contact.id}#log`);
});

router.get('/settings', requireShliach, (req, res) => res.render('settings', { error: null }));

router.post('/settings', requireShliach, async (req, res) => {
  const s = req.shliach;
  if (req.body.action === 'mode') {
    const mode = ['both', 'hebrew', 'gregorian'].includes(req.body.display_mode) ? req.body.display_mode : 'both';
    await q('UPDATE shluchim SET display_mode=$1 WHERE id=$2', [mode, s.id]);
    flash(req, 'ההגדרה נשמרה');
    return res.redirect(`${res.locals.base}/settings`);
  }
  const pw = String(req.body.password || '');
  if (!(await bcrypt.compare(String(req.body.current || ''), s.password_hash))) return res.status(400).render('settings', { error: 'הסיסמה הנוכחית שגויה' });
  if (pw.length < 8) return res.status(400).render('settings', { error: 'הסיסמה צריכה להכיל לפחות 8 תווים' });
  if (pw !== req.body.password2) return res.status(400).render('settings', { error: 'הסיסמאות אינן תואמות' });
  await q('UPDATE shluchim SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(pw, 10), s.id]);
  flash(req, 'הסיסמה עודכנה');
  res.redirect(`${res.locals.base}/settings`);
});

app.get('/health', (req, res) => res.send('ok'));
app.use((req, res) => res.status(404).render('error', { message: 'הדף לא נמצא' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'אירעה שגיאה. נסה שוב.' });
});

export { app };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`listening on ${port}`));
}
