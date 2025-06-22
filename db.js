// db.js
import { readFile, writeFile } from 'fs/promises';
import { query } from './pg.js';

const FILE_PATH = '/tmp/spese.json';

export async function getAllSpese() {
  const res = await query('SELECT * FROM documents ORDER BY data_fattura DESC');
  return res.rows;
}


export async function addSpesa(spesa) {
  const {
    numero_fattura,
    data_fattura,
    importo,
    valuta,
    azienda,
    tipo_pagamento,
    banca,
    tipo_documento,
    stato,
    metodo_pagamento,
    data_creazione,
    utente_id
  } = spesa;

  const sql = `
    INSERT INTO documents (
      numero_fattura, data_fattura, importo, valuta, azienda,
      tipo_pagamento, banca, tipo_documento, stato, metodo_pagamento,
      data_creazione, utente_id
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12
    )
  `;

  const values = [
    numero_fattura, data_fattura, importo, valuta, azienda,
    tipo_pagamento, banca, tipo_documento, stato, metodo_pagamento,
    data_creazione, utente_id
  ];

  await query(sql, values);
}


export async function updateSpesa(id, nuovaSpesa) {
  const fields = Object.keys(nuovaSpesa);
  const values = Object.values(nuovaSpesa);

  const setString = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const sql = `UPDATE documents SET ${setString} WHERE numero_fattura = $${fields.length + 1}`;

  await query(sql, [...values, id]);
}


export async function deleteSpesa(id) {
  await query('DELETE FROM documents WHERE numero_fattura = $1', [id]);
}


export async function saveDocumento(doc) {
  const {
    numero_fattura,
    data_fattura,
    importo,
    valuta,
    azienda,
    tipo_pagamento,
    banca,
    tipo_documento,
    stato,
    metodo_pagamento,
    data_creazione,
    utente_id
  } = doc;

  // 🛡️ fallback automatico se data_fattura non è valida
  const safeDataFattura = data_fattura && data_fattura.trim() !== '' ? data_fattura : new Date().toISOString().split("T")[0];


  const sql = `
    INSERT INTO documents (
      numero_fattura, data_fattura, importo, valuta, azienda,
      tipo_pagamento, banca, tipo_documento, stato, metodo_pagamento,
      data_creazione, utente_id
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12
    )
  `;

  const values = [
    numero_fattura, safeDataFattura, importo, valuta, azienda,
    tipo_pagamento, banca, tipo_documento, stato, metodo_pagamento,
    data_creazione, utente_id
  ];

  await query(sql, values);
}

async function testDB() {
  try {
    const res = await query('SELECT * FROM documents LIMIT 1');
    console.log('✅ Connessione al DB riuscita. Primo record:', res.rows[0]);
  } catch (err) {
    console.error('❌ Errore di connessione o query:', err);
  }
}

testDB();
