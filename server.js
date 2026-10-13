import express from 'express';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, migrate } from './lib/db.js';
import {
  HEB_MONTHS, HEB_DAYS, DAY_NAMES, todayIL, nextBirthday, weekRange, hebMonthRange,
  hebToday, addDays, fmtGreg, hebFromGreg, parseISO,
} from './lib/dates.js';

const hebFromGregObj = (iso) => { const h = hebFromGreg(parseISO(iso), false); return { h_day: h.day, h_month: h.month, h_year: h.year }; };
import { loadPeople, collectEvents } from './lib/events.js';
import { smsConfigured, normalizePhone, sendToShliach, sendReminder, weeklyMessageFor, previewKind, startScheduler, quotaStatus, getDefaultQuota, setDefaultQuota } from './lib/sms.js';
import { strongEnough, otpSendByIp, otpSendByAccount, loginByIp, loginByAccount, registerByIp, registerByLink, storeReveal, takeReveal } from './lib/security.js';
import { parseContact, parseFamily, birthText, formValues, whatsappLink, RELATIONS } from './lib/person.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROD = process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error('חובה להגדיר ADMIN_PASSWORD ו-SESSION_SECRET');
  process.exit(1);
}
// סיסמת המנהל פותחת גישה (עקיפה) לכל השלוחים — חובה שתהיה חזקה
// 8 תווים לפחות (גם 8 ספרות מספיק — ההגבלה לפי חשבון חוסמת ניחוש), לא תו חוזר ולא רצף
if (PROD && !strongEnough(ADMIN_PASSWORD, 8)) {
  console.error('ADMIN_PASSWORD חלשה מדי: נדרשים לפחות 8 תווים, לא רצף (12345678) ולא תו חוזר');
  process.exit(1);
}
if (PROD && SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET קצר מדי: נדרשים לפחות 32 תווים אקראיים');
  process.exit(1);
}
const ADMIN_SESSION_MS = 12 * 3600 * 1000;

// פלטת הסיווגים מחבילת העיצוב (styleguide)
const DEFAULT_CATEGORIES = [
  ['מקורב קרוב', '#4F6BD8'], ['משתתף בשיעורים', '#2E9E6B'], ['תורם', '#C98A1A'], ['חדש', '#9A5BC9'],
];
const COLORS = ['#4F6BD8', '#2E9E6B', '#C98A1A', '#9A5BC9', '#D2475B', '#1A93A8', '#6B6F7B'];

// סקריפטים רק מהאתר עצמו (בלי inline); style-attribute נדרש לצבעי הסיווגים
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  "manifest-src 'self'", "worker-src 'self'",
].join('; ');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '1d' : 0 }));
app.use(cookieSession({
  name: 'mk', keys: [SESSION_SECRET], httpOnly: true, sameSite: 'lax', secure: PROD,
  maxAge: 90 * 24 * 3600 * 1000,
}));
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', CSP);
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000');
  Object.assign(res.locals, { HEB_MONTHS, HEB_DAYS, RELATIONS, COLORS, DAY_NAMES, birthText, fmtGreg, flash: req.session.flash });
  req.session.flash = undefined;
  next();
});

const flash = (req, msg) => { req.session.flash = msg; };
const flashErr = (req, msg) => { req.session.flash = { err: msg }; };
const randomToken = (bytes) => crypto.randomBytes(bytes).toString('base64url');
// 6 ספרות אקראיות, שאינן רצף או ספרה חוזרת (כדי לעבור את validCode)
function randomCode() {
  for (;;) {
    const c = String(crypto.randomInt(100000, 1000000));
    if (strongEnough(c, 6)) return c;
  }
}
const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const int = (v) => parseInt(v, 10) || null;
const fmtDate = (t) => new Date(t).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });


/* ------------------------------ דף ראשי ומנהל ------------------------------ */

// דוגמאות חיות לדף הבית
function homeExamples() {
  const today = todayIL();
  const a = { g_date: '1990-10-20', ...hebFromGregObj('1990-10-20') };
  const b = { h_day: 14, h_month: 13, h_year: 5745 };
  const c = { h_day: 30, h_month: 8, h_year: null };
  return [a, b, c].map((p) => ({ ...p, text: birthText(p), next: nextBirthday(p, today) }));
}

app.get('/', (req, res) => res.render('home', { examples: homeExamples() }));

// "שמירה כאפליקציה" (PWA): מניפסט כללי, ומניפסט אישי לכל שליח שנפתח ישר לדשבורד שלו
function manifest({ name, short, start, scope }) {
  return {
    name, short_name: short, start_url: start, scope, id: start,
    description: 'ימי הולדת עבריים של המקורבים — דשבורד, תזכורות ויצירת קשר',
    display: 'standalone', dir: 'rtl', lang: 'he',
    background_color: '#F7F4EE', theme_color: '#C98A1A',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').send(manifest({ name: 'ימי הולדת למקורבים', short: 'ימי הולדת', start: '/admin', scope: '/' }));
});

