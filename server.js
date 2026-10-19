import express from 'express';
import { gematriya } from '@hebcal/core';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, migrate, transaction, dbStorage, pool } from './lib/db.js';
import {
  HEB_MONTHS, HEB_DAYS, DAY_NAMES, todayIL, nextBirthday, weekRange, hebMonthRange,
  hebToday, addDays, fmtGreg, hebFromGreg, parseISO, weekInfo, birthNote, hebDateStr, hebRangeStr, toISO, monthName, hebYearStr, hebStamp,
} from './lib/dates.js';

import { loadPeople, collectEvents, collectEvents as collectAll } from './lib/events.js';
import { audit, auditRequests, pruneAudit } from './lib/audit.js';
import { noteDemo, noteDemoReject, report as loadReport, alertSettings, saveAlertSettings, sendTestAlert, POOL_MAX } from './lib/monitor.js';
import { ADDRESS_OPTIONS, addressKey, parseAddress, displayName, g as gword } from './lib/address.js';
import { seedDemoAccount } from './lib/demo.js';
import { recordsStatus, roomError, RECORDS_STEP } from './lib/records.js';
import { splitTable, guessMapping, parseRow, dupKey, toTSV, FIELDS as IMPORT_FIELDS, MAX_ROWS as IMPORT_MAX } from './lib/import.js';
import { smsConfigured, normalizePhone, shliachPhone, smsCapable, PHONE_RULE, sendSms, sendToShliach, sendReminder, weeklyMessageFor, previewKind, startScheduler, quotaStatus, getDefaultQuota, setDefaultQuota } from './lib/sms.js';
import { RateLimiter, strongEnough, otpSendByIp, otpSendByAccount, loginByIp, loginByAccount, registerByIp, registerByLink, contactByIp, recordsByIp, recordsByLink, PUBLIC_MAX_ROWS, otpSendDaily, storeReveal, takeReveal } from './lib/security.js';
import { parseBirth, parseContact, parseFamily, birthText, formValues, whatsappLink, phoneIntl, RELATIONS } from './lib/person.js';

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
  ['מקורבים', '#4F6BD8'], ['משתתף בשיעורים', '#2E9E6B'], ['תורם', '#C98A1A'], ['חדש', '#9A5BC9'],
];
const COLORS = ['#4F6BD8', '#2E9E6B', '#C98A1A', '#9A5BC9', '#D2475B', '#1A93A8', '#6B6F7B'];

// סקריפטים רק מהאתר עצמו (בלי inline); style-attribute נדרש לצבעי הסיווגים
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  "manifest-src 'self'", "worker-src 'self'",
].join('; ');

// גרסת הקבצים הסטטיים — משתנה בכל פריסה, כך שהדפדפן לא נשאר עם CSS/JS ישנים מהמטמון
const ASSET_V = (process.env.RAILWAY_GIT_COMMIT_SHA || Date.now().toString(36)).slice(0, 8);

const app = express();
app.set('view engine', 'ejs');
// תבניות נשמרות בזיכרון אחרי ההידור הראשון (פי 3–5 מהר יותר בדפים ארוכים). רק בפיתוח מקומי מפורש — בלי מטמון
app.set('view cache', process.env.NODE_ENV !== 'development');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');
// ייבוא מקורבים בהדבקה (עד אלפי שורות) מקבל גוף גדול יותר; שאר הטפסים — 100kb
const smallBody = express.urlencoded({ extended: true, limit: '100kb' });
const bigBody = express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 5000 });
app.use((req, res, next) => (/^\/s\/[^/]+\/contacts\/import$/.test(req.path) ? bigBody : smallBody)(req, res, next));
// ב-Express 5 בקשה בלי גוף משאירה את req.body ריק (undefined) — מונע TypeError בנתיבים
app.use((req, res, next) => { req.body ??= {}; next(); });
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
  res.locals.v = ASSET_V;
  res.locals.todayISO = toISO(todayIL()); // "היום" לפי שעון ישראל (למשל max בשדה תאריך לידה)
  Object.assign(res.locals, { ADDRESS_OPTIONS, addressKey, displayName, gword, phoneIntl, hebStamp, smsCapable });
  Object.assign(res.locals, { HEB_MONTHS, HEB_DAYS, RELATIONS, COLORS, DAY_NAMES, birthText, fmtGreg, flash: req.session.flash });
  req.session.flash = undefined;
  next();
});
// הגנת CSRF נוספת (מעבר ל-sameSite): דפדפנים מסמנים בקשות שמגיעות מאתר אחר — טופס POST מאתר זר נדחה
app.use((req, res, next) => (req.method === 'POST' && req.get('sec-fetch-site') === 'cross-site'
  ? res.status(403).render('error', { message: 'הבקשה נחסמה (נשלחה מאתר אחר)' }) : next()));
app.use(auditRequests);

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
app.get('/', (req, res) => res.render('home'));
app.get('/terms', (req, res) => res.render('terms'));
app.get('/info', (req, res) => res.render('info'));
app.get('/privacy', (req, res) => res.render('privacy'));

/* ------------------------- טופס יצירת קשר (בקשות פרטיות ושאלות) ------------------------- */
const CONTACT_KINDS = { view: 'עיון במידע שנשמר עליי', fix: 'תיקון הפרטים שלי', delete: 'מחיקת הפרטים שלי', other: 'שאלה / אחר' };
// ?r=<טוקן קישור רישום> — מקשר את הפנייה לשליח שאצלו נרשמו
async function contactLink(token) {
  if (!token) return null;
  const { rows } = await q(`SELECT l.token, s.id AS shliach_id, s.name AS shliach_name, s.chabad_house
    FROM reg_links l JOIN shluchim s ON s.id=l.shliach_id WHERE l.token=$1`, [String(token).slice(0, 64)]);
  return rows[0] || null;
}
app.get('/contact', async (req, res) => {
  res.locals.noApp = true;
  res.render('contact_form', { link: await contactLink(req.query.r), CONTACT_KINDS, values: { kind: CONTACT_KINDS[req.query.k] ? req.query.k : '' }, error: null, done: false });
});
app.post('/contact', async (req, res) => {
  res.locals.noApp = true;
  const link = await contactLink(req.body.r);
  const show = (status, extra) => res.status(status).render('contact_form', { link, CONTACT_KINDS, values: req.body, error: null, done: false, ...extra });
  if (req.body.website) return show(200, { done: true }); // מלכודת לבוטים
  const kind = Object.hasOwn(CONTACT_KINDS, req.body.kind) ? req.body.kind : null;
  const name = String(req.body.name || '').trim().slice(0, 80);
  const phone = String(req.body.phone || '').trim().slice(0, 30);
  const message = String(req.body.message || '').trim().slice(0, 1000);
  if (!kind) return show(400, { error: 'בחרו את סוג הפנייה' });
  if (!name) return show(400, { error: 'יש להזין שם' });
  if (phone.replace(/\D/g, '').length < 7) return show(400, { error: 'יש להזין מספר טלפון תקין' });
  if (!contactByIp.take(`contact:${req.ip}`)) return show(429, { error: 'נשלחו יותר מדי פניות. נסו שוב מאוחר יותר.' });
  await q('INSERT INTO contact_requests (shliach_id, kind, name, phone, message) VALUES ($1,$2,$3,$4,$5)',
    [link?.shliach_id ?? null, kind, name, phone, message]);
  audit({ shliachId: link?.shliach_id ?? null, actor: 'public', action: 'פנייה בטופס יצירת קשר', outcome: 'ok', detail: CONTACT_KINDS[kind] });
  show(200, { done: true });
});

// ימי חודש לועזי בתאריך עברי — ללוח השנה של בחירת הטווח
app.get('/api/hebmonth', (req, res) => {
  const y = parseInt(req.query.y, 10), m = parseInt(req.query.m, 10);
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12)) return res.status(400).json({ error: 'bad month' });
  const days = new Date(y, m, 0).getDate();
  const heb = Array.from({ length: days }, (_, i) => hebFromGreg(new Date(y, m - 1, i + 1), false));
  const label = (h) => `${monthName(h.month, h.year)} ${hebYearStr(h.year)}`;
  const a = label(heb[0]), b = label(heb[days - 1]);
  res.set('Cache-Control', 'public, max-age=86400').json({
    days: heb.map((h) => gematriya(h.day)),
    month: a === b ? a : `${a.replace(/ \S+$/, a.split(' ').pop() === b.split(' ').pop() ? '' : '$&')} – ${b}`,
  });
});

// טווח בתאריך עברי — לסיכום בחלון בחירת הטווח
app.get('/api/hebrange', (req, res) => {
  const a = parseISO(req.query.from), b = parseISO(req.query.to);
  if (!a || !b || b < a) return res.status(400).json({ error: 'bad range' });
  res.set('Cache-Control', 'public, max-age=86400').json({ label: hebRangeStr(a, b) });
});

// תצוגה מקדימה של התאריך העברי בטופסי התאריך (חישוב בלבד — בלי מסד נתונים)
app.get('/api/hebdate', (req, res) => {
  const yz = req.query.kind === 'yahrzeit';
  const b = parseBirth(Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v).slice(0, 20)])), { death: yz });
  if (b.error) return res.json({ error: b.error });
  const { h_day: day, h_month: month, h_year: year } = b.value;
  const today = todayIL();
  const next = nextBirthday({ h_day: day, h_month: month, h_year: year, kind: yz ? 'yahrzeit' : 'birthday' }, today);
  res.set('Cache-Control', 'no-store').json({
    label: hebDateStr(day, month, year),
    note: yz ? next?.note || null : birthNote(day, month, year),
    next: next && {
      label: next.actualLabel, greg: fmtGreg(next.date), day: DAY_NAMES[next.date.getDay()], age: next.age,
      today: +next.date === +today,
    },
  });
});

// "שמירה כאפליקציה" (PWA): מניפסט כללי, ומניפסט אישי לכל שליח שנפתח ישר לדשבורד שלו
function manifest({ name, short, start, scope }) {
  return {
    name, short_name: short, start_url: start, scope, id: start,
    description: 'זכרתי התקשרתי — לא מפספסים אף יום הולדת. ימי הולדת עבריים של המקורבים, תזכורות ויצירת קשר',
    display: 'standalone', dir: 'rtl', lang: 'he',
    background_color: '#FBF6EC', theme_color: '#0F1B33',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').send(manifest({ name: 'זכרתי התקשרתי', short: 'זכרתי התקשרתי', start: '/admin', scope: '/' }));
});

// דפי המנהל: "יחי אדוננו" בתחתית
app.use('/admin', (req, res, next) => { res.locals.yechi = true; next(); });
// הגנה מפני נעילת המנהל על ידי אחרים:
// 1. מכשיר מוכר — אחרי כניסה מוצלחת נשמר בעוגייה החתומה סימון שקשור לסיסמה הנוכחית (החלפת סיסמה מבטלת אותו).
//    ממכשיר מוכר הנעילה הכללית (ניסיונות שגויים מכל העולם) לא חלה, וטעויות שלך לא נועלות אחרים.
// 2. ממכשיר חדש כשהחשבון נעול — קוד חד-פעמי ב-SMS לנייד המנהל (מוגדר בדף המנהל ← עומס) + הסיסמה.
const ADMIN_DEVICE = crypto.createHmac('sha256', SESSION_SECRET).update('admin-device:' + ADMIN_PASSWORD).digest('base64url').slice(0, 24);
const adminOtp = { hash: null, exp: 0, tries: 0 };
const adminOtpSend = new RateLimiter({ max: 3, windowMs: 60 * 60 * 1000 });
const adminState = (req) => {
  const trusted = req.session.admDev === ADMIN_DEVICE;
  return { trusted, locked: !trusted && loginByAccount.blocked('admin'), otpSent: adminOtp.exp > Date.now() };
};
const renderAdminLogin = (req, res, error = null, status = 200) => res.status(status).render('admin_login', { error, ...adminState(req) });

app.get('/admin/login', (req, res) => {
  if (req.session.admin > Date.now()) return res.redirect('/admin');
  renderAdminLogin(req, res);
});

