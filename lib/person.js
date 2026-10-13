import { parseISO, toISO, todayIL, hebFromGreg, parseHebYear, hebDateStr, hebYearStr } from './dates.js';

const clean = (v, max = 100) => String(v ?? '').trim().slice(0, max);

export const RELATIONS = ['בן/בת זוג', 'בן', 'בת', 'אבא', 'אמא', 'אח', 'אחות', 'סבא', 'סבתא', 'נכד/ה', 'אחר'];

// קורא את שדות התאריך מטופס. מחזיר { value } או { error }
export function parseBirth(b) {
  const type = b.date_type === 'h' ? 'h' : 'g';
  if (type === 'g') {
    const d = parseISO(b.g_date);
    if (!d) return { error: 'יש להזין תאריך לידה לועזי מלא' };
    if (d > todayIL() || d.getFullYear() < 1900) return { error: 'תאריך הלידה הלועזי אינו תקין' };
    const afterSunset = b.after_sunset === 'on' || b.after_sunset === '1';
    const h = hebFromGreg(d, afterSunset);
    return { value: { g_date: toISO(d), g_after_sunset: afterSunset, h_day: h.day, h_month: h.month, h_year: h.year } };
  }
  const day = parseInt(b.h_day, 10);
  const month = parseInt(b.h_month, 10);
  if (!(day >= 1 && day <= 30) || !(month >= 1 && month <= 13)) return { error: 'יש לבחור יום וחודש עבריים' };
  const year = parseHebYear(b.h_year);
  if (Number.isNaN(year)) return { error: 'שנת הלידה העברית אינה תקינה (לדוגמה: תש"נ או 5750)' };
  return { value: { g_date: null, g_after_sunset: false, h_day: day, h_month: month, h_year: year } };
}

export function parseContact(b) {
  const first_name = clean(b.first_name, 60);
  const last_name = clean(b.last_name, 60);
  const phone = clean(b.phone, 30).replace(/[^\d+\-\s]/g, '');
  if (!first_name || !last_name) return { error: 'יש למלא שם פרטי ושם משפחה' };
  if (phone.replace(/\D/g, '').length < 9) return { error: 'יש להזין מספר טלפון תקין' };
  const birth = parseBirth(b);
  if (birth.error) return birth;
  return { value: { first_name, last_name, phone, notes: clean(b.notes, 1000), ...birth.value } };
}

export function parseFamily(rows) {
  const list = Array.isArray(rows) ? rows : Object.values(rows || {});
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const first_name = clean(r.first_name, 60);
    if (!first_name) continue; // שורה ריקה
    const birth = parseBirth(r);
    if (birth.error) return { error: `${first_name}: ${birth.error}` };
    out.push({ first_name, relation: RELATIONS.includes(r.relation) ? r.relation : 'אחר', ...birth.value });
    if (out.length >= 20) break;
  }
  return { value: out };
}

// טקסט תצוגה של תאריך הלידה
export function birthText(p) {
  const parts = [];
  if (p.g_date) {
    const [y, m, d] = p.g_date.split('-').map(Number);
    parts.push(`${d}.${m}.${y}${p.g_after_sunset ? ' (אחרי השקיעה)' : ''}`);
  }
  if (p.h_day) parts.push(hebDateStr(p.h_day, p.h_month, p.h_year));
  return parts.join(' · ');
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

export function whatsappLink(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '972' + d.slice(1);
  return d ? `https://wa.me/${d}` : '';
}
