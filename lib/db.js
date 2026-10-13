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
      password_hash TEXT,
      setup_code_hash TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      display_mode TEXT NOT NULL DEFAULT 'both',
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
      source TEXT NOT NULL DEFAULT 'form',
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
  `);
}
