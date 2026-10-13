import pg from 'pg';

// עמודות DATE יחזרו כמחרוזת YYYY-MM-DD (בלי בעיות אזור זמן)
pg.types.setTypeParser(1082, (v) => v);

const conn = process.env.DATABASE_URL;
if (!conn) {
  console.error('חסר DATABASE_URL');
  process.exit(1);
}

export const pool = new pg.Pool({
  connectionString: conn,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export const q = (text, params) => pool.query(text, params);

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
    -- login_mode: עמודה ישנה, לא בשימוש (כניסה תמיד בקוד קבוע או בקוד חד-פעמי ב-SMS)
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS login_mode TEXT;
    ALTER TABLE shluchim ADD COLUMN IF NOT EXISTS chabad_house TEXT NOT NULL DEFAULT '';
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
  `);
}
