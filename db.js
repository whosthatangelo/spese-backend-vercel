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
  } = nuovaSpesa;

  const sql = `
    UPDATE documents SET
      numero_fattura = $1,
      data_fattura = $2,
      importo = $3,
      valuta = $4,
      azienda = $5,
      tipo_pagamento = $6,
      banca = $7,
      tipo_documento = $8,
      stato = $9,
      metodo_pagamento = $10,
      data_creazione = $11,
      utente_id = $12
    WHERE id = $13
  `;

  const values = [
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
    utente_id,
    id
  ];

  await query(sql, values);
}

export async function deleteSpesa(id) {
  await query('DELETE FROM documents WHERE id = $1', [id]);
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

  const safeDataFattura = data_fattura && data_fattura.trim() !== '' ? data_fattura : new Date().toISOString().split("T")[0];
  const safeDataCreazione = data_creazione && data_creazione.trim() !== '' ? data_creazione : new Date().toISOString();

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
    safeDataCreazione, utente_id
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
