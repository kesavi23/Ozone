-- HRMS database schema.
-- Run this once against your Postgres database before first use
-- (see README.md for how, e.g. via the Vercel/Neon/Supabase SQL editor
-- or `psql "$DATABASE_URL" -f schema.sql`).

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  company TEXT DEFAULT 'My Company',
  role TEXT NOT NULL DEFAULT 'employee',
  security_question TEXT,
  security_answer_hash TEXT,
  casual_leave_total NUMERIC DEFAULT 12,
  sick_leave_total NUMERIC DEFAULT 8,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  clock_in TEXT,
  clock_in_method TEXT,
  biometric_in_id TEXT,
  required_clock_out TEXT,
  clock_out TEXT,
  clock_out_method TEXT,
  biometric_out_id TEXT,
  status TEXT,
  shift_type TEXT DEFAULT 'regular',
  work_minutes INTEGER,
  break_minutes INTEGER DEFAULT 0,
  overtime_minutes INTEGER DEFAULT 0,
  breaks JSONB DEFAULT '[]'::jsonb,
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS leaves (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days NUMERIC NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  applied_on DATE NOT NULL,
  decided_by INTEGER REFERENCES users(id),
  decision_note TEXT
);

CREATE TABLE IF NOT EXISTS activities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  task TEXT NOT NULL,
  category TEXT,
  start_time TEXT,
  end_time TEXT,
  status TEXT DEFAULT 'Pending',
  remarks TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER,
  actor_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance(user_id, date);
CREATE INDEX IF NOT EXISTS idx_leaves_user ON leaves(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_user_date ON activities(user_id, date);