app.post('/admin/login', async (req, res) => {
  const ipKey = 'admin:' + req.ip;
  const { trusted, locked } = adminState(req);
  if (loginByIp.blocked(ipKey)) return renderAdminLogin(req, res, 'יותר מדי ניסיונות מהמכשיר הזה. נסו שוב בעוד רבע שעה.', 429);
  let otpUsed = false;
  if (locked) {
    // החשבון נעול (מכשיר לא מוכר): נדרש גם קוד מה-SMS
    const code = String(req.body.otp || '').trim();
    const ok = adminOtp.hash && adminOtp.exp > Date.now() && adminOtp.tries < 5 && /^\d{6}$/.test(code)
      && (adminOtp.tries++, await bcrypt.compare(code, adminOtp.hash));
    if (!ok) {
      loginByIp.hit(ipKey);
      req.auditDetail = code ? 'קוד SMS שגוי (חשבון נעול)' : 'חשבון נעול';
      return renderAdminLogin(req, res, code ? 'קוד ה-SMS שגוי או שפג תוקפו' : null, 429); // בלי קוד — ההסבר כבר מוצג בתיבת הנעילה
    }
    otpUsed = true;
  }
  if (!crypto.timingSafeEqual(sha(req.body.password || ''), sha(ADMIN_PASSWORD))) {
    loginByIp.hit(ipKey);
    if (!trusted) loginByAccount.hit('admin');
    req.auditDetail = 'סיסמה שגויה';
    return renderAdminLogin(req, res, 'סיסמה שגויה', 401);
  }
  loginByIp.reset(ipKey);
  if (otpUsed) Object.assign(adminOtp, { hash: null, exp: 0, tries: 0 });
  req.session.admDev = ADMIN_DEVICE; // מעכשיו — מכשיר מוכר
  req.session.admin = Date.now() + ADMIN_SESSION_MS; // תוקף, לא רק true
  res.redirect('/admin');
});

// קוד כניסה ב-SMS לנייד המנהל — רק כשהחשבון נעול; עד 3 הודעות בשעה
app.post('/admin/login/otp', async (req, res) => {
  if (!adminState(req).locked) return res.redirect('/admin/login');
  const { phone } = await alertSettings();
  const to = normalizePhone(phone);
  if (!to || !smsConfigured()) return renderAdminLogin(req, res, 'לא הוגדר נייד מנהל להתראות (דף המנהל ← עומס) — אפשר להיכנס ממכשיר שכבר נכנסתם ממנו, או לחכות שעה', 503);
  if (!adminOtpSend.take('admin')) return renderAdminLogin(req, res, 'נשלחו כבר 3 קודים בשעה האחרונה — השתמשו בקוד האחרון', 429);
  const code = String(crypto.randomInt(100000, 1000000));
  Object.assign(adminOtp, { hash: await bcrypt.hash(code, 10), exp: Date.now() + 10 * 60 * 1000, tries: 0 });
  try {
    await sendSms(to, `קוד כניסה לניהול "זכרתי התקשרתי": ${code}\nבתוקף 10 דקות. אם לא ביקשת — מישהו מנסה לנחש את סיסמת המנהל.`);
  } catch (e) {
    return renderAdminLogin(req, res, `ה-SMS לא נשלח: ${e.message}`, 502);
  }
  renderAdminLogin(req, res, null);
});

app.post('/admin/logout', (req, res) => { req.session.admin = undefined; res.redirect('/'); });

// מונה פניות חדשות לתפריט המנהל
app.use('/admin', async (req, res, next) => {
  if (req.method === 'GET' && req.session.admin > Date.now()) {
    res.locals.inboxNew = (await q(`SELECT count(*)::int AS n FROM contact_requests WHERE status='new'`)).rows[0].n;
  }
  next();
});

function requireAdmin(req, res, next) {
  if (!(req.session.admin > Date.now())) { req.session.admin = undefined; return res.redirect('/admin/login'); }
  next();
}

// המנהל רואה רק שם, קישור וסטטוס — לא את נתוני המקורבים
app.get('/admin', requireAdmin, async (req, res) => {
  const { rows } = await q(`SELECT s.id, s.name, s.chabad_house, s.slug, s.active, s.created_at, s.access_code_hash IS NOT NULL AS has_code,
                              s.sms_weekly, s.sms_daily, s.sms_quota, s.sms_used_birthdays, s.sms_alert_threshold, s.phone, s.records_quota,
                              (SELECT count(*) FROM contacts c WHERE c.shliach_id=s.id)::int
                              + (SELECT count(*) FROM family_members f JOIN contacts c ON c.id=f.contact_id WHERE c.shliach_id=s.id)::int AS records_used
                            FROM shluchim s ORDER BY s.created_at DESC`);
  const info = takeReveal(req.session.reveal);
  req.session.reveal = undefined;
  const { rows: [summary] } = await q(`SELECT
      (SELECT count(*) FROM shluchim WHERE active)::int AS active,
      (SELECT count(DISTINCT shliach_id) FROM activity_log WHERE actor='shliach' AND created_at > now() - interval '30 days')::int AS used30,
      (SELECT count(*) FROM contacts)::int AS contacts,
      (SELECT coalesce(sum(units),0) FROM sms_log WHERE created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem'))::int AS sms_month,
      (SELECT count(*) FROM activity_log WHERE created_at > now() - interval '24 hours'
         AND (outcome='error' OR (actor IN ('system','public') AND outcome IN ('fail','blocked'))))::int AS problems24`);
  const d = ['shluchim', 'contacts', 'sms', 'problems', 'load'].includes(req.query.d) ? req.query.d : null;
  res.render('admin', { shluchim: rows, base: baseUrl(req), info, smsOn: smsConfigured(), defaultQuota: await getDefaultQuota(), quotaStatus, summary,
    d, detail: d === 'load' ? { ...loadReport(), settings: await alertSettings() } : d ? await adminDetail(d) : null, fmtDate,
    load: loadReport(), POOL_MAX, fmtTime });
});

// מעקב עומס: נייד להתראות וסף (% מתקרת החיבורים)
app.post('/admin/alerts', requireAdmin, async (req, res) => {
  const raw = String(req.body.phone || '').trim();
  const phone = raw ? normalizePhone(raw) : '';
  if (raw && !phone) flashErr(req, 'מספר הנייד להתראות אינו תקין');
  else {
    await saveAlertSettings({ phone, pct: parseInt(req.body.pct, 10) || 80 });
    flash(req, 'הגדרות ההתראה נשמרו');
  }
  res.redirect('/admin?d=load#detail');
});
app.post('/admin/alerts/test', requireAdmin, async (req, res) => {
  try { await sendTestAlert(); flash(req, 'הודעת ניסיון נשלחה'); } catch (e) { flashErr(req, `לא נשלח: ${e.message}`); }
  res.redirect('/admin?d=load#detail');
});

// פירוט לכל אחד מ-4 ריבועי הסיכום בדף המנהל — מספרים בלבד, בלי שמות או טלפונים של מקורבים
async function adminDetail(d) {
  if (d === 'shluchim') {
    const { rows: [t] } = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active,
        count(*) FILTER (WHERE NOT active)::int AS inactive,
        count(*) FILTER (WHERE created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem'))::int AS new_month,
        count(*) FILTER (WHERE access_code_hash IS NULL)::int AS no_code FROM shluchim`);
    const { rows } = await q(`SELECT s.id, s.name, s.chabad_house, s.active, s.created_at,
        (SELECT max(created_at) FROM activity_log a WHERE a.shliach_id=s.id AND a.actor='shliach') AS last_seen,
        (SELECT count(*) FROM activity_log a WHERE a.shliach_id=s.id AND a.actor='shliach' AND a.created_at > now() - interval '30 days')::int AS actions30
      FROM shluchim s ORDER BY last_seen DESC NULLS LAST, s.created_at DESC`);
    return { t, rows, used30: rows.filter((r) => r.actions30 > 0).length, never: rows.filter((r) => !r.last_seen).length };
  }
  if (d === 'contacts') {
    const { rows: [t] } = await q(`SELECT (SELECT count(*) FROM contacts)::int AS contacts,
        (SELECT count(*) FROM family_members)::int AS family,
        (SELECT count(*) FROM contacts WHERE created_at > now() - interval '30 days')::int AS new30,
        (SELECT count(*) FROM contacts WHERE reg_link_id IS NOT NULL)::int AS via_link,
        (SELECT count(*) FROM contacts WHERE remind_days IS NOT NULL)::int AS reminders,
        (SELECT count(*) FROM contact_log WHERE created_at > now() - interval '30 days')::int AS greetings30`);
    const { rows } = await q(`SELECT s.id, s.name, s.chabad_house,
        (SELECT count(*) FROM contacts c WHERE c.shliach_id=s.id)::int AS contacts,
        (SELECT count(*) FROM family_members f JOIN contacts c ON c.id=f.contact_id WHERE c.shliach_id=s.id)::int AS family,
        (SELECT count(*) FROM contacts c WHERE c.shliach_id=s.id AND c.created_at > now() - interval '30 days')::int AS new30,
        (SELECT count(*) FROM contact_log l JOIN contacts c ON c.id=l.contact_id WHERE c.shliach_id=s.id AND l.created_at > now() - interval '30 days')::int AS greetings30
      FROM shluchim s ORDER BY contacts DESC, s.name`);
    return { t, rows };
  }
  if (d === 'sms') {
    const { rows: kinds } = await q(`SELECT kind, sum(units)::int AS units, count(*)::int AS msgs FROM sms_log
      WHERE created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem') GROUP BY kind ORDER BY units DESC`);
    const { rows: months } = await q(`SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'Asia/Jerusalem'), 'MM.YYYY') AS m, sum(units)::int AS units
      FROM sms_log WHERE created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem') - interval '5 months' GROUP BY 1, date_trunc('month', created_at AT TIME ZONE 'Asia/Jerusalem') ORDER BY date_trunc('month', created_at AT TIME ZONE 'Asia/Jerusalem')`);
    const { rows } = await q(`SELECT s.id, s.name, s.sms_quota, s.sms_used_birthdays, s.sms_alert_threshold, s.sms_weekly, s.sms_daily,
        (SELECT coalesce(sum(units),0) FROM sms_log l WHERE l.shliach_id=s.id AND l.created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem'))::int AS month_units
      FROM shluchim s ORDER BY month_units DESC, s.name`);
    return { kinds, months, rows };
  }
  const { rows: groups } = await q(`SELECT action, outcome, actor, count(*)::int AS n, max(created_at) AS last FROM activity_log
    WHERE created_at > now() - interval '24 hours' AND (outcome='error' OR (actor IN ('system','public') AND outcome IN ('fail','blocked')))
    GROUP BY action, outcome, actor ORDER BY n DESC LIMIT 30`);
  const { rows: [w] } = await q(`SELECT count(*) FILTER (WHERE outcome='error')::int AS errors7,
      count(*) FILTER (WHERE outcome IN ('fail','blocked') AND actor IN ('system','public'))::int AS fails7
    FROM activity_log WHERE created_at > now() - interval '7 days'`);
  return { groups, w };
}

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
  if (err) { flashErr(req, err); return res.redirect(`/admin/shluchim/${int(req.params.id)}`); }
  if (add.value) await q('UPDATE shluchim SET sms_quota = least(sms_quota + $1, $3) WHERE id=$2', [add.value, id, MAX_QUOTA]);
  if (set.value !== null) await q('UPDATE shluchim SET sms_quota=$1 WHERE id=$2', [set.value, id]);
  if (req.body.threshold !== undefined) await q('UPDATE shluchim SET sms_alert_threshold=$1 WHERE id=$2', [th.value, id]);
  // יחידות חדשות — מנקים את שגיאת "המכסה נגמרה"
  await q(`UPDATE shluchim SET sms_last_error=NULL WHERE id=$1 AND sms_used_birthdays < sms_quota AND sms_last_error LIKE 'יתרת ה-SMS%'`, [id]);
  const { rows } = await q('SELECT sms_quota, sms_used_birthdays, sms_alert_threshold FROM shluchim WHERE id=$1', [id]);
  if (rows[0]) { const st = quotaStatus(rows[0]); flash(req, `המכסה עודכנה: ${st.quota} יחידות, נוצלו ${st.used}, יתרה ${st.left} (התראה מתחת ל-${st.threshold})`); }
  res.redirect(`/admin/shluchim/${int(req.params.id)}`);
});

