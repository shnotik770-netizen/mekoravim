import { parseISO, toISO, todayIL, hebFromGreg, parseHebYear, parseHebDay, parseHebMonth, parseGregInput, hebDateStr, hebYearStr, normalizeHeb, hebOccurrence } from './dates.js';

const clean = (v, max = 100) => String(v ?? '').trim().slice(0, max);

export const RELATIONS = ['בן/בת זוג', 'בן', 'בת', 'אבא', 'אמא', 'אח', 'אחות', 'סבא', 'סבתא', 'נכד/ה', 'אחר'];

// האם מולא תאריך כלשהו (לטופס שבו תאריך הלידה רשות)
export const hasDate = (b) => (b.date_type === 'g' ? !!String(b.g_date || '').trim() : !!(b.h_day || b.h_month || String(b.h_year || '').trim()));

// קורא את שדות התאריך מטופס. מחזיר { value } או { error }. death: תאריך פטירה (יארצייט)
export function parseBirth(b, { death = false } = {}) {
  const what = death ? 'הפטירה' : 'הלידה';
  const type = b.date_type === 'h' ? 'h' : 'g';
  if (type === 'g') {
    const d = parseGregInput(b.g_date);
    if (!d) return { error: `יש להזין תאריך ${what} לועזי מלא (יום.חודש.שנה, למשל 15.3.1990)` };
    if (d > todayIL() || d.getFullYear() < 1900) return { error: `תאריך ${what} הלועזי אינו תקין` };
    const afterSunset = b.after_sunset === 'on' || b.after_sunset === '1';
    const h = hebFromGreg(d, afterSunset);
    return { value: { g_date: toISO(d), g_after_sunset: afterSunset, h_day: h.day, h_month: h.month, h_year: h.year } };
  }
  const year = parseHebYear(b.h_year);
  if (Number.isNaN(year)) return { error: `שנת ${what} העברית אינה תקינה (לדוגמה: תש"נ או 5750)` };
  const day = parseHebDay(b.h_day);
  if (Number.isNaN(day) && String(b.h_day || '').trim()) return { error: 'היום העברי אינו תקין — מספר (1–30) או אותיות (למשל ט״ו)' };
  const month = parseHebMonth(b.h_month);
  if (Number.isNaN(month) && String(b.h_month || '').trim()) return { error: 'החודש העברי לא זוהה — למשל ניסן, חשוון, אדר ב׳' };
  const h = normalizeHeb(day, month, year);
  if (h.error) return h;
  if (h.value.year && hebOccurrence(h.value.day, h.value.month, h.value.year) > todayIL()) return { error: `תאריך ${what} העברי עוד לא הגיע — בדקו את השנה` };
  return { value: { g_date: null, g_after_sunset: false, h_day: h.value.day, h_month: h.value.month, h_year: h.value.year } };
}

// bothNames: לחייב גם שם פרטי וגם שם משפחה (בטופס רישום ציבורי — לפי הגדרת הקישור). אחרת מספיק אחד מהם
// birthOptional: בלי תאריך לידה בכלל זה בסדר (טופס יארצייט / כשנרשם יארצייט)
export function parseContact(b, { bothNames = false, birthOptional = false } = {}) {
  const first_name = clean(b.first_name, 60);
  const last_name = clean(b.last_name, 60);
  const phone = clean(b.phone, 30).replace(/[^\d+\-\s]/g, '');
  if (bothNames && (!first_name || !last_name)) return { error: 'יש למלא שם פרטי ושם משפחה' };
  if (!first_name && !last_name) return { error: 'יש למלא שם פרטי או שם משפחה' };
  // טלפון לא חובה; אם הוזן — צריך להיות תקין
  if (phoneError(phone)) return { error: phoneError(phone) };
  const noBirth = birthOptional && !hasDate(b);
  const birth = noBirth ? { value: { g_date: null, g_after_sunset: false, h_day: null, h_month: null, h_year: null } } : parseBirth(b);
  if (birth.error) return birth;
  const category_id = parseInt(b.category_id, 10) || null;
  return { value: { first_name, last_name, phone, notes: clean(b.notes, 1000), category_id, ...birth.value } };
}

// kind: birthday (בני משפחה) / yahrzeit (נפטרים — התאריך הוא תאריך הפטירה)
export function parseFamily(rows, kind = 'birthday') {
  const list = Array.isArray(rows) ? rows : Object.values(rows || {});
  const out = [];
  const yz = kind === 'yahrzeit';
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const first_name = clean(r.first_name, yz ? 80 : 60);
    if (!first_name) continue; // שורה ריקה
    const birth = parseBirth(r, { death: yz });
    if (birth.error) return { error: `${first_name}: ${birth.error}` };
    out.push({ kind: yz ? 'yahrzeit' : 'birthday', first_name, relation: RELATIONS.includes(r.relation) ? r.relation : 'אחר', ...birth.value });
    if (out.length >= 20) break;
  }
  return { value: out };
}

// טקסט תצוגה של תאריך הלידה: העברי הוא העיקר, הלועזי רק לידיעה
export function birthText(p) {
  let s = p.h_day ? hebDateStr(p.h_day, p.h_month, p.h_year) : '';
  if (p.g_date) {
    const [y, m, d] = p.g_date.split('-').map(Number);
    s += ` (לועזי: ${d}.${m}.${y}${p.g_after_sunset ? ', אחרי השקיעה' : ''})`;
  }
  return s;
}

// ערכים להצגה מחדש בטופס עריכה
export function formValues(p) {
  if (!p) return {};
  return {
    ...p,
    date_type: p.g_date ? 'g' : 'h',
    after_sunset: p.g_after_sunset ? 'on' : '',
    h_year: p.h_year && !p.g_date ? hebYearStr(p.h_year) : '',
  };
}

// מספר בפורמט בינלאומי (ספרות בלבד, עם קידומת מדינה) — לוואטסאפ ולחיוג.
// ישראלי: 050… → 97250… ; עם + או 00 בהתחלה → כמו שהוא (מספר מחו"ל) ; 9 ספרות שמתחילות ב-5 → נייד ישראלי בלי 0
export function phoneIntl(phone) {
  const raw = String(phone || '').trim();
  let d = raw.replace(/\D/g, '');
  if (!d) return '';
  if (raw.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return '972' + d.slice(1);
  if (/^5\d{8}$/.test(d)) return '972' + d;
  return d; // כבר כולל קידומת מדינה (למשל 972… או 1718…)
}

export function whatsappLink(phone) {
  const d = phoneIntl(phone);
  return d ? `https://wa.me/${d}` : '';
}

// בדיקת טלפון של מקורב: ישראלי או מחו"ל (עם קידומת מדינה), 9–15 ספרות
export function phoneError(phone) {
  const n = String(phone || '').replace(/\D/g, '').length;
  return phone && (n < 9 || n > 15) ? 'מספר הטלפון אינו תקין (מספר מחו״ל — עם קידומת מדינה, למשל +1 718 555 1234)' : null;
}