app.get('/admin/login', (req, res) => {
  if (req.session.admin > Date.now()) return res.redirect('/admin');
  res.render('admin_login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const ipKey = 'admin:' + req.ip;
  if (loginByIp.blocked(ipKey) || loginByAccount.blocked('admin')) {
    return res.status(429).render('admin_login', { error: 'יותר מדי ניסיונות. נסה שוב מאוחר יותר.' });
  }
  if (!crypto.timingSafeEqual(sha(req.body.password || ''), sha(ADMIN_PASSWORD))) {
    loginByIp.hit(ipKey);
    loginByAccount.hit('admin');
    return res.status(401).render('admin_login', { error: 'סיסמה שגויה' });
  }
  loginByIp.reset(ipKey);
  req.session.admin = Date.now() + ADMIN_SESSION_MS; // תוקף, לא רק true
  res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => { req.session.admin = undefined; res.redirect('/'); });

function requireAdmin(req, res, next) {
  if (!(req.session.admin > Date.now())) { req.session.admin = undefined; return res.redirect('/admin/login'); }
  next();
}

// המנהל רואה רק שם, קישור וסטטוס — לא את נתוני המקורבים
app.get('/admin', requireAdmin, async (req, res) => {
  const { rows } = await q(`SELECT id, name, chabad_house, slug, active, created_at, access_code_hash IS NOT NULL AS has_code,
                              sms_weekly, sms_daily, sms_quota, sms_used_birthdays, sms_alert_threshold, phone
                            FROM shluchim ORDER BY created_at DESC`);
  const info = takeReveal(req.session.reveal);
  req.session.reveal = undefined;
  res.render('admin', { shluchim: rows, base: baseUrl(req), info, smsOn: smsConfigured(), defaultQuota: await getDefaultQuota(), quotaStatus });
});

// מכסת יחידות SMS לתזכורות ימי הולדת: ברירת מחדל לשלוחים חדשים, ולכל שליח מכסה משלו שהמנהל מוסיף לה
const MAX_QUOTA = 100000;
function parseQuota(v) {
  const t = String(v ?? '').trim();
  if (t === '') return { value: null };
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= MAX_QUOTA ? { value: n } : { error: 'מכסה צריכה להיות מספר שלם 0 ומעלה' };
}

app.post('/admin/sms-quota', requireAdmin, async (req, res) => {
  const { value, error } = parseQuota(req.body.quota);
  if (error || value === null) { flashErr(req, error || 'יש להזין מכסה'); return res.redirect('/admin'); }
  await setDefaultQuota(value);
  flash(req, `ברירת המחדל עודכנה: ${value} יחידות SMS לכל שליח חדש`);
  res.redirect('/admin');
});

// הוספת יחידות למכסה, קביעת מכסה כוללת, וסף התראה (ריק = 10% מהמכסה)
app.post('/admin/shluchim/:id/quota', requireAdmin, async (req, res) => {
  const id = int(req.params.id);
  const add = parseQuota(req.body.add), set = parseQuota(req.body.quota), th = parseQuota(req.body.threshold);
  const err = add.error || set.error || th.error;
  if (err) { flashErr(req, err); return res.redirect('/admin'); }
  if (add.value) await q('UPDATE shluchim SET sms_quota = least(sms_quota + $1, $3) WHERE id=$2', [add.value, id, MAX_QUOTA]);
  if (set.value !== null) await q('UPDATE shluchim SET sms_quota=$1 WHERE id=$2', [set.value, id]);
  if (req.body.threshold !== undefined) await q('UPDATE shluchim SET sms_alert_threshold=$1 WHERE id=$2', [th.value, id]);
  // יחידות חדשות — מנקים את שגיאת "המכסה נגמרה"
  await q(`UPDATE shluchim SET sms_last_error=NULL WHERE id=$1 AND sms_used_birthdays < sms_quota AND sms_last_error LIKE 'יתרת ה-SMS%'`, [id]);
  const { rows } = await q('SELECT sms_quota, sms_used_birthdays, sms_alert_threshold FROM shluchim WHERE id=$1', [id]);
  if (rows[0]) { const st = quotaStatus(rows[0]); flash(req, `המכסה עודכנה: ${st.quota} יחידות, נוצלו ${st.used}, יתרה ${st.left} (התראה מתחת ל-${st.threshold})`); }
  res.redirect('/admin');
});

// לפחות 6 תווים, ולא תו אחד שחוזר (000000) או רצף (123456)
function validCode(code) {
  return /^\S{6,32}$/.test(code) && strongEnough(code, 6);
}
const CODE_RULE = 'הקוד צריך להכיל 6–32 תווים, ללא רווחים, ולא רצף או תו חוזר';

// כניסה תמיד בקוד: לכל שליח קוד קבוע, ובנוסף אפשר לבקש קוד חד-פעמי ב-SMS לנייד שלו.
// קביעת קוד מעלה את session_version — וכך מנתקת את כל הסשנים הקיימים של השליח
async function setCode(req, id, code) {
  const { rows } = await q(
    `UPDATE shluchim SET access_code_hash=$1, session_version=session_version+1
     WHERE id=$2 RETURNING id, name, chabad_house, slug, phone`,
    [await bcrypt.hash(code, 12), id]);
  if (rows[0]) req.session.reveal = storeReveal({ ...rows[0], code }); // בעוגייה רק מזהה
  return rows[0];
}

const shliachUrl = (req, slug) => `${baseUrl(req)}/s/${slug}`;

// SMS עם הקישור האישי לשליח. הקוד הקבוע נכלל רק ברגע שנקבע (אחר כך השרת לא יודע אותו)
function welcomeMessage(s, url, code, isNew) {
  const intro = isNew ? 'נפתח עבורך חשבון במערכת "ימי הולדת למקורבים".' : (code ? 'קוד הכניסה שלך למערכת "ימי הולדת למקורבים" עודכן.' : 'הקישור שלך למערכת "ימי הולדת למקורבים":');
  const lines = [`שלום ${s.name}! 🎂`, intro, isNew || code ? `הקישור האישי שלך:\n${url}` : url];
  if (code) lines.push(`קוד הכניסה: ${code}`, '(אפשר להחליף אותו בהגדרות)');
  lines.push('אפשר גם להיכנס עם קוד חד-פעמי שיישלח לנייד הזה.');
  return lines.join('\n');
}

async function sendWelcome(req, s, code, isNew = false) {
  if (!smsConfigured()) return { ok: false, error: 'SMS לא מוגדר' };
  try {
    await sendToShliach(s, s.phone, welcomeMessage(s, shliachUrl(req, s.slug), code, isNew), 'admin');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function codeFrom(req) {
  const code = String(req.body.code || '').trim() || randomCode();
  return validCode(code) ? code : null;
}

app.post('/admin/shluchim', requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) { flashErr(req, 'יש להזין שם'); return res.redirect('/admin'); }
  const house = String(req.body.chabad_house || '').trim().slice(0, 80);
  const phone = normalizePhone(req.body.phone);
  if (!phone) { flashErr(req, 'יש להזין מספר נייד תקין של השליח (05X-XXXXXXX)'); return res.redirect('/admin'); }
  const code = codeFrom(req);
  if (!code) { flashErr(req, CODE_RULE); return res.redirect('/admin'); }
  const quota = parseQuota(req.body.sms_quota);
  if (quota.error) { flashErr(req, quota.error); return res.redirect('/admin'); }
  if (quota.value === null) quota.value = await getDefaultQuota();
  // הנייד של השליח משמש גם כברירת מחדל ל-SMS השבועי (שהשליח מפעיל בעצמו)
  const { rows } = await q('INSERT INTO shluchim (name, chabad_house, slug, phone, sms_phone, sms_quota) VALUES ($1,$2,$3,$4,$4,$5) RETURNING id', [name, house, randomToken(9), phone, quota.value]);
  const id = rows[0].id;
  for (const [i, [n, c]] of DEFAULT_CATEGORIES.entries()) {
    await q('INSERT INTO categories (shliach_id, name, color, sort) VALUES ($1,$2,$3,$4)', [id, n, c, i]);
  }
  const s = await setCode(req, id, code);
  const sent = await sendWelcome(req, s, code, true);
  if (sent.ok) flash(req, `החשבון נוצר, והקישור והקוד נשלחו ב-SMS ל-${phone}`);
  else flashErr(req, `החשבון נוצר, אבל ה-SMS לא נשלח (${sent.error}) — אפשר לשלוח בוואטסאפ`);
  res.redirect('/admin');
});

// קוד קבוע חדש (ריק = אקראי) ושליחתו ב-SMS
app.post('/admin/shluchim/:id/code', requireAdmin, async (req, res) => {
  const code = codeFrom(req);
  if (!code) { flashErr(req, CODE_RULE); return res.redirect('/admin'); }
  const s = await setCode(req, int(req.params.id), code);
  if (!s) return res.redirect('/admin');
  const sent = s.phone ? await sendWelcome(req, s, code) : { ok: false, error: 'לשליח אין נייד' };
  const msg = 'הקוד הוחלף וכל המכשירים המחוברים נותקו.';
  if (sent.ok) flash(req, `${msg} הקישור והקוד נשלחו ב-SMS ל-${s.phone}`); else flashErr(req, `${msg} ה-SMS לא נשלח (${sent.error})`);
  res.redirect('/admin');
});

// שליחה חוזרת של הקישור בלבד (את הקוד הקבוע השרת לא יודע — שומר רק hash)
app.post('/admin/shluchim/:id/send-link', requireAdmin, async (req, res) => {
  const { rows } = await q('SELECT id, name, slug, phone FROM shluchim WHERE id=$1', [int(req.params.id)]);
  const s = rows[0];
  if (!s) return res.redirect('/admin');
  if (!s.phone) { flashErr(req, 'לשליח אין נייד'); return res.redirect('/admin'); }
  const sent = await sendWelcome(req, s, null);
  if (sent.ok) flash(req, `הקישור נשלח ב-SMS ל-${s.phone}`); else flashErr(req, `ה-SMS לא נשלח: ${sent.error}`);
  res.redirect('/admin');
});

app.post('/admin/shluchim/:id/house', requireAdmin, async (req, res) => {
  await q('UPDATE shluchim SET chabad_house=$1 WHERE id=$2', [String(req.body.chabad_house || '').trim().slice(0, 80), int(req.params.id)]);
  flash(req, 'שם בית חב״ד עודכן');
  res.redirect('/admin');
});

app.post('/admin/shluchim/:id/phone', requireAdmin, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) { flashErr(req, 'מספר הנייד אינו תקין'); return res.redirect('/admin'); }
  // שינוי נייד = שינוי היעד של קודי הכניסה — מנתקים סשנים קיימים
  await q(`UPDATE shluchim SET phone=$1, sms_phone=CASE WHEN sms_phone='' THEN $1 ELSE sms_phone END, session_version=session_version+1 WHERE id=$2`, [phone, int(req.params.id)]);
  flash(req, 'הטלפון עודכן');
  res.redirect('/admin');
});

