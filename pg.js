// pg.js
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

console.log("✅ Connessione a PostgreSQL inizializzata");

export const query = (text, params) => pool.query(text, params);