// סגירת חשבון שליח: מוחק את השליח וכל המידע שלו (מקורבים, בני משפחה, קישורים, יומני SMS) — בלתי הפיך
app.post('/admin/shluchim/:id/delete', requireAdmin, async (req, res) => {
  const id = int(req.params.id);
  const { rows } = await q('SELECT name FROM shluchim WHERE id=$1', [id]);
  if (!rows[0]) return res.redirect('/admin');
  if (String(req.body.confirm || '').trim() !== 'מחיקה') { flashErr(req, 'כדי למחוק יש להקליד "מחיקה" בתיבת האישור'); return res.redirect(`/admin/shluchim/${id}#danger`); }
  await q('DELETE FROM shluchim WHERE id=$1', [id]);
  req.auditDetail = `#${id}`;
  flash(req, `החשבון של ${rows[0].name} נמחק עם כל המידע שבו`);
  res.redirect('/admin');
});

// מכסת רשומות (מקורבים + בני משפחה): רק המנהל מרחיב — "+500" או מספר מדויק
app.post('/admin/shluchim/:id/records', requireAdmin, async (req, res) => {
  const id = int(req.params.id);
  const set = parseQuota(req.body.quota);
  if (set.error) { flashErr(req, set.error); return res.redirect(`/admin/shluchim/${id}`); }
  const addN = req.body.add === 'step' ? RECORDS_STEP : parseInt(req.body.add, 10);
  if (req.body.add && !(addN >= 1 && addN <= 100000)) { flashErr(req, 'מספר הרשומות להוספה אינו תקין'); return res.redirect(`/admin/shluchim/${id}`); }
  if (addN) await q('UPDATE shluchim SET records_quota = least(records_quota + $1, 1000000) WHERE id=$2', [addN, id]);
  else if (set.value !== null) await q('UPDATE shluchim SET records_quota=$1 WHERE id=$2', [set.value, id]);
  const st = await recordsStatus(id);
  await q('UPDATE shluchim SET records_alert=$1 WHERE id=$2', [st.level, id]); // התראה חדשה תישלח כשיתקרבו שוב
  req.auditDetail = `${st.quota}`;
  flash(req, `מכסת הרשומות עודכנה: ${st.quota} (בשימוש ${st.used}, נותרו ${st.left})`);
  res.redirect(`/admin/shluchim/${id}`);
});

/* ------------------------- יומן פעולות וסטטיסטיקות ------------------------- */
// הכול כאן אגרגטיבי או מתוך activity_log — שמות, טלפונים ופרטי מקורבים לא נשלפים בכלל

const OUTCOMES = { ok: 'הצליח', fail: 'נכשל', blocked: 'נחסם', error: 'תקלה' };
const ACTORS = { admin: 'מנהל', shliach: 'שליח', public: 'רישום ציבורי', system: 'מערכת' };
const LOG_PAGE = 100;

async function loadLog({ shliachId = null, problems = false, page = 1, action = '', actor = '', outcome = '' }) {
  const where = [], params = [];
  if (shliachId) { params.push(shliachId); where.push(`l.shliach_id=$${params.length}`); }
  if (problems) where.push(`l.outcome <> 'ok'`);
  if (action) { params.push(action); where.push(`l.action=$${params.length}`); }
  if (actor) { params.push(actor); where.push(`l.actor=$${params.length}`); }
  if (outcome) { params.push(outcome); where.push(`l.outcome=$${params.length}`); }
  params.push(LOG_PAGE + 1, (page - 1) * LOG_PAGE);
  const { rows } = await q(
    `SELECT l.*, s.name AS shliach_name FROM activity_log l LEFT JOIN shluchim s ON s.id=l.shliach_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY l.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows: rows.slice(0, LOG_PAGE), more: rows.length > LOG_PAGE };
}

const fmtTime = (d) => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);

// פניות מטופס יצירת קשר
app.get('/admin/inbox', requireAdmin, async (req, res) => {
  const all = req.query.all === '1';
  const { rows } = await q(`SELECT r.*, s.name AS shliach_name, s.phone AS shliach_phone, s.gender, s.use_title
    FROM contact_requests r LEFT JOIN shluchim s ON s.id=r.shliach_id
    ${all ? '' : "WHERE r.status='new'"} ORDER BY r.created_at DESC LIMIT 300`);
  res.render('admin_inbox', { rows, all, CONTACT_KINDS, fmtTime });
});
app.post('/admin/inbox/:rid/status', requireAdmin, async (req, res) => {
  const done = req.body.status === 'done';
  await q(`UPDATE contact_requests SET status=$1, handled_at=$2 WHERE id=$3`, [done ? 'done' : 'new', done ? new Date() : null, int(req.params.rid)]);
  flash(req, done ? 'הפנייה סומנה כטופלה' : 'הפנייה הוחזרה לפניות פתוחות');
  res.redirect('/admin/inbox' + (req.body.all === '1' ? '?all=1' : ''));
});

app.get('/admin/log', requireAdmin, async (req, res) => {
  const page = Math.max(1, int(req.query.page) || 1);
  const shliachId = int(req.query.s), problems = req.query.o === 'problems';
  // מסננים: סוג פעולה (מתוך הפעולות שקיימות ביומן), מי ביצע, תוצאה
  const { rows: actions } = await q('SELECT action, count(*)::int AS n FROM activity_log GROUP BY action ORDER BY action');
  const action = actions.some((a) => a.action === req.query.a) ? req.query.a : '';
  const actor = Object.hasOwn(ACTORS, req.query.by) ? req.query.by : '';
  const outcome = Object.hasOwn(OUTCOMES, req.query.r) ? req.query.r : '';
  const log = await loadLog({ shliachId, problems, page, action, actor, outcome });
  const { rows: shluchim } = await q('SELECT id, name FROM shluchim ORDER BY name');
  const filters = { ...(shliachId ? { s: shliachId } : {}), ...(problems ? { o: 'problems' } : {}), ...(action ? { a: action } : {}), ...(actor ? { by: actor } : {}), ...(outcome ? { r: outcome } : {}) };
  res.render('admin_log', { ...log, page, shliachId, problems, shluchim, OUTCOMES, ACTORS, fmtTime, actions, action, actor, outcome, filters });
});

// בורר השליח בדשבורד (טופס GET)
app.get('/admin/shluchim/go', requireAdmin, (req, res) => res.redirect(int(req.query.id) ? `/admin/shluchim/${int(req.query.id)}` : '/admin'));

app.get('/admin/shluchim/:id', requireAdmin, async (req, res) => {
  const id = int(req.params.id);
  const { rows } = await q(`SELECT id, name, chabad_house, slug, active, created_at, phone, gender, use_title, sms_weekly, sms_daily,
                              sms_quota, sms_used_birthdays, sms_alert_threshold, sms_last_error,
                              access_code_hash IS NOT NULL AS has_code FROM shluchim WHERE id=$1`, [id]);
  if (!rows[0]) return res.status(404).render('error', { message: 'השליח לא נמצא' });
  const one = async (sql) => (await q(sql, [id])).rows[0];
  const counts = await one(`SELECT
      (SELECT count(*) FROM contacts WHERE shliach_id=$1)::int AS contacts,
      (SELECT count(*) FROM contacts WHERE shliach_id=$1 AND reg_link_id IS NOT NULL)::int AS via_links,
      (SELECT count(*) FROM family_members f JOIN contacts c ON c.id=f.contact_id WHERE c.shliach_id=$1)::int AS family,
      (SELECT count(*) FROM contacts WHERE shliach_id=$1 AND created_at > now() - interval '30 days')::int AS new30,
      (SELECT count(*) FROM contact_log l JOIN contacts c ON c.id=l.contact_id WHERE c.shliach_id=$1)::int AS contacted,
      (SELECT count(*) FROM contact_log l JOIN contacts c ON c.id=l.contact_id WHERE c.shliach_id=$1 AND l.created_at > now() - interval '30 days')::int AS contacted30,
      (SELECT count(*) FROM reg_links WHERE shliach_id=$1)::int AS links,
      (SELECT count(*) FROM reg_links WHERE shliach_id=$1 AND active)::int AS links_active,
      (SELECT count(*) FROM categories WHERE shliach_id=$1)::int AS categories`);
  const activity = await one(`SELECT
      (SELECT max(created_at) FROM activity_log WHERE shliach_id=$1 AND actor='shliach') AS last_action,
      (SELECT max(created_at) FROM activity_log WHERE shliach_id=$1 AND action='כניסה לחשבון' AND outcome='ok') AS last_login,
      (SELECT count(*) FROM activity_log WHERE shliach_id=$1 AND action='כניסה לחשבון' AND outcome='ok' AND created_at > now() - interval '30 days')::int AS logins30,
      (SELECT count(*) FROM activity_log WHERE shliach_id=$1 AND action='כניסה לחשבון' AND outcome<>'ok' AND created_at > now() - interval '30 days')::int AS failed30,
      (SELECT count(*) FROM activity_log WHERE shliach_id=$1 AND actor='shliach' AND created_at > now() - interval '30 days')::int AS actions30,
      (SELECT count(*) FROM activity_log WHERE shliach_id=$1 AND outcome IN ('fail','error','blocked') AND actor='system' AND created_at > now() - interval '30 days')::int AS sys_problems30`);
  const { rows: sms } = await q(`SELECT kind, count(*)::int AS n, sum(units)::int AS units FROM sms_log
                                 WHERE shliach_id=$1 AND created_at > now() - interval '30 days' GROUP BY kind`, [id]);
  // מקורבים חדשים לפי חודש (6 חודשים), מפוצל: דרך קישור רישום / ידני
  const { rows: months } = await q(`
    SELECT to_char(m, 'MM/YY') AS label,
           count(c.id) FILTER (WHERE c.reg_link_id IS NOT NULL)::int AS links,
           count(c.id) FILTER (WHERE c.reg_link_id IS NULL)::int AS manual
    FROM generate_series(date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') - interval '5 months', date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem'), interval '1 month') m
    LEFT JOIN contacts c ON c.shliach_id=$1 AND date_trunc('month', c.created_at AT TIME ZONE 'Asia/Jerusalem') = m
    GROUP BY m ORDER BY m`, [id]);
  // ימי הולדת — רק ספירות (השמות נטענים לחישוב ולא מועברים לתצוגה)
  const today = todayIL();
  const wk = weekRange(today), hm = hebMonthRange(today);
  const evs = collectEvents(await loadPeople(id), addDays(today, -30), new Date(Math.max(hm.end, addDays(today, 29))));
  await markContacted(id, evs);
  const inR = (e, a, b) => e.date >= a && e.date <= b;
  const past30 = evs.filter((e) => e.date < today && e.date >= addDays(today, -30));
  const bdays = {
    today: evs.filter((e) => e.date.getTime() === today.getTime()).length,
    week: evs.filter((e) => inR(e, wk.start, wk.end)).length,
    month: evs.filter((e) => inR(e, hm.start, hm.end)).length,
    next30: evs.filter((e) => inR(e, today, addDays(today, 29))).length,
    past30: past30.length,
    covered30: past30.filter((e) => e.contacted).length,
    monthName: hm.name.split(' ')[0],
  };
  // פעילות השליח לפי שבוע (12 שבועות) ו-SMS לפי חודש (6 חודשים)
  const { rows: weeks } = await q(`
    SELECT to_char(w, 'DD/MM') AS label, count(l.id)::int AS n
    FROM generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') w
    LEFT JOIN activity_log l ON l.shliach_id=$1 AND l.actor='shliach' AND date_trunc('week', l.created_at) = w
    GROUP BY w ORDER BY w`, [id]);
  const { rows: smsMonths } = await q(`
    SELECT to_char(m, 'MM/YY') AS label,
           coalesce(sum(l.units) FILTER (WHERE l.kind IN ('weekly','daily','contact')), 0)::int AS reminders,
           coalesce(sum(l.units) FILTER (WHERE l.kind NOT IN ('weekly','daily','contact')), 0)::int AS system
    FROM generate_series(date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') - interval '5 months', date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem'), interval '1 month') m
    LEFT JOIN sms_log l ON l.shliach_id=$1 AND date_trunc('month', l.created_at AT TIME ZONE 'Asia/Jerusalem') = m
    GROUP BY m ORDER BY m`, [id]);
  // בריאות החשבון: התראות אוטומטיות למנהל
  const sh = rows[0], quota = quotaStatus(sh), alerts = [];
  const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d)) / 86400000) : null);
  if (!sh.active) alerts.push(['bad', 'החשבון מושבת']);
  if (!sh.phone) alerts.push(['bad', 'אין נייד לשליח — אין קוד חד-פעמי ואין SMS']);
  if (!sh.has_code) alerts.push(['warn', 'לא נקבע קוד קבוע — נכנס רק בקוד חד-פעמי']);
  const idle = daysSince(activity.last_action ?? sh.created_at);
  if (idle !== null && idle >= 30) alerts.push(['warn', `לא נכנס למערכת ${idle} ימים`]);
  if (!counts.contacts) alerts.push(['warn', 'עדיין אין מקורבים']);
  if (!sh.sms_weekly && !sh.sms_daily) alerts.push(['info', 'תזכורות SMS כבויות']);
  else if (quota.empty) alerts.push(['bad', 'יתרת ה-SMS לתזכורות נגמרה — התזכורות נעצרו']);
  else if (quota.low) alerts.push(['warn', `יתרת ה-SMS לתזכורות נמוכה (${quota.left})`]);
  if (sh.sms_last_error) alerts.push(['bad', `שגיאת SMS אחרונה: ${sh.sms_last_error}`]);
  if (activity.failed30 >= 5) alerts.push(['warn', `${activity.failed30} כניסות שנכשלו ב-30 יום`]);
  if (bdays.past30 >= 3 && bdays.covered30 / bdays.past30 < 0.3) alerts.push(['info', `סומן "יצרתי קשר" רק ב-${bdays.covered30} מתוך ${bdays.past30} ימי הולדת בחודש האחרון`]);
  const { rows: all } = await q('SELECT id, name FROM shluchim ORDER BY name');
  const page = Math.max(1, int(req.query.page) || 1);
  const log = await loadLog({ shliachId: id, problems: req.query.o === 'problems', page });
  const reveal = takeReveal(req.session.reveal);
  req.session.reveal = undefined;
  res.render('admin_shliach', { records: await recordsStatus(id), info: reveal && reveal.id === id ? reveal : null, base: baseUrl(req), smsOn: smsConfigured(),
    s: sh, counts, activity, sms, months, weeks, smsMonths, bdays, alerts, all, quota, ...log, page, problems: req.query.o === 'problems',
    OUTCOMES, ACTORS, fmtTime, base: baseUrl(req),
  });
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
     WHERE id=$2 RETURNING id, name, chabad_house, slug, phone, gender, use_title`,
    [await bcrypt.hash(code, 12), id]);
  if (rows[0]) req.session.reveal = storeReveal({ ...rows[0], code }); // בעוגייה רק מזהה
  return rows[0];
}

