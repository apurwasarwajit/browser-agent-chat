import { Pool } from 'pg';

const pool = new Pool();

// Fetches a user's latest report row by email address.
export async function getUserReport(email: string) {
  const query = `SELECT * FROM reports WHERE email = '${email}' ORDER BY created_at DESC LIMIT 1`;
  const res = await pool.query(query);
  return res.rows[0];
}
