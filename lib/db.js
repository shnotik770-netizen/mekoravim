import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

// עמודות DATE יחזרו כמחרוזת YYYY-MM-DD (בלי בעיות אזור זמן)
pg.types.setTypeParser(1082, (v) => v);

const conn = process.env.DATABASE_URL;
if (!conn) {
  console.error('חסר DATABASE_URL');
  process.exit(1);
}

export const pool = new pg.Pool({
  connectionString: conn,
  max: Number(process.env.PG_POOL_MAX) || 20,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

// הקשר בקשה: בחשבון ההדגמה כל השאילתות רצות על חיבור אחד בתוך טרנזקציה שמבוטלת בסוף (ROLLBACK)
export const dbStorage = new AsyncLocalStorage();
export const dbStore = () => dbStorage.getStore();

// בקשת הדגמה שנסגרה (הלקוח התנתק): החיבור כבר שוחרר — אסור להמשיך להריץ עליו שאילתות מחוץ לטרנזקציה
const alive = (st) => { if (st?.dead) throw new Error('demo request closed'); return st; };
export const q = (text, params) => (alive(dbStorage.getStore())?.client || pool).query(text, params);

// טרנזקציה: רגילה, או savepoint בתוך טרנזקציית ההדגמה
export async function transaction(fn) {
  const st = alive(dbStorage.getStore());
  if (st?.client) {
    await st.client.query('SAVEPOINT tx');
    try { const r = await fn(st.client); await st.client.query('RELEASE SAVEPOINT tx'); return r; }
    catch (e) { await st.client.query('ROLLBACK TO SAVEPOINT tx'); throw e; }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS shluchim (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      access_code_hash TEXT,            -- hash של הקוד הקבוע
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      shliach_id INTEGER NOT NULL REFERENCES shluchim(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#2f5bd3',
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reg_links (
      id SERIAL PRIMARY KEY,
      shliach_id INTEGER NOT NULL REFERENCES shluchim(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      shliach_id INTEGER NOT NULL REFERENCES shluchim(id) ON DELETE CASCADE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      g_date DATE,
      g_after_sunset BOOLEAN NOT NULL DEFAULT FALSE,
      h_day SMALLINT,
      h_month SMALLINT,
      h_year SMALLINT,
      notes TEXT NOT NULL DEFAULT '',
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      reg_link_id INTEGER REFERENCES reg_links(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS contacts_shliach_idx ON contacts(shliach_id);
    CREATE TABLE IF NOT EXISTS family_members (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT '',
      first_name TEXT NOT NULL,
      g_date DATE,
      g_after_sunset BOOLEAN NOT NULL DEFAULT FALSE,
      h_day SMALLINT,
      h_month SMALLINT,
      h_year SMALLINT
    );
    CREATE INDEX IF NOT EXISTS family_contact_idx ON family_members(contact_id);
    CREATE TABLE IF NOT EXISTS contact_log (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      family_member_id INTEGER REFERENCES family_members(id) ON DELETE CASCADE,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS log_contact_idx ON contact_log(contact_id);
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS sms_phone TEXT NOT NULL DEFAULT '';
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS sms_last_sent DATE;
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS sms_last_error TEXT;
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
    -- נייד אחד לשליח (כניסה + תזכורות). sms_phone נשאר כעותק של phone בלבד
    UPDATE shluchim SET phone=sms_phone WHERE phone='' AND sms_phone<>'';
    UPDATE shluchim SET sms_phone=phone WHERE sms_phone<>phone;
    -- login_mode: עמודה ישנה, לא בשימוש (כניסה תמיד בקוד קבוע או בקוד חד-פעמי ב-SMS)
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS login_mode TEXT;
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS chabad_house TEXT NOT NULL DEFAULT '';
    -- SMS: תדירות (weekly = יום ראשון, daily = כל יום חול) ומכסה חודשית ביחידות (NULL = ברירת המחדל המערכתית)
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS sms_frequency TEXT NOT NULL DEFAULT 'weekly';
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS sms_quota INTEGER;
    CREATE TABLE IF NOT EXISTS sms_log (
      id SERIAL PRIMARY KEY,
      shliach_id INTEGER NOT NULL REFERENCES shluchim(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,               -- weekly / daily / test / otp / admin
      units INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS sms_log_shliach_idx ON sms_log(shliach_id, created_at);
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- תזכורות: שבועי ו/או יומי (אפשר את שניהם), ומכסת יחידות מצטברת לתזכורות ימי הולדת בלבד
    -- (לא מתאפסת אוטומטית — המנהל מוסיף יחידות). sms_alert_threshold NULL = 10% מהמכסה
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='shluchim' AND column_name='sms_weekly') THEN
        ALTER TABLE shluchim ADD COLUMN sms_weekly BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE shluchim ADD COLUMN sms_daily BOOLEAN NOT NULL DEFAULT FALSE;
        UPDATE shluchim SET sms_weekly = sms_enabled AND sms_frequency <> 'daily', sms_daily = sms_enabled AND sms_frequency = 'daily';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='shluchim' AND column_name='sms_used_birthdays') THEN
        ALTER TABLE shluchim ADD COLUMN sms_used_birthdays INTEGER NOT NULL DEFAULT 0;
        UPDATE shluchim SET sms_used_birthdays = coalesce((SELECT sum(units) FROM sms_log l WHERE l.shliach_id=shluchim.id AND l.kind IN ('weekly','daily')), 0);
      END IF;
    END $$;
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS sms_last_daily DATE;
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS sms_alert_threshold INTEGER;
    UPDATE shluchim SET sms_quota = coalesce((SELECT value::int FROM app_settings WHERE key='sms_quota_default'), 100) WHERE sms_quota IS NULL;
    -- יומן פעולות למנהל (ללא מידע פרטי של שליחים — ראו lib/audit.js)
    CREATE TABLE IF NOT EXISTS activity_log (
      id BIGSERIAL PRIMARY KEY,
      shliach_id INTEGER REFERENCES shluchim(id) ON DELETE SET NULL,
      actor TEXT NOT NULL,              -- admin / shliach / public / system
      action TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'ok', -- ok / fail / blocked / error
      detail TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS activity_log_time_idx ON activity_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS activity_log_shliach_idx ON activity_log(shliach_id, created_at DESC);
    -- תזכורת SMS אישית על מקורב: כמה ימים לפני יום ההולדת (0 = ביום עצמו, עד 7). NULL = בלי תזכורת
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS remind_days SMALLINT;
    -- מניעת כפילות: תזכורת אחת לכל מקורב לכל מועד יום הולדת
    CREATE TABLE IF NOT EXISTS contact_reminders (
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      occurs_on DATE NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (contact_id, occurs_on)
    );
    -- תזכורת אישית גם על בן משפחה
    ALTER TABLE family_members ADD COLUMN IF NOT EXISTS remind_days SMALLINT;
    CREATE TABLE IF NOT EXISTS family_reminders (
      family_member_id INTEGER NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
      occurs_on DATE NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (family_member_id, occurs_on)
    );
    -- התאמת טופס הרישום לכל קישור: כותרת, טקסט פתיחה ועד 3 שדות טקסט נוספים [{label, required}]
    ALTER TABLE reg_links ADD COLUMN IF NOT EXISTS form_title TEXT NOT NULL DEFAULT '';
    ALTER TABLE reg_links ADD COLUMN IF NOT EXISTS form_intro TEXT NOT NULL DEFAULT '';
    ALTER TABLE reg_links ADD COLUMN IF NOT EXISTS extra_fields JSONB NOT NULL DEFAULT '[]';
    -- בטופס הרישום: לחייב גם שם פרטי וגם שם משפחה (ברירת מחדל), או שמספיק אחד מהם
    ALTER TABLE reg_links ADD COLUMN IF NOT EXISTS require_both_names BOOLEAN NOT NULL DEFAULT TRUE;
    -- פנייה: מין (m/f) והאם להוסיף תואר (הרב / הרבנית) בברכה ובהודעות
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT 'm';
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS use_title BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS show_yechi BOOLEAN NOT NULL DEFAULT FALSE;
    -- מכסת רשומות (מקורבים + בני משפחה). records_alert: איזו התראה כבר נשלחה (0 / 90 / 100)
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS records_quota INTEGER NOT NULL DEFAULT 770;
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS records_alert SMALLINT NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS login_codes (
      id SERIAL PRIMARY KEY,
      shliach_id INTEGER NOT NULL REFERENCES shluchim(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS login_codes_shliach_idx ON login_codes(shliach_id, created_at);
    ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
    ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS consumed_ip TEXT;
    CREATE TABLE IF NOT EXISTS contact_requests (
      id SERIAL PRIMARY KEY,
      shliach_id INTEGER REFERENCES shluchim(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      handled_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS contact_requests_status_idx ON contact_requests(status, created_at);
  `);
  // חד-פעמי: סיווג ברירת המחדל "מקורב קרוב" נקרא עכשיו "מקורבים" (גם בחשבונות קיימים)
  const { rowCount } = await q(`INSERT INTO app_settings (key, value) VALUES ('mig_cat_mekoravim', '1') ON CONFLICT DO NOTHING`);
  if (rowCount) await q(`UPDATE categories SET name='מקורבים' WHERE name='מקורב קרוב'`);
}
