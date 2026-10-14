// יומן פעולות למנהל — לאיתור תקלות ולהיסטוריה של כל שליח, בלי לחשוף את המידע הפרטי של השליחים:
// בפעולות של שליח / רישום ציבורי נשמרים רק סוג הפעולה והתוצאה (הצליח / נכשל / נחסם), לעולם לא
// שמות, טלפונים, הערות או טקסט חופשי. פרטים (detail) נשמרים רק בפעולות מנהל ומערכת, ועוברים מיסוך מספרים.
import { q } from './db.js';

export const RETENTION_DAYS = 180;

// מיסוך רצפי ספרות ארוכים (טלפונים וכד׳): 0521234567 → 05•••••567
export function scrub(text) {
  return String(text || '')
    .replace(/\d[\d\s-]{7,}\d/g, (m) => { const d = m.replace(/\D/g, ''); return `\u2066${d.slice(0, 2)}•••••${d.slice(-3)}\u2069`; }) // בידוד כיוון (LRI…PDI) בתוך טקסט עברי
    .slice(0, 300);
}

// actor: admin / shliach / public / system. outcome: ok / fail / blocked / error
export function audit({ shliachId = null, actor, action, outcome = 'ok', detail = '' }) {
  q('INSERT INTO activity_log (shliach_id, actor, action, outcome, detail) VALUES ($1,$2,$3,$4,$5)',
    [shliachId, actor, action, outcome, scrub(detail)])
    .catch((e) => console.error('audit:', e.message));
}

export async function pruneAudit() {
  await q(`DELETE FROM activity_log WHERE created_at < now() - make_interval(days => $1)`, [RETENTION_DAYS]);
}

// שמות הפעולות לפי נתיב (POST). מפתח: '<scope> <route pattern>'
const ACTIONS = {
  'admin /admin/login': 'כניסת מנהל',
  'admin /admin/logout': 'יציאת מנהל',
  'admin /admin/sms-quota': 'מכסת SMS התחלתית',
  'admin /admin/shluchim': 'יצירת שליח',
  'admin /admin/shluchim/:id/code': 'קוד חדש לשליח',
  'admin /admin/shluchim/:id/send-link': 'שליחת קישור לשליח',
  'admin /admin/shluchim/:id/house': 'עדכון בית חב״ד',
  'admin /admin/shluchim/:id/phone': 'עדכון נייד שליח',
  'admin /admin/shluchim/:id/toggle': 'השבתה/הפעלה של שליח',
  'admin /admin/shluchim/:id/quota': 'עדכון מכסת SMS',
  'public /r/:token': 'רישום מקורב בקישור',
  'shliach /otp/send': 'בקשת קוד חד-פעמי',
  'shliach /login': 'כניסה לחשבון',
  'shliach /logout': 'יציאה מהחשבון',
  'shliach /contacts/new': 'הוספת מקורב',
  'shliach /contacts/import': 'ייבוא מקורבים מאקסל',
  'shliach /contacts/:id': 'עריכת מקורב',
  'shliach /contacts/:id/category': 'שינוי סיווג',
  'shliach /contacts/:id/remind': 'תזכורת SMS על מקורב',
  'shliach /contacts/:id/family/:fid/remind': 'תזכורת SMS על בן משפחה',
  'shliach /contacts/:id/family/:fid/split': 'הפרדת בן משפחה לכרטיס נפרד',
  'shliach /contacts/:id/delete': 'מחיקת מקורב',
  'shliach /contacts/:id/family': 'הוספת בן משפחה',
  'shliach /contacts/:id/family/:fid/delete': 'מחיקת בן משפחה',
  'shliach /contacts/:id/log': 'סימון "יצרתי קשר"',
  'shliach /contacts/:id/unlog': 'ביטול "יצרתי קשר"',
  'shliach /contacts/:id/log/:lid/delete': 'מחיקת רישום קשר',
  'shliach /links': 'יצירת קישור רישום',
  'shliach /links/:id': 'עריכת קישור רישום',
  'shliach /links/:id/toggle': 'השבתה/הפעלה של קישור רישום',
  'shliach /sms': 'הגדרות SMS',
  'shliach /settings': 'הגדרות',
};
// פעולות הגדרות לפי action בטופס (ערכים קבועים — לא קלט חופשי)
const SETTINGS_ACTIONS = { profile: 'עדכון פרטים אישיים', address: 'שינוי פנייה (שליח/שלוחה)', code: 'החלפת קוד כניסה', cat_add: 'הוספת סיווג', cat_update: 'עריכת סיווג', cat_delete: 'מחיקת סיווג', test: 'הודעת SMS לניסיון' };

// middleware: רושם כל POST אחרי שהתשובה נשלחה
export function auditRequests(req, res, next) {
  if (req.method !== 'POST') return next();
  res.on('finish', () => {
    if (!req.route || req.skipAudit || req.demo) return; // 404 / פעולה שלא נרשמת / חשבון הדגמה
    const scope = req.shliach ? 'shliach' : req.link ? 'public' : req.path.startsWith('/admin') ? 'admin' : null;
    if (!scope) return;
    let action = ACTIONS[`${scope} ${scope === 'shliach' ? req.route.path : req.baseUrl.replace(/\/r\/[^/]+$/, '/r/:token') + req.route.path}`];
    if (!action) return;
    if ((req.route.path === '/settings' || req.route.path === '/sms') && SETTINGS_ACTIONS[req.body?.action]) action = SETTINGS_ACTIONS[req.body.action];
    const flashErr = req.session?.flash?.err;
    const outcome = res.statusCode >= 500 ? 'error' : res.statusCode === 429 ? 'blocked' : (res.statusCode >= 400 || flashErr) ? 'fail' : 'ok';
    // מנהל: ההודעה שהוצגה לו (אין בה מידע של שליחים). שליח/ציבורי: רק פרט מערכת מפורש (req.auditDetail)
    const detail = scope === 'admin' ? (flashErr || (typeof req.session?.flash === 'string' ? req.session.flash : '') || req.auditDetail || '') : (req.auditDetail || '');
    const shliachId = req.shliach?.id ?? req.link?.shliach_id ?? (scope === 'admin' ? parseInt(req.params?.id, 10) || req.auditShliachId || null : null);
    audit({ shliachId, actor: scope, action, outcome, detail });
  });
  next();
}
