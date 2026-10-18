// מכסת רשומות לחשבון: מקורבים + בני משפחה. המגבלה אוטומטית, ורק המנהל מרחיב אותה.
import { q } from './db.js';

export const RECORDS_DEFAULT = 770; // במחיר ההשקה
export const RECORDS_STEP = 500;    // כל הרחבה (40 ₪ חד-פעמי)
export const RECORDS_NEAR = 0.9;    // התראה מ-90%

export async function recordsStatus(shliachId) {
  const { rows: [r] } = await q(
    `SELECT records_quota AS quota, records_alert AS alert,
       (SELECT count(*) FROM contacts WHERE shliach_id=$1)::int +
       (SELECT count(*) FROM family_members f JOIN contacts c ON c.id=f.contact_id WHERE c.shliach_id=$1)::int AS used
     FROM shluchim WHERE id=$1`, [shliachId]);
  if (!r) return { used: 0, quota: RECORDS_DEFAULT, left: RECORDS_DEFAULT, near: false, full: false, level: 0, alert: 0 };
  const left = Math.max(0, r.quota - r.used);
  const full = r.used >= r.quota, near = r.used >= Math.floor(r.quota * RECORDS_NEAR);
  return { used: r.used, quota: r.quota, left, near, full, level: full ? 100 : near ? 90 : 0, alert: r.alert };
}

// הודעת שגיאה אם אין מקום ל-n רשומות חדשות (אחרת null)
export function roomError(st, n = 1) {
  if (n <= st.left) return null;
  return st.left
    ? `אפשר להוסיף עוד ${st.left === 1 ? 'רשומה אחת' : st.left + ' רשומות'} בלבד (מכסה: ${st.quota} מקורבים ובני משפחה). להרחבת המכסה פנו למנהל.`
    : `הגעתם למכסת ${st.quota} הרשומות (מקורבים ובני משפחה). להרחבת המכסה פנו למנהל.`;
}
