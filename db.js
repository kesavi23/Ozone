const { Pool } = require('pg');

// Reuse the pool across warm serverless invocations instead of opening a
// new connection on every request.
let pool;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set. Add it in your Vercel project settings.');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Most hosted Postgres providers (Vercel Postgres/Neon, Supabase, Railway)
      // require SSL and use certs that Node won't validate by default.
      ssl: process.env.PGSSL_DISABLE === 'true' ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}

module.exports = { getPool };
