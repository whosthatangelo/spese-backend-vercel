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


export async function updateSpesa(numero_fattura, nuovaSpesa) {
  const {
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
  } = nuovaSpesa;

  const sql = `
    UPDATE documents SET
      data_fattura = $1,
      importo = $2,
      valuta = $3,
      azienda = $4,
      tipo_pagamento = $5,
      banca = $6,
      tipo_documento = $7,
      stato = $8,
      metodo_pagamento = $9,
      data_creazione = $10,
      utente_id = $11
    WHERE numero_fattura = $12
  `;

  const values = [
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
    utente_id,
    numero_fattura
  ];

  await query(sql, values);
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