app.post('/admin/shluchim/:id/toggle', requireAdmin, async (req, res) => {
  await q('UPDATE shluchim SET active = NOT active WHERE id=$1', [int(req.params.id)]);
  res.redirect('/admin');
});

/* ----------------------------- שמירת מקורבים ----------------------------- */

async function validCategory(shliachId, id) {
  if (!id) return null;
  const { rowCount } = await q('SELECT 1 FROM categories WHERE id=$1 AND shliach_id=$2', [id, shliachId]);
  return rowCount ? id : null;
}

async function saveContact(shliachId, c, family, regLinkId) {
  const { rows } = await q(
    `INSERT INTO contacts (shliach_id, first_name, last_name, phone, notes, g_date, g_after_sunset, h_day, h_month, h_year, category_id, reg_link_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [shliachId, c.first_name, c.last_name, c.phone, c.notes, c.g_date, c.g_after_sunset, c.h_day, c.h_month, c.h_year,
      await validCategory(shliachId, c.category_id), regLinkId]);
  for (const f of family) await addFamily(rows[0].id, f);
  return rows[0].id;
}

const addFamily = (contactId, f) => q(
  `INSERT INTO family_members (contact_id, relation, first_name, g_date, g_after_sunset, h_day, h_month, h_year)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [contactId, f.relation, f.first_name, f.g_date, f.g_after_sunset, f.h_day, f.h_month, f.h_year]);

function parseForm(body) {
  const c = parseContact(body);
  const fam = c.error ? {} : parseFamily(body.fam);
  return { c: c.value, fam: fam.value, error: c.error || fam.error };
}

/* ------------------------- קישור רישום ציבורי למקורבים ------------------------- */

app.use('/r/:token', async (req, res, next) => {
  const { rows } = await q(
    `SELECT l.*, s.name AS shliach_name FROM reg_links l JOIN shluchim s ON s.id=l.shliach_id
     WHERE l.token=$1 AND l.active AND s.active`, [req.params.token]);
  if (!rows[0]) return res.status(404).render('error', { message: 'קישור הרישום אינו פעיל' });
  req.link = res.locals.link = rows[0];
  res.locals.noApp = true; // דפי רישום למקורבים — בלי הצעת התקנה
  next();
});

app.get('/r/:token', (req, res) => res.render('register', { values: { date_type: 'h' }, family: [], error: null, internal: false }));

app.post('/r/:token', async (req, res) => {
  if (req.body.website) return res.render('register_done'); // מלכודת לבוטים
  if (!registerByIp.take(`reg:${req.ip}`) || !registerByLink.take(`link:${req.link.id}`)) {
    return res.status(429).render('register', {
      values: req.body, family: Object.values(req.body.fam || {}), internal: false,
      error: 'נשלחו יותר מדי רישומים. נסו שוב בעוד כמה דקות.',
    });
  }
  const { c, fam, error } = parseForm(req.body);
  if (error) return res.status(400).render('register', { values: req.body, family: Object.values(req.body.fam || {}), error, internal: false });
  c.category_id = req.link.category_id;
  c.notes = '';
  await saveContact(req.link.shliach_id, c, fam, req.link.id);
  res.render('register_done');
});

/* ---------------------------------- שליח ---------------------------------- */

const router = express.Router({ mergeParams: true });
app.use('/s/:slug', router);

router.use(async (req, res, next) => {
  const { rows } = await q('SELECT * FROM shluchim WHERE slug=$1 AND active', [req.params.slug]);
  if (!rows[0]) return res.status(404).render('error', { message: 'הקישור אינו פעיל' });
  const s = rows[0];
  req.shliach = res.locals.shliach = s;
  res.locals.base = `/s/${s.slug}`;
  res.locals.manifestUrl = `/s/${s.slug}/manifest.webmanifest`;
  const sh = req.session.sh && !Array.isArray(req.session.sh) ? req.session.sh : {};
  req.authorized = sh[s.id] === s.session_version; // תמיד נדרשת כניסה בקוד
  next();
});

const requireShliach = (req, res, next) => (req.authorized ? next() : res.redirect(res.locals.base));

router.get('/manifest.webmanifest', (req, res) => {
  const b = res.locals.base;
  res.type('application/manifest+json').send(manifest({ name: `ימי הולדת — ${req.shliach.name}`, short: 'ימי הולדת', start: b, scope: b }));
});

async function loadCategories(shliachId) {
  return (await q('SELECT * FROM categories WHERE shliach_id=$1 ORDER BY sort, id', [shliachId])).rows;
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

// דשבורד (או מסך קוד כניסה)
const VIEWS = ['today', 'week', 'month', '30'];
router.get('/', async (req, res) => {
  if (!req.authorized) return renderLogin(req, res);
  const s = req.shliach;
  const categories = await loadCategories(s.id);
  const cat = int(req.query.cat);
  const view = VIEWS.includes(req.query.view) ? req.query.view : 'week';
  const people = await loadPeople(s.id);
  const today = todayIL();
  const w = weekRange(today), m = hebMonthRange(today), end30 = addDays(today, 29);
  const from = new Date(Math.min(w.start, m.start, addDays(today, -14)));
  const to = new Date(Math.max(w.end, m.end, end30));
  const all = collectEvents(people, from, to);
  await markContacted(s.id, all);
  const inR = (e, a, b) => e.date >= a && e.date <= b;
  const same = (e) => e.date.getTime() === today.getTime();
  const lists = {
    today: all.filter(same),
    week: all.filter((e) => inR(e, w.start, w.end)),
    month: all.filter((e) => inR(e, m.start, m.end)),
    30: all.filter((e) => inR(e, today, end30)),
  };
  const overdue = all.filter((e) => e.date < today && e.date >= addDays(today, -14) && !e.contacted);
  const upcoming = all.filter((e) => e.date > w.end).slice(0, 5);
  const next = all.find((e) => e.date > today);
  const list = lists[view].filter((e) => !cat || e.contact.category_id === cat);
  res.render('dashboard', {
    sms: { ...quotaStatus(s), on: s.sms_weekly || s.sms_daily, weekly: s.sms_weekly, daily: s.sms_daily },
    today, hebToday: hebToday(today), view, cat, categories, catById: new Map(categories.map((c) => [c.id, c])),
    lists, list, overdue, upcoming, next, weekRange: w, monthRange: m, end30,
    total: people.contacts.length, familyTotal: people.family.length,
    qs: (o) => { const p = new URLSearchParams({ view, ...(cat ? { cat } : {}), ...o }); for (const [k, v] of [...p]) if (v === '' || v === 'null') p.delete(k); return `?${p}`; },
  });
});

// מסך הכניסה: קוד קבוע, או קוד חד-פעמי שנשלח ב-SMS (אותו שדה)
const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;
const maskPhone = (p) => (p ? `${p.slice(0, 3)}-•••-${p.slice(-4)}` : '');
function renderLogin(req, res, error = null, status = 200) {
  const s = req.shliach;
  const otpSent = req.session.otp?.id === s.id && req.session.otp.at > Date.now() - OTP_TTL_MIN * 60 * 1000;
  res.status(status).render('shliach_login', {
    error, otpSent, maskedPhone: maskPhone(s.phone), canOtp: !!s.phone && smsConfigured(),
  });
}

router.post('/otp/send', async (req, res) => {
  const s = req.shliach;
  if (!s.phone || !smsConfigured()) return renderLogin(req, res, 'לא ניתן לשלוח קוד כרגע. פנו למנהל המערכת.', 503);
  if (!otpSendByIp.take(`otp:${req.ip}`) || !otpSendByAccount.take(`otp:s${s.id}`)) {
    return renderLogin(req, res, 'נשלחו יותר מדי קודים. נסו שוב בעוד כמה דקות.', 429);
  }
  const code = String(crypto.randomInt(100000, 1000000));
  // קוד חדש מבטל את הקודמים
  await q('UPDATE login_codes SET used=TRUE WHERE shliach_id=$1 AND NOT used', [s.id]);
  await q(`INSERT INTO login_codes (shliach_id, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [s.id, await bcrypt.hash(code, 10), OTP_TTL_MIN]);
  await q(`DELETE FROM login_codes WHERE created_at < now() - interval '1 day'`);
  try {
    await sendToShliach(s, s.phone, `קוד הכניסה שלך ל"ימי הולדת למקורבים": ${code}\nבתוקף ${OTP_TTL_MIN} דקות. אין למסור אותו לאף אחד.`, 'otp');
  } catch (e) {
    console.error(`OTP לשליח ${s.id} נכשל:`, e.message);
    return renderLogin(req, res, 'שליחת ה-SMS נכשלה. נסו שוב בעוד רגע.', 502);
  }
  req.session.otp = { id: s.id, at: Date.now() };
  res.redirect(res.locals.base);
});

async function checkOtp(shliachId, code) {
  const { rows } = await q(
    `UPDATE login_codes SET attempts=attempts+1
     WHERE id=(SELECT id FROM login_codes WHERE shliach_id=$1 AND NOT used AND expires_at > now() ORDER BY created_at DESC LIMIT 1)
       AND attempts < $2
     RETURNING id, code_hash`, [shliachId, OTP_MAX_ATTEMPTS]);
  if (!rows[0]) return 'expired';
  if (!/^\d{6}$/.test(code) || !(await bcrypt.compare(code, rows[0].code_hash))) return 'wrong';
  await q('UPDATE login_codes SET used=TRUE WHERE id=$1', [rows[0].id]);
  return 'ok';
}

router.post('/login', async (req, res) => {
  const s = req.shliach;
  const ipKey = `s${s.id}:${req.ip}`;
  const acctKey = `s${s.id}`;
  if (loginByIp.blocked(ipKey) || loginByAccount.blocked(acctKey)) {
    return renderLogin(req, res, 'יותר מדי ניסיונות. נסה שוב מאוחר יותר.', 429);
  }
  const code = String(req.body.code || '').trim();
  // קודם הקוד הקבוע; אם לא תאם — קוד חד-פעמי פעיל (אם נשלח)
  let ok = !!s.access_code_hash && (await bcrypt.compare(code, s.access_code_hash));
  let otp = null;
  if (!ok) { otp = await checkOtp(s.id, code); ok = otp === 'ok'; }
  if (!ok) {
    loginByIp.hit(ipKey);
    loginByAccount.hit(acctKey); // נספר לחשבון מכל IP — החלפת כתובות לא עוקפת
    if (otp === 'expired' && req.session.otp?.id === s.id) {
      req.session.otp = undefined;
      return renderLogin(req, res, 'הקוד שגוי, והקוד החד-פעמי פג תוקף או שנוצלו כל הניסיונות. אפשר לשלוח קוד חדש.', 401);
    }
    return renderLogin(req, res, 'קוד שגוי', 401);
  }
  loginByIp.reset(ipKey);
  req.session.otp = undefined;
  // כניסה בקוד חד-פעמי (למשל כששכחו את הקוד) מאפשרת לקבוע קוד חדש ב-15 הדקות הקרובות בלי הקוד הנוכחי
  req.session.otpLogin = otp === 'ok' ? { id: s.id, at: Date.now() } : undefined;
  req.session.sh = { ...(Array.isArray(req.session.sh) ? {} : req.session.sh), [s.id]: s.session_version };
  res.redirect(res.locals.base);
});

router.post('/logout', (req, res) => {
  if (req.session.sh && !Array.isArray(req.session.sh)) {
    const { [req.shliach.id]: _, ...rest } = req.session.sh;
    req.session.sh = rest;
  }
  res.redirect(res.locals.base);
});

router.use(requireShliach);

/* ------------------------------ מקורבים ------------------------------ */

router.get('/contacts', async (req, res) => {
  const term = String(req.query.q || '').trim().replace(/[%_\\]/g, '');
  const cat = int(req.query.cat);
  const { rows } = await q(
    `SELECT c.*, (SELECT count(*) FROM family_members f WHERE f.contact_id=c.id)::int AS fam_count,
            (SELECT max(created_at) FROM contact_log l WHERE l.contact_id=c.id) AS last_contact
     FROM contacts c WHERE shliach_id=$1
       AND ($2 = '' OR (first_name || ' ' || last_name) ILIKE '%' || $2 || '%' OR phone LIKE '%' || $2 || '%')
       AND ($3::int IS NULL OR category_id = $3)
     ORDER BY first_name, last_name`, [req.shliach.id, term, cat]);
  const today = todayIL();
  for (const c of rows) c.next = nextBirthday(c, today);
  if (req.query.sort === 'next') rows.sort((a, b) => (a.next?.date ?? Infinity) - (b.next?.date ?? Infinity));
  const categories = await loadCategories(req.shliach.id);
  res.render('contacts', { contacts: rows, term, cat, sort: req.query.sort || '', categories, catById: new Map(categories.map((c) => [c.id, c])), fmtDate });
});

router.get('/contacts/new', async (req, res) => {
  res.render('register', { values: { date_type: 'h' }, family: [], error: null, internal: true, categories: await loadCategories(req.shliach.id) });
});

router.post('/contacts/new', async (req, res) => {
  const { c, fam, error } = parseForm(req.body);
  if (error) {
    return res.status(400).render('register', {
      values: req.body, family: Object.values(req.body.fam || {}), error, internal: true, categories: await loadCategories(req.shliach.id),
    });
  }
  const id = await saveContact(req.shliach.id, c, fam, null);
  flash(req, 'המקורב נוסף');
  res.redirect(`${res.locals.base}/contacts/${id}`);
});

async function loadContact(req, res, next) {
  const { rows } = await q('SELECT * FROM contacts WHERE id=$1 AND shliach_id=$2', [int(req.params.id), req.shliach.id]);
  if (!rows[0]) return res.status(404).render('error', { message: 'המקורב לא נמצא' });
  req.contact = rows[0];
  next();
}

router.get('/contacts/:id', loadContact, async (req, res) => {
  const c = req.contact;
  const family = (await q('SELECT * FROM family_members WHERE contact_id=$1 ORDER BY id', [c.id])).rows;
  const log = (await q(
    `SELECT l.*, f.first_name AS member_name FROM contact_log l LEFT JOIN family_members f ON f.id=l.family_member_id
     WHERE l.contact_id=$1 ORDER BY l.created_at DESC`, [c.id])).rows;
  const link = c.reg_link_id ? (await q('SELECT name FROM reg_links WHERE id=$1', [c.reg_link_id])).rows[0] : null;
  const today = todayIL();
  c.next = nextBirthday(c, today);
  for (const f of family) f.next = nextBirthday(f, today);
  res.render('contact', {
    c, family, log, link, values: formValues(c), wa: whatsappLink(c.phone), categories: await loadCategories(req.shliach.id), fmtDate,
    fmtTime: (t) => new Date(t).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }),
    error: req.query.err || null,
  });
});

router.post('/contacts/:id', loadContact, async (req, res) => {
  const c = parseContact(req.body);
  const url = `${res.locals.base}/contacts/${req.contact.id}`;
  if (c.error) return res.redirect(`${url}?err=${encodeURIComponent(c.error)}#edit`);
  const v = c.value;
  await q(`UPDATE contacts SET first_name=$1, last_name=$2, phone=$3, notes=$4, g_date=$5, g_after_sunset=$6, h_day=$7, h_month=$8, h_year=$9, category_id=$10
           WHERE id=$11`, [v.first_name, v.last_name, v.phone, v.notes, v.g_date, v.g_after_sunset, v.h_day, v.h_month, v.h_year,
    await validCategory(req.shliach.id, v.category_id), req.contact.id]);
  flash(req, 'הפרטים עודכנו');
  res.redirect(url);
});

router.post('/contacts/:id/category', loadContact, async (req, res) => {
  await q('UPDATE contacts SET category_id=$1 WHERE id=$2', [await validCategory(req.shliach.id, int(req.body.category_id)), req.contact.id]);
  flash(req, 'הסיווג עודכן');
  res.redirect(`${res.locals.base}/contacts/${req.contact.id}`);
});

router.post('/contacts/:id/delete', loadContact, async (req, res) => {
  await q('DELETE FROM contacts WHERE id=$1', [req.contact.id]);
  flash(req, 'המקורב נמחק');
  res.redirect(`${res.locals.base}/contacts`);
});

router.post('/contacts/:id/family', loadContact, async (req, res) => {
  const url = `${res.locals.base}/contacts/${req.contact.id}`;
  const fam = parseFamily([req.body]);
  if (fam.error || !fam.value.length) return res.redirect(`${url}?err=${encodeURIComponent(fam.error || 'יש להזין שם')}#family`);
  await addFamily(req.contact.id, fam.value[0]);
  flash(req, 'בן המשפחה נוסף');
  res.redirect(url + '#family');
});

router.post('/contacts/:id/family/:fid/delete', loadContact, async (req, res) => {
  await q('DELETE FROM family_members WHERE id=$1 AND contact_id=$2', [int(req.params.fid), req.contact.id]);
  res.redirect(`${res.locals.base}/contacts/${req.contact.id}#family`);
});

// "יצרתי קשר"
router.post('/contacts/:id/log', loadContact, async (req, res) => {
  let fid = int(req.body.family_member_id);
  if (fid) {
    const ok = await q('SELECT 1 FROM family_members WHERE id=$1 AND contact_id=$2', [fid, req.contact.id]);
    if (!ok.rowCount) fid = null;
  }
  await q('INSERT INTO contact_log (contact_id, family_member_id, note) VALUES ($1,$2,$3)',
    [req.contact.id, fid, String(req.body.note || '').trim().slice(0, 500)]);
  flash(req, 'נרשם שנוצר קשר ✓');
  const qsBack = String(req.body.back || '');
  const back = qsBack === 'dashboard' || qsBack.startsWith('?')
    ? res.locals.base + (qsBack.startsWith('?') ? qsBack.slice(0, 200) : '')
    : `${res.locals.base}/contacts/${req.contact.id}#log`;
  res.redirect(back);
});

// ביטול "נוצר קשר" מהדשבורד: מוחק את הרישומים לאותו אדם מ-14 יום לפני יום ההולדת
router.post('/contacts/:id/unlog', loadContact, async (req, res) => {
  const d = parseISO(String(req.body.date || ''));
  if (d) {
    await q(`DELETE FROM contact_log WHERE contact_id=$1 AND family_member_id IS NOT DISTINCT FROM $2 AND created_at >= $3`,
      [req.contact.id, int(req.body.family_member_id), addDays(d, -14)]);
    flash(req, 'הסימון בוטל');
  }
  res.redirect(res.locals.base + (String(req.body.back || '').startsWith('?') ? String(req.body.back).slice(0, 200) : ''));
});

router.post('/contacts/:id/log/:lid/delete', loadContact, async (req, res) => {
  await q('DELETE FROM contact_log WHERE id=$1 AND contact_id=$2', [int(req.params.lid), req.contact.id]);
  res.redirect(`${res.locals.base}/contacts/${req.contact.id}#log`);
});

/* --------------------------- קישורי רישום של השליח --------------------------- */

router.get('/links', async (req, res) => {
  const { rows } = await q(
    `SELECT l.*, (SELECT count(*) FROM contacts c WHERE c.reg_link_id=l.id)::int AS n
     FROM reg_links l WHERE shliach_id=$1 ORDER BY active DESC, created_at DESC`, [req.shliach.id]);
  const categories = await loadCategories(req.shliach.id);
  res.render('links', { links: rows, categories, catById: new Map(categories.map((c) => [c.id, c])), site: baseUrl(req) });
});

router.post('/links', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80) || 'קישור רישום';
  await q('INSERT INTO reg_links (shliach_id, token, name, category_id) VALUES ($1,$2,$3,$4)',
    [req.shliach.id, randomToken(9), name, await validCategory(req.shliach.id, int(req.body.category_id))]);
  flash(req, 'נוצר קישור רישום חדש');
  res.redirect(`${res.locals.base}/links`);
});

router.post('/links/:id', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (name) {
    await q('UPDATE reg_links SET name=$1, category_id=$2 WHERE id=$3 AND shliach_id=$4',
      [name, await validCategory(req.shliach.id, int(req.body.category_id)), int(req.params.id), req.shliach.id]);
    flash(req, 'הקישור עודכן');
  }
  res.redirect(`${res.locals.base}/links`);
});