const shliachUrl = (req, slug) => `${baseUrl(req)}/s/${slug}`;

// SMS עם הקישור האישי לשליח. הקוד הקבוע נכלל רק ברגע שנקבע (אחר כך השרת לא יודע אותו)
function welcomeMessage(s, url, code, isNew) {
  const intro = isNew ? 'נפתח עבורך חשבון ב"זכרתי התקשרתי".' : (code ? 'קוד הכניסה שלך ל"זכרתי התקשרתי" עודכן.' : 'הקישור שלך ל"זכרתי התקשרתי":');
  const lines = [`שלום ${displayName(s)}! 🎂`, intro, isNew || code ? `הקישור האישי שלך:\n${url}` : url];
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

// מניעת חשבון כפול (למשל לחיצה כפולה על "יצירה"): נייד שכבר בתהליך יצירה / קיים אצל שליח אחר
const creatingPhones = new Set();
app.post('/admin/shluchim', requireAdmin, async (req, res) => {
  const phone0 = shliachPhone(req.body.phone);
  if (phone0 && creatingPhones.has(phone0)) return res.redirect('/admin'); // הבקשה הראשונה עוד רצה
  if (phone0) creatingPhones.add(phone0);
  try { await createShliach(req, res); } finally { if (phone0) creatingPhones.delete(phone0); }
});
async function createShliach(req, res) {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) { flashErr(req, 'יש להזין שם'); return res.redirect('/admin'); }
  const house = String(req.body.chabad_house || '').trim().slice(0, 80);
  const phone = shliachPhone(req.body.phone);
  if (!phone) { flashErr(req, PHONE_RULE); return res.redirect('/admin'); }
  const sms = smsCapable(phone); // נייד מחו"ל: נוצר בלי שירותי SMS
  const { rows: [dup] } = await q(`SELECT id, name, created_at > now() - interval '10 minutes' AS fresh FROM shluchim WHERE phone=$1 ORDER BY id DESC LIMIT 1`, [phone]);
  if (dup?.fresh) { flash(req, `החשבון של ${dup.name} כבר נוצר לפני רגע — לא נוצר חשבון כפול`); return res.redirect(`/admin/shluchim/${dup.id}`); }
  if (dup && req.body.allow_dup !== 'on') {
    flashErr(req, `כבר קיים שליח עם הנייד ${phone}: ${dup.name}. אם זה בכוונה (למשל שני חשבונות לאותו אדם) — סמנו "לאפשר נייד שכבר קיים" ונסו שוב.`);
    return res.redirect('/admin#new-shliach');
  }
  const code = codeFrom(req);
  if (!code) { flashErr(req, CODE_RULE); return res.redirect('/admin'); }
  const quota = parseQuota(req.body.sms_quota);
  if (quota.error) { flashErr(req, quota.error); return res.redirect('/admin'); }
  if (quota.value === null) quota.value = await getDefaultQuota();
  const addr = parseAddress(req.body.address);
  // הנייד של השליח משמש גם כברירת מחדל ל-SMS השבועי (שהשליח מפעיל בעצמו)
  const { rows } = await q('INSERT INTO shluchim (name, chabad_house, slug, phone, sms_phone, sms_quota, gender, use_title, sms_weekly, sms_enabled) VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$8) RETURNING id', [name, house, randomToken(9), phone, quota.value, addr.gender, addr.use_title, sms]);
  const id = rows[0].id;
  req.auditShliachId = id;
  for (const [i, [n, c]] of DEFAULT_CATEGORIES.entries()) {
    await q('INSERT INTO categories (shliach_id, name, color, sort) VALUES ($1,$2,$3,$4)', [id, n, c, i]);
  }
  const s = await setCode(req, id, code);
  if (!sms) {
    flashErr(req, `החשבון נוצר ✓ — שימו לב: ${phone} אינו נייד ישראלי, ולכן השליח לא מחובר לשירותי SMS (קוד כניסה ב-SMS ותזכורות). שלחו לו את הקישור והקוד בוואטסאפ (בכפתור למעלה); הכניסה שלו תמיד בקוד הקבוע.`);
    return res.redirect('/admin');
  }
  const sent = await sendWelcome(req, s, code, true);
  if (sent.ok) flash(req, `החשבון נוצר, והקישור והקוד נשלחו ב-SMS ל-${phone}`);
  else flashErr(req, `החשבון נוצר, אבל ה-SMS לא נשלח (${sent.error}) — אפשר לשלוח בוואטסאפ`);
  res.redirect('/admin');
}

// קוד קבוע חדש (ריק = אקראי) ושליחתו ב-SMS
app.post('/admin/shluchim/:id/code', requireAdmin, async (req, res) => {
  const code = codeFrom(req);
  if (!code) { flashErr(req, CODE_RULE); return res.redirect(`/admin/shluchim/${int(req.params.id)}`); }
  const s = await setCode(req, int(req.params.id), code);
  if (!s) return res.redirect(`/admin/shluchim/${int(req.params.id)}`);
  const sent = !s.phone ? { ok: false, error: 'לשליח אין נייד' } : !smsCapable(s.phone) ? { ok: false, error: 'נייד מחו״ל — אין SMS; שלחו בוואטסאפ' } : await sendWelcome(req, s, code);
  const msg = 'הקוד הוחלף וכל המכשירים המחוברים נותקו.';
  if (sent.ok) flash(req, `${msg} הקישור והקוד נשלחו ב-SMS ל-${s.phone}`); else flashErr(req, `${msg} ה-SMS לא נשלח (${sent.error})`);
  res.redirect(`/admin/shluchim/${int(req.params.id)}`);
});

// שליחה חוזרת של הקישור בלבד (את הקוד הקבוע השרת לא יודע — שומר רק hash)
app.post('/admin/shluchim/:id/send-link', requireAdmin, async (req, res) => {
  const { rows } = await q('SELECT id, name, slug, phone, gender, use_title FROM shluchim WHERE id=$1', [int(req.params.id)]);
  const s = rows[0];
  if (!s) return res.redirect(`/admin/shluchim/${int(req.params.id)}`);
  if (!s.phone) { flashErr(req, 'לשליח אין נייד'); return res.redirect(`/admin/shluchim/${int(req.params.id)}`); }
  if (!smsCapable(s.phone)) { flashErr(req, 'הנייד של השליח מחו״ל — אין שירותי SMS. העתיקו את הקישור ושלחו בוואטסאפ'); return res.redirect(`/admin/shluchim/${int(req.params.id)}`); }
  const sent = await sendWelcome(req, s, null);
  if (sent.ok) flash(req, `הקישור נשלח ב-SMS ל-${s.phone}`); else flashErr(req, `ה-SMS לא נשלח: ${sent.error}`);
  res.redirect(`/admin/shluchim/${int(req.params.id)}`);
});

// עריכת פרטי השליח: שם, פנייה (תואר), בית חב״ד, נייד
app.post('/admin/shluchim/:id/details', requireAdmin, async (req, res) => {
  const id = int(req.params.id), back = `/admin/shluchim/${id}`;
  const name = String(req.body.name || '').trim().slice(0, 80);
  const phone = shliachPhone(req.body.phone);
  if (!name) { flashErr(req, 'יש להזין שם'); return res.redirect(back); }
  if (!phone) { flashErr(req, PHONE_RULE); return res.redirect(back); }
  const addr = parseAddress(req.body.address);
  // שינוי נייד = שינוי היעד של קודי הכניסה — מנתקים סשנים קיימים
  const { rows: [r] } = await q(`UPDATE shluchim SET name=$1, chabad_house=$2, phone=$3, sms_phone=$3, gender=$4, use_title=$5,
      session_version=session_version + (CASE WHEN phone IS DISTINCT FROM $3 THEN 1 ELSE 0 END)
    WHERE id=$6 RETURNING id`, [name, String(req.body.chabad_house || '').trim().slice(0, 80), phone, addr.gender, addr.use_title, id]);
  if (r) {
    if (smsCapable(phone)) flash(req, 'פרטי השליח עודכנו');
    else flashErr(req, `הפרטים עודכנו ✓ — ${phone} אינו נייד ישראלי, ולכן השליח לא מחובר לשירותי SMS`);
  }
  res.redirect(back);
});

app.post('/admin/shluchim/:id/toggle', requireAdmin, async (req, res) => {
  await q('UPDATE shluchim SET active = NOT active WHERE id=$1', [int(req.params.id)]);
  res.redirect(`/admin/shluchim/${int(req.params.id)}`);
});

/* ----------------------------- שמירת מקורבים ----------------------------- */

async function validCategory(shliachId, id) {
  if (!id) return null;
  const { rowCount } = await q('SELECT 1 FROM categories WHERE id=$1 AND shliach_id=$2', [id, shliachId]);
  return rowCount ? id : null;
}

