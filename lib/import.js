// ייבוא מקורבים בהדבקה מאקסל / גוגל שיטס / CSV: פירוק לטבלה, זיהוי עמודות, פירוש תאריכים ובדיקת כל שורה.
import { gematriyaStrToNum } from '@hebcal/core';
import { parseBirth } from './person.js';
import { parseHebYear, toISO } from './dates.js';

export const MAX_ROWS = 2000;

// שדות שאפשר לשייך לעמודה
export const FIELDS = {
  skip: '— לא לייבא —',
  first_name: 'שם פרטי',
  last_name: 'שם משפחה',
  full_name: 'שם מלא (פרטי + משפחה)',
  phone: 'טלפון',
  date: 'תאריך לידה (לועזי או עברי)',
  h_day: 'יום עברי',
  h_month: 'חודש עברי',
  h_year: 'שנה עברית',
  after_sunset: 'נולד אחרי השקיעה (כן/לא)',
  category: 'סיווג',
  notes: 'הערות',
};

const HEADER_WORDS = [
  ['first_name', /^(שם\s*פרטי|פרטי|first(\s*name)?)$/i],
  ['last_name', /^(שם\s*משפחה|משפחה|last(\s*name)?|surname)$/i],
  ['full_name', /^(שם(\s*מלא)?|name|full\s*name)$/i],
  ['phone', /^(טלפון|נייד|פלאפון|סלולרי|מספר\s*טלפון|טל['׳]?|phone|mobile|tel)$/i],
  ['date', /^(תאריך(\s*לידה)?|תאריך\s*(לועזי|עברי)|יום\s*הולדת|ת\.?\s*לידה|birth(day|date)?|date(\s*of\s*birth)?|dob)$/i],
  ['h_day', /^(יום(\s*עברי)?)$/],
  ['h_month', /^(חודש(\s*עברי)?)$/],
  ['h_year', /^(שנה(\s*עברית)?)$/],
  ['after_sunset', /^(אחרי\s*השקיעה|אחרי\s*שקיעה|שקיעה)$/],
  ['category', /^(סיווג|קטגוריה|קבוצה|category|group)$/i],
  ['notes', /^(הערות|הערה|notes?|comments?)$/i],
];

// טקסט מודבק → מערך שורות של תאים. אקסל מדביק בטאבים; תומך גם ב-CSV (פסיק / נקודה-פסיק) ובמרכאות
export function splitTable(text) {
  text = String(text || '').replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const first = text.split('\n').find((l) => l.trim()) || '';
  const sep = first.includes('\t') ? '\t' : first.split(';').length > first.split(',').length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c));
}

const isPhone = (v) => /^[+\d][\d\s\-()]{7,}$/.test(v) && v.replace(/\D/g, '').length >= 9 && v.replace(/\D/g, '').length <= 12;

// זיהוי עמודות: לפי שורת כותרות אם יש, אחרת לפי התוכן
export function guessMapping(rows) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const head = rows[0] || [];
  const byHeader = head.map((h) => (HEADER_WORDS.find(([, re]) => re.test(h.replace(/[*:]/g, '').trim())) || [])[0] || null);
  if (byHeader.filter(Boolean).length >= Math.min(2, head.filter(Boolean).length)) {
    return { hasHeader: true, mapping: Array.from({ length: width }, (_, i) => byHeader[i] || 'skip') };
  }
  const sample = rows.slice(0, 30);
  const share = (i, test) => { const vals = sample.map((r) => r[i] || '').filter(Boolean); return vals.length ? vals.filter(test).length / vals.length : 0; };
  const mapping = [];
  let texts = 0;
  for (let i = 0; i < width; i++) {
    if (share(i, isPhone) > 0.6) mapping.push(mapping.includes('phone') ? 'skip' : 'phone');
    else if (share(i, (v) => !parseDateCell(v).error) > 0.6) mapping.push(mapping.includes('date') ? 'skip' : 'date');
    else if (share(i, (v) => /\p{L}/u.test(v)) > 0.6 && texts < 2) mapping.push(texts++ === 0 ? 'first_name' : 'last_name');
    else mapping.push('skip');
  }
  // עמודת שמות אחת שרוב הערכים בה כוללים רווח — כנראה שם מלא
  const fi = mapping.indexOf('first_name');
  if (fi >= 0 && !mapping.includes('last_name') && share(fi, (v) => /\S\s+\S/.test(v)) > 0.6) mapping[fi] = 'full_name';
  return { hasHeader: false, mapping };
}

/* ------------------------------ תאריכים ------------------------------ */

const MONTH_WORDS = [
  [12, /^אדר\s*(א['׳]?|ראשון|1|I)$/], [13, /^אדר\s*(ב['׳]?|שני|2|II)$/], [13, /^אדר$/],
  [1, /^ניסן$/], [2, /^אי?יר$/], [3, /^סי?ון$|^סיוון$/], [4, /^תמוז$/], [5, /^(מנחם\s*)?אב$/], [6, /^אלול$/],
  [7, /^תשרי$/], [8, /^(מר)?חשו?ון$/], [9, /^כסלי?ו$/], [10, /^טבת$/], [11, /^שבט$/],
];