router.post('/links/:id/toggle', async (req, res) => {
  await q('UPDATE reg_links SET active = NOT active WHERE id=$1 AND shliach_id=$2', [int(req.params.id), req.shliach.id]);
  res.redirect(`${res.locals.base}/links`);
});

/* ------------------------------ הגדרות ------------------------------ */

const recentOtp = (req) => req.session.otpLogin?.id === req.shliach.id && req.session.otpLogin.at > Date.now() - 15 * 60 * 1000;

async function renderSettings(req, res, error = null, status = 200) {
  res.status(status).render('settings', {
    error, needCurrent: !!req.shliach.access_code_hash && !recentOtp(req), canOtp: !!req.shliach.phone && smsConfigured(), categories: await loadCategories(req.shliach.id),
    smsOn: smsConfigured(), fmtDate, quota: quotaStatus(req.shliach),
    previews: req.shliach.sms_weekly && req.shliach.sms_daily
      ? { 'שבועי': await weeklyMessageFor(req.shliach, undefined, 'weekly'), 'יומי': await weeklyMessageFor(req.shliach, undefined, 'daily') }
      : { '': await weeklyMessageFor(req.shliach) },
  });
}

router.get('/settings', (req, res) => renderSettings(req, res));

// תזכורות SMS: הגדרה (נייד, הפעלה, תדירות) ושליחת ניסיון
const lastTest = new Map();
router.post('/sms', async (req, res) => {
  const s = req.shliach;
  const back = `${res.locals.base}/settings#sms`;
  if (req.body.action === 'test') {
    if (!smsConfigured()) return renderSettings(req, res, 'שליחת SMS עדיין לא הוגדרה במערכת', 400);
    if (Date.now() - (lastTest.get(s.id) || 0) < 60 * 1000) return renderSettings(req, res, 'אפשר לשלוח הודעת ניסיון פעם בדקה', 429);
    lastTest.set(s.id, Date.now());
    const r = await sendReminder(s, previewKind(s), undefined, { test: true });
    if (r.ok) flash(req, 'הודעת הניסיון נשלחה'); else flashErr(req, `השליחה נכשלה: ${r.error}`);
    return res.redirect(back);
  }
  const weekly = req.body.sms_weekly === 'on', daily = req.body.sms_daily === 'on';
  const phone = String(req.body.sms_phone || '').trim();
  if (phone && !normalizePhone(phone)) return renderSettings(req, res, 'מספר הנייד לקבלת SMS אינו תקין', 400);
  if ((weekly || daily) && !phone) return renderSettings(req, res, 'כדי להפעיל SMS יש להזין מספר נייד', 400);
  await q('UPDATE shluchim SET sms_phone=$1, sms_weekly=$2, sms_daily=$3, sms_enabled=$4 WHERE id=$5',
    [normalizePhone(phone) || '', weekly, daily, weekly || daily, s.id]);
  const what = [weekly && 'בכל יום ראשון — ימי ההולדת של השבוע', daily && 'בכל יום חול שיש בו ימי הולדת — ימי ההולדת של היום'].filter(Boolean);
  flash(req, what.length ? `נשמר — תקבלו SMS ${what.join(', וגם ')}` : 'נשמר — התזכורות כבויות');
  res.redirect(back);
});