// אחרי הוספת רשומות: התראה לשליח כשמתקרבים (90%) או מגיעים למכסה — SMS פעם אחת לכל שלב (לא יורד מהמכסה)
async function recordsCheck(shliachId) {
  const st = await recordsStatus(shliachId);
  if (st.level === st.alert) return st;
  await q('UPDATE shluchim SET records_alert=$1 WHERE id=$2', [st.level, shliachId]);
  if (st.level > st.alert) {
    const { rows: [s] } = await q('SELECT * FROM shluchim WHERE id=$1', [shliachId]);
    const phone = normalizePhone(s?.phone);
    const msg = st.full
      ? `זכרתי התקשרתי: הגעתם למכסת ${st.quota} הרשומות (מקורבים ובני משפחה) — לא ניתן להוסיף עוד. להרחבה פנו למנהל: 053-340-4770`
      : `זכרתי התקשרתי: נוצלו ${st.used} מתוך ${st.quota} רשומות (נותרו ${st.left}). להרחבה פנו למנהל: 053-340-4770`;
    if (phone) sendToShliach(s, phone, msg, 'limit').catch(() => {});
    audit({ shliachId, actor: 'system', action: 'התראת מכסת רשומות', detail: `${st.used}/${st.quota}` });
  }
  return st;
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

// יארצייט חדש מקבל את תזכורת ברירת המחדל של השליח (הגדרות ← תזכורות)
const addFamily = (contactId, f) => q(
  `INSERT INTO family_members (contact_id, relation, first_name, g_date, g_after_sunset, h_day, h_month, h_year, kind, remind_days)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text, CASE WHEN $9::text='yahrzeit' THEN
     (SELECT s.yahrzeit_remind_days FROM contacts c JOIN shluchim s ON s.id=c.shliach_id WHERE c.id=$1) END)`,
  [contactId, f.relation, f.first_name, f.g_date, f.g_after_sunset, f.h_day, f.h_month, f.h_year, f.kind || 'birthday']);

// שדות טקסט נוספים שהשליח הגדיר לטופס הרישום (עד 3): בדיקת חובה, והרכבת הערה "תווית: תשובה"
function parseExtras(link, body) {
  const fields = Array.isArray(link.extra_fields) ? link.extra_fields.slice(0, 3) : [];
  const lines = [];
  for (const [i, f] of fields.entries()) {
    const v = String(body[`extra_${i}`] || '').trim().slice(0, 300);
    if (!v && f.required) return { error: `יש למלא: ${f.label}` };
    if (v) lines.push(`${f.label}${/[?:？]$/.test(f.label) ? ' ' : ': '}${v}`);
  }
  return { notes: lines.join('\n') };
}

// mode — מה נשאל בטופס: birthday (ימי הולדת) / yahrzeit (רק יארצייט) / both.
// fam מוחזר עם בני המשפחה והנפטרים יחד (kind מבדיל ביניהם)
function parseForm(body, opts = {}, mode = 'both') {
  const yzOnly = mode === 'yahrzeit';
  const yz = mode === 'birthday' ? { value: [] } : parseFamily(body.yz, 'yahrzeit');
  // בטופס יארצייט לא שואלים על תאריך הלידה; כשנרשם יארצייט — תאריך הלידה רשות
  const c = parseContact(yzOnly ? { ...body, date_type: 'h', h_day: '', h_month: '', h_year: '' } : body,
    { ...opts, birthOptional: yzOnly || (yz.value || []).length > 0 });
  if (c.error) return { error: c.error };
  if (yz.error) return { error: yz.error };
  const fam = yzOnly ? { value: [] } : parseFamily(body.fam);
  if (fam.error) return { error: fam.error };
  if (yzOnly && !yz.value.length) return { error: 'יש למלא לפחות נפטר/ת אחד/ת — שם ותאריך הפטירה' };
  return { c: c.value, fam: [...fam.value, ...yz.value] };
}
// שורות הטופס להצגה מחדש אחרי שגיאה
const formRows = (body) => ({ family: Object.values(body.fam || {}), yahrzeits: Object.values(body.yz || {}) });

/* ------------------------- קישור רישום ציבורי למקורבים ------------------------- */

app.use('/r/:token', async (req, res, next) => {
  const { rows } = await q(
    `SELECT l.*, s.name AS shliach_name, s.chabad_house FROM reg_links l JOIN shluchim s ON s.id=l.shliach_id
     WHERE l.token=$1 AND l.active AND s.active`, [req.params.token]);
  if (!rows[0]) return res.redirect('/'); // קישור רישום לא פעיל — ישר לדף הבית
  req.link = res.locals.link = rows[0];
  res.locals.noApp = true; // דפי רישום למקורבים — בלי הצעת התקנה
  next();
});

app.get('/r/:token', (req, res) => res.render('register', { values: { date_type: 'h' }, family: [], yahrzeits: [], error: null, internal: false }));

app.post('/r/:token', async (req, res) => {
  if (req.body.website) return res.render('register_done'); // מלכודת לבוטים
  if (!registerByIp.take(`reg:${req.ip}`) || !registerByLink.take(`link:${req.link.id}`)) {
    return res.status(429).render('register', {
      values: req.body, ...formRows(req.body), internal: false,
      error: 'נשלחו יותר מדי רישומים. נסו שוב בעוד כמה דקות.',
    });
  }
  const rows = (k) => Object.values(req.body[k] || {}).filter((r) => r && String(r.first_name || '').trim()).length;
  if (rows('fam') > PUBLIC_MAX_ROWS || rows('yz') > PUBLIC_MAX_ROWS) {
    return res.status(400).render('register', { values: req.body, ...formRows(req.body), internal: false,
      error: `אפשר לרשום עד ${PUBLIC_MAX_ROWS} בני משפחה ו-${PUBLIC_MAX_ROWS} יארצייטים בטופס אחד` });
  }
  const { c, fam, error } = parseForm(req.body, { bothNames: req.link.require_both_names }, req.link.date_kinds);
  const extras = parseExtras(req.link, req.body);
  // הסכמה מפורשת (חובת יידוע + אחסון בחו"ל)
  const err = error || extras.error || (req.body.privacy_ok !== 'on' ? 'יש לאשר את תנאי שמירת הפרטים (סמנו את התיבה)' : null);
  if (err) return res.status(400).render('register', { values: req.body, ...formRows(req.body), error: err, internal: false });
  c.category_id = req.link.category_id;
  c.notes = extras.notes; // תשובות לשדות הנוספים נשמרות בהערות המקורב
  // הגבלה לפי מספר הרשומות (לא רק מספר השליחות)
  const n = 1 + fam.length;
  if (!recordsByIp.takeN(`rec:${req.ip}`, n) || !recordsByLink.takeN(`link:${req.link.id}`, n)) {
    req.auditDetail = 'יותר מדי רשומות דרך הקישור — נחסם זמנית';
    return res.status(429).render('register', { values: req.body, ...formRows(req.body), internal: false,
      error: 'נרשמו יותר מדי פרטים דרך הקישור הזה בזמן קצר. נסו שוב מאוחר יותר, או פנו ישירות לשליח.' });
  }
  if (roomError(await recordsStatus(req.link.shliach_id), n)) {
    req.auditDetail = 'מכסת הרשומות מלאה';
    return res.status(409).render('register', { values: req.body, ...formRows(req.body), internal: false,
      error: 'לא ניתן להירשם כרגע (הרשימה מלאה). אפשר לפנות ישירות לשליח.' });
  }
  await saveContact(req.link.shliach_id, c, fam, req.link.id);
  await recordsCheck(req.link.shliach_id);
  res.render('register_done');
});

/* ---------------------------------- שליח ---------------------------------- */

const router = express.Router({ mergeParams: true });
app.use('/s/:slug', router);
// (חשבון ההדגמה מחובר לאותו router — ראו demoAccount למטה)

router.use(async (req, res, next) => {
  const { rows } = await q('SELECT * FROM shluchim WHERE slug=$1 AND active', [req.demo ? req.demoSlug : req.params.slug]);
  if (!rows[0]) return res.redirect('/'); // קישור שליח לא פעיל / לא קיים — ישר לדף הבית
  const s = rows[0];
  req.shliach = res.locals.shliach = s;
  res.locals.yechi = !!s.show_yechi; // לפי בחירת השליח בהגדרות (ברירת מחדל: לא מוצג)
  if (req.demo) {
    res.locals.base = '/demo';
    res.locals.noApp = true;
    req.authorized = true;
    return next();
  }
  res.locals.base = `/s/${s.slug}`;
  res.locals.manifestUrl = `/s/${s.slug}/manifest.webmanifest`;
  const sh = req.session.sh && !Array.isArray(req.session.sh) ? req.session.sh : {};
  req.authorized = sh[s.id] === s.session_version; // תמיד נדרשת כניסה בקוד
  next();
});

/* ------------------------------ חשבון הדגמה ------------------------------ */
// /demo = אותם מסכים בדיוק של שליח, על חשבון לדוגמה שנוצר בכל בקשה בתוך טרנזקציה שמבוטלת (ROLLBACK)
// כשהתשובה נשלחת. לכן שום פעולה לא נשמרת, לא נרשמת ביומן ולא שולחת SMS (sendSms חסום בהקשר הזה).
const demoHits = new Map();
const DEMO_MAX = 3;
let demoActive = 0;
const demoWaiting = [];
const demoNote = () => noteDemo(demoActive, demoWaiting.length, DEMO_MAX);
function demoSlot() {
  if (demoActive < DEMO_MAX) { demoActive++; demoNote(); return Promise.resolve(true); }
  if (demoWaiting.length >= 30) return Promise.resolve(false);
  return new Promise((resolve) => {
    const w = { resolve, timer: setTimeout(() => { demoWaiting.splice(demoWaiting.indexOf(w), 1); demoNote(); resolve(false); }, 8000) };
    demoWaiting.push(w);
    demoNote();
  });
}
function demoRelease() {
  const w = demoWaiting.shift();
  if (w) { clearTimeout(w.timer); w.resolve(true); } else demoActive--;
  demoNote();
}
async function demoAccount(req, res, next) {
  const now = Date.now(), hit = demoHits.get(req.ip);
  if (!hit || now - hit.t > 60000) demoHits.set(req.ip, { t: now, n: 1 });
  else if (++hit.n > 90) return res.status(429).render('error', { message: 'יותר מדי בקשות להדגמה — נסו שוב בעוד דקה' });
  if (demoHits.size > 5000) demoHits.clear();

  // לכל היותר DEMO_MAX בקשות הדגמה במקביל (כל אחת מחזיקה חיבור למסד) — שלא יתפסו את כל החיבורים של משתמשים אמיתיים.
  // המאזינים לסיום נרשמים מיד: גולש שסוגר את הדף בזמן ההמתנה/הטעינה לא משאיר "מקום" תפוס לתמיד
  const store = { client: null, demo: true, dead: false };
  let slot = false, closed = false, released = false;
  const finish = () => {
    if (released) return;
    released = true;
    store.dead = true; // שאילתות מאוחרות של אותה בקשה ייכשלו במקום לרוץ על חיבור משוחרר
    const c = store.client;
    if (c) c.query('ROLLBACK').catch(() => {}).finally(() => { c.release(); demoRelease(); });
    else demoRelease();
  };
  const onEnd = () => { closed = true; if (slot) finish(); };
  res.on('finish', onEnd);
  res.on('close', onEnd);
  slot = await demoSlot();
  if (!slot) { noteDemoReject(); return closed ? undefined : res.status(503).render('error', { message: 'יש עומס על חשבון ההדגמה — נסו שוב בעוד רגע' }); }
  if (closed) return finish();
  // רשת ביטחון: בקשת הדגמה לא מחזיקה מקום יותר מ-30 שניות
  setTimeout(finish, 30000).unref();
  let client;
  try { client = await pool.connect(); } catch (e) { finish(); return next(e); }
  if (released) return client.release(); // הדף נסגר בזמן ההתחברות — המקום כבר שוחרר
  store.client = client;
  req.demo = true;
  res.locals.demo = true;
  // אחרי פעולה: ההודעה מבהירה שבהדגמה זה לא נשמר
  if (req.method === 'POST') {
    const redirect = res.redirect.bind(res);
    res.redirect = (...args) => {
      const f = req.session.flash;
      if (f && typeof f === 'object') req.session.flash = { err: f.err };
      else req.session.flash = `${f ? f + ' — ' : ''}בהדגמה זה לא נשמר באמת 🙂`;
      // מקורב "חדש" לא קיים בבקשה הבאה — חוזרים לרשימה במקום לכרטיס שלו
      const i = args.length - 1;
      if (typeof args[i] === 'string') args[i] = args[i].replace(/^\/demo\/contacts\/\d+.*$/, '/demo/contacts');
      return redirect(...args);
    };
  }
  try {
    await client.query('BEGIN');
    dbStorage.run(store, async () => {
      try {
        req.demoSlug = await seedDemoAccount(DEFAULT_CATEGORIES, COLORS);
        next();
      } catch (e) { next(e); }
    });
  } catch (e) {
    finish();
    next(e);
  }
}
app.use('/demo', demoAccount, router);

const requireShliach = (req, res, next) => (req.authorized ? next() : res.redirect(res.locals.base));

router.get('/manifest.webmanifest', (req, res) => {
  const b = res.locals.base;
  res.type('application/manifest+json').send(manifest({ name: `זכרתי התקשרתי — ${req.shliach.name}`, short: 'זכרתי התקשרתי', start: b, scope: b }));
});

async function loadCategories(shliachId) {
  return (await q('SELECT * FROM categories WHERE shliach_id=$1 ORDER BY sort, id', [shliachId])).rows;
}

// "נוצר קשר" = קיים רישום יצירת קשר לאותו אדם מ-14 יום לפני יום ההולדת ואילך
const CONTACT_AFTER = 60;
async function markContacted(shliachId, events) {
  const { rows } = await q(
    `SELECT l.contact_id, l.family_member_id, l.created_at FROM contact_log l JOIN contacts c ON c.id=l.contact_id
     WHERE c.shliach_id=$1 AND l.created_at > $2`, [shliachId, addDays(events.reduce((m, e) => (e.date < m ? e.date : m), todayIL()), -15)]);
  for (const l of rows) l.day = todayIL(l.created_at); // היום בלוח ישראל (לא UTC)
  for (const e of events) {
    // חלון: משבועיים לפני יום ההולדת ועד CONTACT_AFTER ימים אחריו — רישום מאוחר יותר שייך ליום ההולדת הבא
    const from = addDays(e.date, -14), to = addDays(e.date, CONTACT_AFTER);
    e.contacted = rows.some((l) => l.contact_id === e.contact.id && (l.family_member_id ?? null) === (e.member?.id ?? null) && l.day >= from && l.day <= to);
  }
}

// דשבורד (או מסך קוד כניסה)
const VIEWS = ['today', 'week', 'month', 'range', 'missed'];
const MISSED_DAYS = [7, 14, 30, 90, 180];
const MISSED_MAX = 180; // ימי הולדת שעברו: עד חצי שנה אחורה
// ימי הולדת שעברו: ?days= (ברירת מחדל שבועיים) או ?from=&to= — תמיד עד אתמול
function pickMissed(query, today) {
  const yesterday = addDays(today, -1);
  let a = parseISO(query.from), b = parseISO(query.to);
  if (a && b) {
    if (b < a) [a, b] = [b, a];
    if (b > yesterday) b = yesterday;
    if (a > b) a = b;
    if (a < addDays(today, -MISSED_MAX)) a = addDays(today, -MISSED_MAX);
    if (a > b) a = b;
    return { start: a, end: b, days: null };
  }
  const days = MISSED_DAYS.includes(int(query.days)) ? int(query.days) : 14;
  return { start: addDays(today, -days), end: yesterday, days };
}
const MAX_RANGE_DAYS = 366;
// טווח שבחר המשתמש (?from=&to=); ברירת מחדל — 30 הימים הקרובים
function pickRange(query, today) {
  let a = parseISO(query.from), b = parseISO(query.to);
  if (!a || !b) return { start: today, end: addDays(today, 29), preset: true };
  if (b < a) [a, b] = [b, a];
  if (b - a >= MAX_RANGE_DAYS * 864e5) b = addDays(a, MAX_RANGE_DAYS - 1);
  return { start: a, end: b, preset: false };
}
router.get('/', async (req, res) => {
  if (!req.authorized) return renderLogin(req, res);
  const s = req.shliach;
  const categories = await loadCategories(s.id);
  const cat = int(req.query.cat);
  const view = req.query.view === '30' ? 'range' : VIEWS.includes(req.query.view) ? req.query.view : 'week';
  const people = await loadPeople(s.id);
  // סינון לפי סוג: הכל / ימי הולדת / יארצייט (חל על כל הדשבורד — הריבועים, הרשימות וההתראות)
  const hasYz = people.family.some((f) => f.kind === 'yahrzeit');
  const type = hasYz && ['bday', 'yz'].includes(req.query.type) ? req.query.type : '';
  const keep = type === 'yz' ? (e) => e.yahrzeit : type === 'bday' ? (e) => !e.yahrzeit : () => true;
  const collectEvents = (p, a, b) => collectAll(p, a, b).filter(keep);
  const today = todayIL();
  const w = weekRange(today), m = hebMonthRange(today), r = pickRange(view === 'range' ? req.query : {}, today);
  const from = new Date(Math.min(w.start, m.start, addDays(today, -14)));
  const to = new Date(Math.max(w.end, m.end));
  const all = collectEvents(people, from, to);
  const ranged = collectEvents(people, r.start, r.end);
  const mr = pickMissed(view === 'missed' ? req.query : {}, today);
  const missedAll = view === 'missed' ? collectEvents(people, mr.start, mr.end) : [];
  await markContacted(s.id, [...all, ...ranged, ...missedAll]);
  const inR = (e, a, b) => e.date >= a && e.date <= b;
  const same = (e) => e.date.getTime() === today.getTime();
  const lists = {
    today: all.filter(same),
    week: all.filter((e) => inR(e, w.start, w.end)),
    month: all.filter((e) => inR(e, m.start, m.end)),
    range: ranged,
    missed: missedAll.filter((e) => !e.contacted).reverse(), // מהקרוב לרחוק
  };
  const overdue = all.filter((e) => e.date < today && e.date >= addDays(today, -14) && !e.contacted);
  const upcoming = collectEvents(people, addDays(w.end, 1), addDays(w.end, 60)).slice(0, 5);
  const next = collectEvents(people, addDays(today, 1), addDays(today, 400))[0];
  const list = lists[view].filter((e) => !cat || e.contact.category_id === cat);
  const viewQ = view === 'range' ? (r.preset ? {} : { from: toISO(r.start), to: toISO(r.end) })
    : view === 'missed' ? (mr.days ? (mr.days === 14 ? {} : { days: mr.days }) : { from: toISO(mr.start), to: toISO(mr.end) }) : {};
  res.render('dashboard', {
    records: await recordsStatus(s.id),
    weekInfo: weekInfo(today), hebRangeStr, toISO,
    sms: { ...quotaStatus(s), on: s.sms_weekly || s.sms_daily, weekly: s.sms_weekly, daily: s.sms_daily },
    today, hebToday: hebToday(today), view, cat, categories, catById: new Map(categories.map((c) => [c.id, c])),
    lists, list, overdue, upcoming, next, weekRange: w, monthRange: m, range: r, missed: mr, MISSED_DAYS, maxRange: MAX_RANGE_DAYS,
    total: people.contacts.length, familyTotal: people.family.length, hasYz, type,
    qs: (o) => {
      const keep = !o.view || o.view === view ? viewQ : {};
      const p = new URLSearchParams({ view, ...keep, ...(cat ? { cat } : {}), ...(type ? { type } : {}), ...o });
      if ('days' in o) { p.delete('from'); p.delete('to'); }
      for (const [k, v] of [...p]) if (v === '' || v === 'null') p.delete(k);
      return `?${p}`;
    },
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
    error, otpSent, maskedPhone: maskPhone(s.phone), canOtp: smsCapable(s.phone) && smsConfigured(),
  });
}

router.post('/otp/send', async (req, res) => {
  const s = req.shliach;
  if (!s.phone || !smsConfigured()) { req.auditDetail = !s.phone ? 'לשליח אין נייד' : 'SMS לא מוגדר'; return renderLogin(req, res, 'לא ניתן לשלוח קוד כרגע. פנו למנהל המערכת.', 503); }
  if (!otpSendByIp.take(`otp:${req.ip}`) || !otpSendByAccount.take(`otp:s${s.id}`) || !otpSendDaily.take(`otp:s${s.id}`)) {
    return renderLogin(req, res, 'נשלחו יותר מדי קודים. נסו שוב בעוד כמה דקות.', 429);
  }
  const code = String(crypto.randomInt(100000, 1000000));
  // קוד חדש מבטל את הקודמים
  await q('UPDATE login_codes SET used=TRUE WHERE shliach_id=$1 AND NOT used', [s.id]);
  await q(`INSERT INTO login_codes (shliach_id, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [s.id, await bcrypt.hash(code, 10), OTP_TTL_MIN]);
  await q(`DELETE FROM login_codes WHERE created_at < now() - interval '1 day'`);
  try {
    await sendToShliach(s, s.phone, `קוד הכניסה שלך ל"זכרתי התקשרתי": ${code}\nבתוקף ${OTP_TTL_MIN} דקות. אין למסור אותו לאף אחד.`, 'otp');
  } catch (e) {
    console.error(`OTP לשליח ${s.id} נכשל:`, e.message);
    req.auditDetail = `שליחת SMS נכשלה: ${e.message}`; // הודעת ימות המשיח — לא מידע של השליח
    return renderLogin(req, res, 'שליחת ה-SMS נכשלה. נסו שוב בעוד רגע.', 502);
  }
  req.session.otp = { id: s.id, at: Date.now() };
  res.redirect(res.locals.base);
});

async function checkOtp(shliachId, code, ip) {
  const { rows } = await q(
    `UPDATE login_codes SET attempts=attempts+1
     WHERE id=(SELECT id FROM login_codes WHERE shliach_id=$1 AND NOT used AND expires_at > now() ORDER BY created_at DESC LIMIT 1)
       AND attempts < $2
     RETURNING id, code_hash`, [shliachId, OTP_MAX_ATTEMPTS]);
  if (!rows[0]) {
    // שליחה כפולה של הטופס (מילוי אוטומטי מה-SMS + לחיצה): הקוד כבר נוצל לפני רגע מאותה כתובת — זו אותה כניסה
    const { rows: [r] } = await q(`SELECT code_hash FROM login_codes WHERE shliach_id=$1 AND consumed_ip=$2
      AND consumed_at > now() - interval '2 minutes' ORDER BY consumed_at DESC LIMIT 1`, [shliachId, ip]);
    return r && /^\d{6}$/.test(code) && (await bcrypt.compare(code, r.code_hash)) ? 'ok' : 'expired';
  }
  if (!/^\d{6}$/.test(code) || !(await bcrypt.compare(code, rows[0].code_hash))) return 'wrong';
  await q('UPDATE login_codes SET used=TRUE, consumed_at=now(), consumed_ip=$2 WHERE id=$1', [rows[0].id, ip]);
  return 'ok';
}

router.post('/login', async (req, res) => {
  const s = req.shliach;
  const ipKey = `s${s.id}:${req.ip}`;
  const acctKey = `s${s.id}`;
  // הניסיון נספר *לפני* הבדיקה (bcrypt איטי) — כך גם בקשות מקבילות לא עוקפות את המגבלה
  if (!loginByIp.take(ipKey)) return renderLogin(req, res, 'יותר מדי ניסיונות. נסו שוב מאוחר יותר.', 429);
  // חשבון שנחסם (ניסיונות מכל הכתובות) — עדיין אפשר להיכנס עם קוד חד-פעמי מה-SMS, כדי שתוקף לא ינעל את הבעלים
  const acctOpen = loginByAccount.take(acctKey);
  const code = String(req.body.code || '').trim();
  // קודם הקוד הקבוע; אם לא תאם — קוד חד-פעמי פעיל (אם נשלח)
  let ok = acctOpen && !!s.access_code_hash && (await bcrypt.compare(code, s.access_code_hash));
  let otp = null;
  if (!ok) { otp = await checkOtp(s.id, code, req.ip); ok = otp === 'ok'; }
  if (!ok) {
    if (!acctOpen) return renderLogin(req, res, 'יותר מדי ניסיונות לחשבון הזה. אפשר להיכנס עם קוד חד-פעמי ב-SMS, או לנסות שוב מאוחר יותר.', 429);
    req.auditDetail = 'קוד שגוי';
    if (otp === 'expired' && req.session.otp?.id === s.id) {
      req.session.otp = undefined;
      return renderLogin(req, res, 'הקוד שגוי, והקוד החד-פעמי פג תוקף או שנוצלו כל הניסיונות. אפשר לשלוח קוד חדש.', 401);
    }
    return renderLogin(req, res, 'קוד שגוי', 401);
  }
  loginByIp.reset(ipKey);
  loginByAccount.undo(acctKey);
  req.auditDetail = otp === 'ok' ? 'בקוד חד-פעמי' : 'בקוד קבוע';
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

/* ------------------------- ייבוא מקורבים מאקסל (הדבקה) ------------------------- */

// ייצוא כל הרשימה לקובץ (אקסל/CSV) — לגיבוי אישי, לבקשות עיון, או לפני סגירת חשבון
router.get('/contacts/export.csv', async (req, res) => {
  const s = req.shliach;
  const { contacts, family } = await loadPeople(s.id);
  const cats = new Map((await loadCategories(s.id)).map((c) => [c.id, c.name]));
  // תא בטוח לאקסל: מרכאות, ומניעת "הזרקת נוסחה" (= או @ בהתחלה, או +/- שלא לפני מספר טלפון)
  const cell = (v) => { let t = String(v ?? ''); if (/^[=@\t\r]|^[+\-](?![\d\s(])/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
  const heb = (p) => (p.h_day ? hebDateStr(p.h_day, p.h_month, p.h_year) : '');
  const lines = [['סוג', 'שם פרטי', 'שם משפחה', 'קשר', 'שייך ל', 'טלפון', 'תאריך עברי', 'תאריך לועזי', 'סיווג', 'הערות'].map(cell).join(',')];
  const byId = new Map(contacts.map((c) => [c.id, c]));
  for (const c of contacts) lines.push(['מקורב', c.first_name, c.last_name, '', '', c.phone, heb(c), c.g_date || '', cats.get(c.category_id) || '', c.notes].map(cell).join(','));
  for (const f of family) {
    const c = byId.get(f.contact_id);
    lines.push([f.kind === 'yahrzeit' ? 'יארצייט (תאריך פטירה)' : 'בן משפחה', f.first_name, '', f.relation, c ? `${c.first_name} ${c.last_name}`.trim() : '', '', heb(f), f.g_date || '', '', ''].map(cell).join(','));
  }
  if (!req.demo) audit({ shliachId: s.id, actor: 'shliach', action: 'ייצוא רשימה לקובץ', detail: `${contacts.length + family.length} רשומות` });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="mekoravim-${toISO(todayIL())}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n'));
});

router.get('/contacts/import', async (req, res) => {
  res.render('import', { text: '', rows: null, mapping: [], categories: await loadCategories(req.shliach.id), defaultCategory: null, error: null, IMPORT_FIELDS });
});

// שלב 1: תצוגה מקדימה (action=preview), שלב 2: שמירה (action=save). הטבלה נשלחת מחדש בכל שלב — אין מצב בשרת
router.post('/contacts/import', async (req, res) => {
  const s = req.shliach;
  let categories = await loadCategories(s.id);
  let text = String(req.body.text || '');
  const defaultCategory = categories.some((c) => c.id === int(req.body.category_id)) ? int(req.body.category_id) : null;
  const render = (o) => res.render('import', { text, categories, defaultCategory, IMPORT_FIELDS, rows: null, mapping: [], error: null, newCats: [], createCats: true, ...o });
  if (req.body.action === 'reset') { req.skipAudit = true; text = ''; return render({}); }
  let table = splitTable(text);
  if (!table.length) { req.skipAudit = true; return render({ error: 'לא הודבקו נתונים' }); }
  // בדיקת הגודל לפני כל עיבוד (הדבקה ענקית לא תפיל את השרת)
  if (table.length > IMPORT_MAX + 1) { req.skipAudit = true; text = ''; return render({ error: `אפשר לייבא עד ${IMPORT_MAX} שורות בפעם אחת (הודבקו ${table.length})` }); }
  const guess = guessMapping(table);
  const width = table.reduce((m, r) => Math.max(m, r.length), 0);
  // שיוך עמודות שהמשתמש בחר בתצוגה המקדימה (אם יש), אחרת הניחוש
  const chosen = Array.from({ length: width }, (_, i) => req.body[`col${i}`]);
  const mapping = chosen.every((v) => Object.hasOwn(IMPORT_FIELDS, v)) ? chosen : guess.mapping;
  const hasHeader = req.body.has_header !== undefined ? [].concat(req.body.has_header).includes('1') : guess.hasHeader;
  const header = hasHeader ? table[0] : null;
  if (hasHeader) table = table.slice(1);
  // הטקסט מוחזר מנורמל (טאבים, שורה לכל מקורב) — כך אפשר לתקן כל שורה בתצוגה המקדימה
  text = toTSV(header ? [header, ...table] : table);
  if (table.length > IMPORT_MAX) { req.skipAudit = true; return render({ error: `אפשר לייבא עד ${IMPORT_MAX} שורות בפעם אחת (הודבקו ${table.length})` }); }
  if (!mapping.includes('first_name') && !mapping.includes('full_name')) { req.skipAudit = true; return render({ error: 'יש לבחור עמודה של שם פרטי או שם מלא', rows: [], mapping, header, hasHeader, width }); }

  // סיווגים שלא קיימים: אפשר ליצור אותם (ברירת מחדל: כן)
  const createCats = req.body.create_cats === undefined ? true : [].concat(req.body.create_cats).includes('1');
  const ci = mapping.indexOf('category');
  const known = new Set(categories.map((c) => c.name.trim()));
  const newCatCounts = new Map();
  if (ci >= 0) for (const r of table) { const n = (r[ci] || '').trim().slice(0, 40); if (n && !known.has(n)) newCatCounts.set(n, (newCatCounts.get(n) || 0) + 1); }
  const newCats = [...newCatCounts].slice(0, 20).map(([name, count]) => ({ name, count }));
  if (req.body.action === 'save' && createCats && newCats.length) {
    for (const [i, c] of newCats.entries()) {
      await q('INSERT INTO categories (shliach_id, name, color, sort) VALUES ($1,$2,$3,(SELECT coalesce(max(sort),0)+1 FROM categories WHERE shliach_id=$1))',
        [s.id, c.name, COLORS[(categories.length + i) % COLORS.length]]);
    }
    categories = await loadCategories(s.id);
  }

  const { rows: existing } = await q('SELECT first_name, last_name, phone, h_day, h_month FROM contacts WHERE shliach_id=$1', [s.id]);
  const seen = new Set(existing.map(dupKey));
  const rows = table.map((cells, i) => {
    const r = parseRow(cells, mapping, { categories, defaultCategory });
    const out = { n: i + 1, line: i + (hasHeader ? 1 : 0), cells, ...r };
    if (r.value) {
      const k = dupKey(r.value);
      if (seen.has(k)) out.dup = true; else seen.add(k);
    }
    return out;
  });
  const ok = rows.filter((r) => r.value && !r.dup);

  const rec = await recordsStatus(s.id);
  const room = roomError(rec, ok.length);
  if (req.body.action !== 'save' || room) {
    req.skipAudit = req.body.action !== 'save'; // תצוגה מקדימה לא נרשמת ביומן
    return render({ rows, mapping, header, hasHeader, width, okCount: ok.length, newCats, createCats, error: room });
  }
  for (const r of ok) await saveContact(s.id, r.value, [], null);
  await recordsCheck(s.id);
  const skipped = rows.length - ok.length;
  const made = createCats ? newCats.length : 0;
  req.auditDetail = `נוספו ${ok.length}${skipped ? `, דולגו ${skipped}` : ''}${made ? `, סיווגים חדשים ${made}` : ''}`; // מספרים בלבד
  flash(req, `נוספו ${ok.length} מקורבים${made ? ` ו-${made} סיווגים חדשים` : ''}${skipped ? ` (${skipped} שורות דולגו — שגיאה או כפילות)` : ''}`);
  res.redirect(`${res.locals.base}/contacts`);
});

router.get('/contacts/new', async (req, res) => {
  res.render('register', { values: { date_type: 'h' }, family: [], yahrzeits: [], error: null, internal: true, categories: await loadCategories(req.shliach.id) });
});

router.post('/contacts/new', async (req, res) => {
  const { c, fam, error } = parseForm(req.body);
  if (error) {
    return res.status(400).render('register', {
      values: req.body, ...formRows(req.body), error, internal: true, categories: await loadCategories(req.shliach.id),
    });
  }
  const full = roomError(await recordsStatus(req.shliach.id), 1 + fam.length);
  if (full) {
    return res.status(409).render('register', {
      values: req.body, ...formRows(req.body), error: full, internal: true, categories: await loadCategories(req.shliach.id),
    });
  }
  const id = await saveContact(req.shliach.id, c, fam, null);
  await recordsCheck(req.shliach.id);
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
    `SELECT l.*, f.first_name AS member_name, f.kind AS member_kind FROM contact_log l LEFT JOIN family_members f ON f.id=l.family_member_id
     WHERE l.contact_id=$1 ORDER BY l.created_at DESC`, [c.id])).rows;
  const link = c.reg_link_id ? (await q('SELECT name FROM reg_links WHERE id=$1', [c.reg_link_id])).rows[0] : null;
  const today = todayIL();
  c.next = nextBirthday(c, today);
  for (const f of family) f.next = nextBirthday(f, today);
  res.render('contact', {
    c, family, log, link, values: formValues(c), formValues, wa: whatsappLink(c.phone), categories: await loadCategories(req.shliach.id), fmtDate,
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

// תזכורת SMS אישית על המקורב / בן משפחה / יארצייט (0–30 ימים לפני; ריק = בלי). נשלחת גם אם התזכורות הכלליות כבויות
function remindDays(v) {
  const d = v === '' || v === undefined || v === null ? null : parseInt(v, 10);
  return Number.isInteger(d) && d >= 0 && d <= 30 ? d : null;
}
const remindText = (d) => (d === 0 ? 'ביום עצמו' : d === 1 ? 'יום לפני' : `${d} ימים לפני`);

router.post('/contacts/:id/family/:fid/remind', loadContact, async (req, res) => {
  const days = remindDays(req.body.remind_days);
  const { rowCount } = await q('UPDATE family_members SET remind_days=$1 WHERE id=$2 AND contact_id=$3', [days, int(req.params.fid), req.contact.id]);
  if (rowCount) flash(req, days === null ? 'התזכורת בוטלה' : `נשמר — תקבלו SMS ${remindText(days)}`);
  res.redirect(`${res.locals.base}/contacts/${req.contact.id}#family`);
});

// הפרדת בן משפחה לכרטיס מקורב נפרד: התאריכים, התזכורת והיסטוריית "יצרתי קשר" עוברים איתו
router.post('/contacts/:id/family/:fid/split', loadContact, async (req, res) => {
  const c = req.contact;
  const newId = await transaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM family_members WHERE id=$1 AND contact_id=$2 AND kind='birthday' FOR UPDATE`, [int(req.params.fid), c.id]);
    const f = rows[0];
    if (!f) return null;
    const ins = await client.query(
      `INSERT INTO contacts (shliach_id, first_name, last_name, phone, notes, g_date, g_after_sunset, h_day, h_month, h_year, category_id, remind_days)
       VALUES ($1,$2,$3,'',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.shliach.id, f.first_name, c.last_name, `${f.relation} של ${c.first_name} ${c.last_name}`.slice(0, 1000),
        f.g_date, f.g_after_sunset, f.h_day, f.h_month, f.h_year, c.category_id, f.remind_days]);
    await client.query('UPDATE contact_log SET contact_id=$1, family_member_id=NULL WHERE family_member_id=$2', [ins.rows[0].id, f.id]);
    await client.query('DELETE FROM family_members WHERE id=$1', [f.id]);
    return ins.rows[0].id;
  });
  if (!newId) return res.redirect(`${res.locals.base}/contacts/${c.id}#family`);
  flash(req, 'בן המשפחה הועבר לכרטיס נפרד');
  res.redirect(`${res.locals.base}/contacts/${newId}`);
});

