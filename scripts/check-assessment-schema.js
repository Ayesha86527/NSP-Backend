require('dotenv').config();
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    host: '127.0.0.1',
    port: 5433,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
});

async function main() {
  const table = await pool.query(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = 'candidate'
      AND table_name = 'assessment_records'
  `);
  console.log('\nASSESSMENT TABLE:');
  console.table(table.rows);
  

  if (table.rows.length > 0) {
    const columns = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'candidate'
        AND table_name = 'assessment_records'
      ORDER BY ordinal_position
    `);
    console.log('\nCOLUMNS:');
    console.table(columns.rows);

    const constraints = await pool.query(`
      SELECT con.conname,
             pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = 'candidate'
        AND rel.relname = 'assessment_records'
        AND con.contype IN ('u', 'p')
    `);
    console.log('\nUNIQUE / PRIMARY KEY CONSTRAINTS:');
    console.table(constraints.rows);
    const duplicates = await pool.query(`
  SELECT tester_user_id, client_request_id, COUNT(*) AS total
  FROM candidate.assessment_records
  WHERE client_request_id IS NOT NULL
  GROUP BY tester_user_id, client_request_id
  HAVING COUNT(*) > 1
`);

console.log('\nDUPLICATE REQUEST IDS:');
console.table(duplicates.rows);
  }
}

main()
  .then(async () => {
    const indexes = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'candidate'
        AND tablename = 'assessment_records'
        AND indexname = 'assessment_records_tester_client_request_uidx'
    `);

    console.log('\nIDEMPOTENCY INDEX:');
    console.table(indexes.rows);
  })
  .catch(err => {
    console.error('SCHEMA CHECK FAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

