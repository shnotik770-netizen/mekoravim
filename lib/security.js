// הגבלת קצב בזיכרון + אחסון זמני של קודים שמוצגים פעם אחת.
// מתאים למופע שרת יחיד (כמו ב-Railway כברירת מחדל). בכמה מופעים — להעביר ל-DB/Redis.
import crypto from 'node:crypto';

export class RateLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
    setInterval(() => this.prune(), 60 * 1000).unref();
  }
  #entry(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || now - e.first > this.windowMs) {
      e = { count: 0, first: now };
      this.hits.set(key, e);
    }
    return e;
  }
  blocked(key) {
    const e = this.hits.get(key);
    return !!e && Date.now() - e.first <= this.windowMs && e.count >= this.max;
  }
  hit(key) {
    this.#entry(key).count++;
  }
  // סופר ומחזיר האם עדיין מותר (לשימוש בבקשות שתמיד נספרות)
  take(key) {
    const e = this.#entry(key);
    e.count++;
    return e.count <= this.max;
  }
  reset(key) {
    this.hits.delete(key);
  }
  // סופר n יחידות (למשל רשומות) ומחזיר האם עדיין בתוך המכסה; כשחורגים — לא נספר
  takeN(key, n) {
    const e = this.#entry(key);
    if (e.count + n > this.max) return false;
    e.count += n;
    return true;
  }
  // מחזיר ניסיון שנספר מראש (take) כשהתברר שהוא הצליח
  undo(key) {
    const e = this.hits.get(key);
    if (e && e.count > 0) e.count--;
  }
  prune() {
    const now = Date.now();
    for (const [k, e] of this.hits) if (now - e.first > this.windowMs) this.hits.delete(k);
  }
}

// סיסמה/קוד: אורך מינימלי, לא תו אחד שחוזר ולא רצף ספרות עולה/יורד
export function strongEnough(secret, minLen) {
  const s = String(secret || '');
  if (s.length < minLen || new Set(s).size === 1) return false;
  return !'01234567890123456789'.includes(s) && !'98765432109876543210'.includes(s);
}

// כניסה: גם לפי IP וגם לפי חשבון — כך שהחלפת כתובות IP לא עוקפת את ההגבלה
export const loginByIp = new RateLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
export const loginByAccount = new RateLimiter({ max: 20, windowMs: 60 * 60 * 1000 });
// טופס רישום ציבורי
export const registerByIp = new RateLimiter({ max: 10, windowMs: 10 * 60 * 1000 });
export const contactByIp = new RateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
export const registerByLink = new RateLimiter({ max: 300, windowMs: 24 * 60 * 60 * 1000 });
// מספר הרשומות (מקורב + בני משפחה + יארצייט) שנכנסות דרך טפסים ציבוריים — שמישהו עם קישור לא ימלא
// בזבל את מכסת הרשומות של השליח: לכל מכשיר/רשת, ולכל קישור ביממה
export const recordsByIp = new RateLimiter({ max: 40, windowMs: 60 * 60 * 1000 });
export const recordsByLink = new RateLimiter({ max: 150, windowMs: 24 * 60 * 60 * 1000 });
// בטופס ציבורי: עד כמה בני משפחה / יארצייטים בשליחה אחת
export const PUBLIC_MAX_ROWS = 10;
// שליחת קוד חד-פעמי ב-SMS (עולה כסף): לפי IP ולפי חשבון
export const otpSendByIp = new RateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
export const otpSendByAccount = new RateLimiter({ max: 3, windowMs: 15 * 60 * 1000 });
// תקרה יומית לחשבון: מי שמחזיק קישור של שליח לא יוכל "לשרוף" מאות הודעות ביום
export const otpSendDaily = new RateLimiter({ max: 10, windowMs: 24 * 60 * 60 * 1000 });

// קוד שמוצג למנהל פעם אחת — נשמר בשרת ל-10 דקות; בעוגייה נשמר רק מזהה אקראי
const reveals = new Map();
export function storeReveal(data) {
  const id = crypto.randomBytes(16).toString('base64url');
  reveals.set(id, { data, exp: Date.now() + 10 * 60 * 1000 });
  return id;
}
export function takeReveal(id) {
  const r = id && reveals.get(id);
  if (id) reveals.delete(id);
  return r && r.exp > Date.now() ? r.data : null;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of reveals) if (r.exp <= now) reveals.delete(k);
}, 60 * 1000).unref();