router.post('/contacts/:id/remind', loadContact, async (req, res) => {
  const days = remindDays(req.body.remind_days);
  await q('UPDATE contacts SET remind_days=$1 WHERE id=$2', [days, req.contact.id]);
  const s = req.shliach;
  const phone = normalizePhone(s.phone);
  flash(req, days === null ? 'התזכורת על המקורב בוטלה'
    : `נשמר — תקבלו SMS ${remindText(days)}${phone ? '' : ' (שימו לב: אין מספר נייד בהגדרות)'}`);
  res.redirect(`${res.locals.base}/contacts/${req.contact.id}`);
});

router.post('/contacts/:id/delete', loadContact, async (req, res) => {
  await q('DELETE FROM contacts WHERE id=$1', [req.contact.id]);
  flash(req, 'המקורב נמחק');
  res.redirect(`${res.locals.base}/contacts`);
});

router.post('/contacts/:id/family', loadContact, async (req, res) => {
  const url = `${res.locals.base}/contacts/${req.contact.id}`;
  const yz = req.body.kind === 'yahrzeit';
  const fam = parseFamily([req.body], yz ? 'yahrzeit' : 'birthday');
  if (fam.error || !fam.value.length) return res.redirect(`${url}?err=${encodeURIComponent(fam.error || 'יש להזין שם')}#family`);
  const full = roomError(await recordsStatus(req.shliach.id), 1);
  if (full) return res.redirect(`${url}?err=${encodeURIComponent(full)}#family`);
  await addFamily(req.contact.id, fam.value[0]);
  await recordsCheck(req.shliach.id);
  flash(req, yz ? 'היארצייט נוסף' : 'בן המשפחה נוסף');
  res.redirect(url + '#family');
});