router.post('/settings', async (req, res) => {
  const s = req.shliach;
  const back = `${res.locals.base}/settings`;
  const fail = (error) => renderSettings(req, res, error, 400);
  const a = req.body.action;

  if (a === 'code') {
    if (s.access_code_hash && !recentOtp(req) && !(await bcrypt.compare(String(req.body.current || '').trim(), s.access_code_hash))) return fail('הקוד הנוכחי שגוי');
    const code = String(req.body.code || '').trim();
    if (!validCode(code)) return fail(CODE_RULE);
    if (code !== String(req.body.code2 || '').trim()) return fail('הקודים אינם תואמים');
    const { rows } = await q(
      'UPDATE shluchim SET access_code_hash=$1, session_version=session_version+1 WHERE id=$2 RETURNING session_version',
      [await bcrypt.hash(code, 12), s.id]);
    // מנתק את כל שאר המכשירים, ומשאיר מחובר רק את מי שהחליף
    req.session.sh = { ...(Array.isArray(req.session.sh) ? {} : req.session.sh), [s.id]: rows[0].session_version };
    flash(req, 'קוד הכניסה עודכן');
  } else if (a === 'cat_add') {
    const name = String(req.body.name || '').trim().slice(0, 40);
    if (!name) return fail('יש להזין שם לסיווג');
    const color = COLORS.includes(req.body.color) ? req.body.color : COLORS[0];
    await q('INSERT INTO categories (shliach_id, name, color, sort) VALUES ($1,$2,$3,(SELECT coalesce(max(sort),0)+1 FROM categories WHERE shliach_id=$1))', [s.id, name, color]);
    flash(req, 'הסיווג נוסף');
  } else if (a === 'cat_update') {
    const name = String(req.body.name || '').trim().slice(0, 40);
    const color = COLORS.includes(req.body.color) ? req.body.color : COLORS[0];
    if (name) await q('UPDATE categories SET name=$1, color=$2 WHERE id=$3 AND shliach_id=$4', [name, color, int(req.body.id), s.id]);
    flash(req, 'הסיווג עודכן');
  } else if (a === 'cat_delete') {
    await q('DELETE FROM categories WHERE id=$1 AND shliach_id=$2', [int(req.body.id), s.id]);
    flash(req, 'הסיווג נמחק');
  }
  res.redirect(back);
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
  startScheduler();
}