function hebDayNum(s) {
  s = s.replace(/["'׳״]/g, '');
  if (/^\d{1,2}$/.test(s)) return parseInt(s, 10);
  const n = gematriyaStrToNum(s);
  return n >= 1 && n <= 30 ? n : NaN;
}

function parseHebrewText(v) {
  // "ה' חשוון תש"נ" / "5 חשון 5750" / "כ"ט באדר א' תשמ"ד" / "ל חשוון"
  const t = v.replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /^(\S+)\s+ב?(.+?)(?:\s+(ה?['׳]?\S+))?$/.exec(t);
  if (!m) return null;
  const day = hebDayNum(m[1]);
  let monthText = m[2].trim(), yearText = m[3];
  // "אדר א" — האות היא חלק מהחודש, לא השנה
  if (/^אדר$/.test(monthText) && yearText && /^(א['׳]?|ב['׳]?|ראשון|שני)$/.test(yearText)) { monthText += ' ' + yearText; yearText = undefined; }
  const mm = /^(.*?)\s+(ה?['׳]?\S+)$/.exec(monthText);
  let month = (MONTH_WORDS.find(([, re]) => re.test(monthText)) || [])[0];
  if (!month && mm) { month = (MONTH_WORDS.find(([, re]) => re.test(mm[1])) || [])[0]; if (month) yearText = mm[2] + (yearText ? ' ' + yearText : ''); }
  if (!day || !month) return null;
  // "ל׳ אדר ב׳" לא קיים (אדר ב׳ תמיד 29 יום) — שגיאה, ולא המרה שקטה לל׳ אדר א׳ (חודש קודם)
  if (day === 30 && month === 13 && /אדר\s*(ב['׳]?|שני|2|II)(\s|$)/.test(t)) return { error: 'אין ל׳ באדר ב׳ — יש בו רק 29 ימים' };
  return { date_type: 'h', h_day: String(day), h_month: String(month), h_year: yearText || '' };
}

const pad = (n) => String(n).padStart(2, '0');

// תא תאריך → שדות לטופס (date_type + g_date או h_day/h_month/h_year), או { error }
export function parseDateCell(v, today = new Date()) {
  v = String(v || '').trim();
  if (!v) return { error: 'חסר תאריך לידה' };
  let m;
  // מספר סידורי של אקסל (ימים מ-30.12.1899)
  if (/^\d{5}$/.test(v) && +v > 2000 && +v < 60000) {
    const d = new Date(1899, 11, 30 + +v);
    return { date_type: 'g', g_date: toISO(d) };
  }
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(v))) return { date_type: 'g', g_date: `${m[1]}-${pad(m[2])}-${pad(m[3])}` };
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(\s|$)/.exec(v))) {
    let y = +m[3];
    if (m[3].length === 2) y += y > today.getFullYear() % 100 ? 1900 : 2000;
    return { date_type: 'g', g_date: `${y}-${pad(m[2])}-${pad(m[1])}` };
  }
  const h = /[֐-׿]/.test(v) ? parseHebrewText(v) : null;
  if (h) return h;
  return { error: `תאריך לא מזוהה: "${v.slice(0, 30)}"` };
}

/* ------------------------------ שורות ------------------------------ */

const YES = /^(כן|v|✓|x|1|true|yes|אחרי)$/i;

// שורה → { value: איש קשר מוכן לשמירה } או { error }
export function parseRow(cells, mapping, { categories = [], defaultCategory = null } = {}) {
  const get = (f) => { const i = mapping.indexOf(f); return i >= 0 ? (cells[i] || '').trim() : ''; };
  let first = get('first_name'), last = get('last_name');
  if (!first && get('full_name')) { const parts = get('full_name').split(/\s+/); first = parts.shift(); last = last || parts.join(' '); }
  first = first.slice(0, 60); last = last.slice(0, 60);
  if (!first && !last) return { error: 'חסר שם' };
  const phone = get('phone').replace(/[^\d+\-\s]/g, '').trim().slice(0, 30);
  if (phone && phone.replace(/\D/g, '').length < 9) return { error: 'טלפון לא תקין' };
  let birthFields;
  if (mapping.includes('h_day') || mapping.includes('h_month')) {
    const month = (MONTH_WORDS.find(([, re]) => re.test(get('h_month').replace(/^ב/, ''))) || [])[0] || parseInt(get('h_month'), 10);
    birthFields = { date_type: 'h', h_day: String(hebDayNum(get('h_day')) || ''), h_month: String(month || ''), h_year: get('h_year') };
    if (!month || !hebDayNum(get('h_day'))) return { error: 'יום/חודש עברי לא מזוהה' };
  } else {
    birthFields = parseDateCell(get('date'));
    if (birthFields.error) return { error: birthFields.error };
    if (birthFields.date_type === 'h' && !birthFields.h_year && get('h_year')) birthFields.h_year = get('h_year');
  }
  if (birthFields.date_type === 'h' && birthFields.h_year && Number.isNaN(parseHebYear(birthFields.h_year))) birthFields.h_year = '';
  if (YES.test(get('after_sunset'))) birthFields.after_sunset = '1';
  const birth = parseBirth(birthFields);
  if (birth.error) return { error: birth.error };
  const catName = get('category').slice(0, 40);
  const cat = catName ? categories.find((c) => c.name.trim() === catName) : null;
  return {
    value: { first_name: first, last_name: last, phone, notes: get('notes').slice(0, 1000), category_id: cat ? cat.id : defaultCategory, ...birth.value },
    newCategory: catName && !cat ? catName : null, // סיווג שעוד לא קיים — אפשר ליצור אותו בייבוא
  };
}

// מפתח לזיהוי כפילויות: טלפון (ספרות), ואם אין — שם + תאריך עברי
export function dupKey(c) {
  const d = String(c.phone || '').replace(/\D/g, '').replace(/^972/, '0');
  return d.length >= 9 ? `p:${d}` : `n:${c.first_name.trim()}|${(c.last_name || '').trim()}|${c.h_day}/${c.h_month}`;
}

// טבלה → טקסט בטאבים (לעריכה בתצוגה המקדימה: שורה = שורה, תא = טאב)
export function toTSV(rows) {
  return rows.map((r) => r.map((c) => String(c ?? '').replace(/[\t\r\n]+/g, ' ').trim()).join('\t')).join('\n');
}