// עריכת בן משפחה / יארצייט: קרבה, שם ותאריך (לידה / פטירה)
router.post('/contacts/:id/family/:fid', loadContact, async (req, res) => {
  const url = `${res.locals.base}/contacts/${req.contact.id}`;
  const { rows: [f] } = await q('SELECT id, kind FROM family_members WHERE id=$1 AND contact_id=$2', [int(req.params.fid), req.contact.id]);
  if (!f) return res.redirect(url + '#family');
  const fam = parseFamily([req.body], f.kind);
  if (fam.error || !fam.value.length) return res.redirect(`${url}?err=${encodeURIComponent(fam.error || 'יש להזין שם')}#family`);
  const v = fam.value[0];
  await q(`UPDATE family_members SET relation=$1, first_name=$2, g_date=$3, g_after_sunset=$4, h_day=$5, h_month=$6, h_year=$7
           WHERE id=$8 AND contact_id=$9`,
    [v.relation, v.first_name, v.g_date, v.g_after_sunset, v.h_day, v.h_month, v.h_year, f.id, req.contact.id]);
  flash(req, f.kind === 'yahrzeit' ? 'פרטי היארצייט עודכנו' : 'פרטי בן המשפחה עודכנו');
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
  const { rows } = await q('INSERT INTO contact_log (contact_id, family_member_id, note) VALUES ($1,$2,$3) RETURNING id',
    [req.contact.id, fid, String(req.body.note || '').trim().slice(0, 500)]);
  // מהדשבורד (fetch): תשובת JSON — החלון הקליל "נשמר בהצלחה" מציע להוסיף הערה / איך נוצר הקשר
  if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true, id: rows[0].id, demo: !!req.demo });
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
    await q(`DELETE FROM contact_log WHERE contact_id=$1 AND family_member_id IS NOT DISTINCT FROM $2
               AND (created_at AT TIME ZONE 'Asia/Jerusalem')::date BETWEEN $3 AND $4`,
      [req.contact.id, int(req.body.family_member_id), toISO(addDays(d, -14)), toISO(addDays(d, CONTACT_AFTER))]);
    flash(req, 'הסימון בוטל');
  }
  res.redirect(res.locals.base + (String(req.body.back || '').startsWith('?') ? String(req.body.back).slice(0, 200) : ''));
});

// הערה / אופן יצירת הקשר לרישום שנוצר עכשיו (מהחלון שאחרי "יצרתי קשר")
const CONTACT_METHODS = ['וואטסאפ', 'שיחת טלפון', 'SMS', 'פגישה', 'אחר'];
router.post('/contacts/:id/log/:lid/note', loadContact, async (req, res) => {
  const method = CONTACT_METHODS.includes(req.body.method) ? req.body.method : '';
  const note = String(req.body.note || '').trim().slice(0, 450);
  const text = [method, note].filter(Boolean).join(' — ');
  if (text) await q('UPDATE contact_log SET note=$1 WHERE id=$2 AND contact_id=$3', [text, int(req.params.lid), req.contact.id]);
  res.json({ ok: true, demo: !!req.demo });
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

const DATE_KINDS = ['birthday', 'yahrzeit', 'both'];
const dateKinds = (v) => (DATE_KINDS.includes(v) ? v : 'birthday');

router.post('/links', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80) || 'קישור רישום';
  await q('INSERT INTO reg_links (shliach_id, token, name, category_id, date_kinds) VALUES ($1,$2,$3,$4,$5)',
    [req.shliach.id, randomToken(9), name, await validCategory(req.shliach.id, int(req.body.category_id)), dateKinds(req.body.date_kinds)]);
  flash(req, 'נוצר קישור רישום חדש');
  res.redirect(`${res.locals.base}/links`);
});

router.post('/links/:id', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (name) {
    const extra = [0, 1, 2].map((i) => ({
      label: String(req.body[`extra_label_${i}`] || '').trim().slice(0, 60),
      required: req.body[`extra_req_${i}`] === 'on',
    })).filter((f) => f.label);
    await q(`UPDATE reg_links SET name=$1, category_id=$2, form_title=$3, form_intro=$4, extra_fields=$5, require_both_names=$8, date_kinds=$9
             WHERE id=$6 AND shliach_id=$7`,
      [name, await validCategory(req.shliach.id, int(req.body.category_id)),
        String(req.body.form_title || '').trim().slice(0, 80), String(req.body.form_intro || '').trim().slice(0, 300),
        JSON.stringify(extra), int(req.params.id), req.shliach.id, req.body.names === 'both', dateKinds(req.body.date_kinds)]);
    flash(req, 'הקישור והטופס עודכנו');
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
    error, records: await recordsStatus(req.shliach.id), openProfile: !!req.openProfile, needCurrent: !!req.shliach.access_code_hash && !recentOtp(req), canOtp: smsCapable(req.shliach.phone) && smsConfigured(), categories: await loadCategories(req.shliach.id),
    catCounts: Object.fromEntries((await q('SELECT category_id, count(*)::int AS n FROM contacts WHERE shliach_id=$1 AND category_id IS NOT NULL GROUP BY 1', [req.shliach.id])).rows.map((r) => [r.category_id, r.n])),
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
  if ((weekly || daily) && !s.phone) return renderSettings(req, res, 'כדי להפעיל תזכורות יש להזין מספר נייד בפרטים האישיים', 400);
  if ((weekly || daily) && !smsCapable(s.phone)) return renderSettings(req, res, 'תזכורות SMS זמינות רק לנייד ישראלי — המספר שלך מחו״ל', 400);
  const yzDays = remindDays(req.body.yahrzeit_remind_days);
  await q('UPDATE shluchim SET sms_weekly=$1, sms_daily=$2, sms_enabled=$3, yahrzeit_remind_days=$5 WHERE id=$4',
    [weekly, daily, weekly || daily, s.id, yzDays]);
  if (req.body.yz_apply_all === 'on') {
    await q(`UPDATE family_members SET remind_days=$1 WHERE kind='yahrzeit' AND contact_id IN (SELECT id FROM contacts WHERE shliach_id=$2)`, [yzDays, s.id]);
  }
  const what = [weekly && 'בכל יום ראשון — ימי ההולדת של השבוע', daily && 'בכל יום חול שיש בו ימי הולדת — ימי ההולדת של היום'].filter(Boolean);
  flash(req, what.length ? `נשמר — תקבלו SMS ${what.join(', וגם ')}` : 'נשמר — התזכורות כבויות');
  res.redirect(back);
});

// בדיקת "הקוד הנוכחי" בהגדרות — באותה מגבלת ניסיונות של הכניסה, שעוגיית כניסה גנובה לא תאפשר לנחש את הקוד
async function currentCodeOk(req, s) {
  const key = `s${s.id}`;
  if (!loginByAccount.take(key)) return false;
  const ok = await bcrypt.compare(String(req.body.current || '').trim(), s.access_code_hash);
  if (ok) loginByAccount.undo(key);
  return ok;
}

router.post('/settings', async (req, res) => {
  const s = req.shliach;
  const back = `${res.locals.base}/settings`;
  const fail = (error) => renderSettings(req, res, error, 400);
  const a = req.body.action;

  if (a === 'profile' || a === 'code') req.openProfile = true;
  if (a === 'profile') {
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (!name) return fail('יש להזין שם');
    const house = String(req.body.chabad_house || '').trim().slice(0, 80);
    const rawPhone = String(req.body.phone || '').trim();
    const phone = rawPhone ? shliachPhone(rawPhone) : '';
    if (rawPhone && !phone) return fail(PHONE_RULE);
    const phoneChanged = phone !== (s.phone || '');
    // שינוי הנייד (שאליו נשלח קוד הכניסה החד-פעמי) דורש את הקוד הנוכחי, כמו החלפת קוד
    if (phoneChanged && s.access_code_hash && !recentOtp(req) && !(await currentCodeOk(req, s))) {
      return fail('כדי לשנות את הנייד יש להזין את קוד הכניסה הנוכחי');
    }
    const addr = parseAddress(req.body.address);
    if (!phone && (s.sms_weekly || s.sms_daily)) return fail('תזכורות ה-SMS נשלחות לנייד הזה — כדי להסיר אותו, כבו קודם את התזכורות');
    const { rows: [u] } = await q(`UPDATE shluchim SET name=$1, chabad_house=$2, phone=$3, gender=$4, use_title=$5,
             sms_phone=$3,
             session_version=session_version + (CASE WHEN phone IS DISTINCT FROM $3 THEN 1 ELSE 0 END)
           WHERE id=$6 RETURNING session_version`,
      [name, house, phone, addr.gender, addr.use_title, s.id]);
    // שינוי נייד מנתק את שאר המכשירים (כמו החלפת קוד) — המכשיר הנוכחי נשאר מחובר
    if (phoneChanged) req.session.sh = { ...(Array.isArray(req.session.sh) ? {} : req.session.sh), [s.id]: u.session_version };
    req.auditDetail = phoneChanged ? 'כולל שינוי נייד' : undefined;
    flash(req, 'הפרטים עודכנו');
  } else if (a === 'yechi') {
    await q('UPDATE shluchim SET show_yechi=$1 WHERE id=$2', [req.body.show_yechi === 'on', s.id]);
    flash(req, req.body.show_yechi === 'on' ? 'יחי אדוננו יוצג בתחתית הדפים' : 'יחי אדוננו הוסתר');
  } else if (a === 'address') {
    const addr = parseAddress(req.body.address);
    await q('UPDATE shluchim SET gender=$1, use_title=$2 WHERE id=$3', [addr.gender, addr.use_title, s.id]);
    flash(req, 'הפנייה עודכנה');
  } else if (a === 'code') {
    if (s.access_code_hash && !recentOtp(req) && !(await currentCodeOk(req, s))) return fail('הקוד הנוכחי שגוי (או יותר מדי ניסיונות — נסו שוב מאוחר יותר)');
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
  if (res.headersSent || err?.message === 'demo request closed') return; // הלקוח כבר התנתק
  res.locals.v ??= ASSET_V; // שגיאה לפני שהמשתנים לתבניות הוגדרו (למשל גוף בקשה גדול מדי)
  // שגיאות לקוח (גוף גדול מדי / פגום) — הודעה ברורה, לא "שגיאת שרת"
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).render('error', { message: err.type === 'entity.too.large' ? 'הנתונים שנשלחו גדולים מדי. נסו לחלק לכמה חלקים.' : 'הבקשה אינה תקינה.' });
  }
  console.error(err);
  // ביומן רק סוג השגיאה והנתיב הכללי — לא הודעת השגיאה (עלולה לכלול נתונים)
  const where = req.route ? (req.shliach ? `/s/…${req.route.path}` : req.baseUrl + req.route.path) : req.method;
  if (!req.demo) audit({ shliachId: req.shliach?.id ?? null, actor: 'system', action: 'שגיאת שרת', outcome: 'error', detail: `${req.method} ${where} · ${err.code || err.name || 'Error'}` });
  res.status(500).render('error', { message: 'אירעה שגיאה. נסו שוב.' });
});

export { app };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`listening on ${port}`));
  audit({ actor: 'system', action: 'הפעלת השרת' });
  pruneAudit().catch(() => {});
  setInterval(() => pruneAudit().catch(() => {}), 24 * 3600 * 1000);
  startScheduler();
}
