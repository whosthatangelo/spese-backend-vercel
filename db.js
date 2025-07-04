import { query } from './pg.js';

/**
 * Restituisce tutte le spese (documents) per una data azienda.
 * @param {string} companyId 
 */
export async function getAllSpese(companyId) {
  const sql = `
    SELECT *
      FROM documents
     WHERE azienda_id = $1
  ORDER BY data_fattura DESC
  `;
  const res = await query(sql, [companyId]);
  return res.rows;
}

/**
 * Inserisce un nuovo documento (spesa) per l'azienda doc.azienda_id
 * @param {object} doc  — deve contenere: numero_fattura, data_fattura, importo, valuta,
 *                       azienda (nome), tipo_pagamento, banca, tipo_documento,
 *                       stato, metodo_pagamento, data_creazione, utente_id, azienda_id
 */
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
    utente_id,
    azienda_id
  } = doc;

  const safeDataFattura = data_fattura && data_fattura.trim() !== ''
    ? data_fattura
    : new Date().toISOString().split("T")[0];
  const safeDataCreazione = data_creazione && data_creazione.trim() !== ''
    ? data_creazione
    : new Date().toISOString();

  const sql = `
    INSERT INTO documents (
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
      azienda_id
    ) VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,$9,$10,
      $11,$12,$13
    )
  `;
  const values = [
    numero_fattura,
    safeDataFattura,
    importo,
    valuta,
    azienda,
    tipo_pagamento,
    banca,
    tipo_documento,
    stato,
    metodo_pagamento,
    safeDataCreazione,
    utente_id,
    azienda_id
  ];
  await query(sql, values);
}

/**
 * Modifica una spesa identificata da numero_fattura **e** azienda_id.
 * @param {string} numeroFattura
 * @param {object} doc  — stessi campi di saveDocumento (incluso azienda_id)
 */
export async function updateSpesa(numeroFattura, doc) {
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
    utente_id,
    azienda_id
  } = doc;

  const sql = `
    UPDATE documents SET
      data_fattura   = $1,
      importo        = $2,
      valuta         = $3,
      azienda        = $4,
      tipo_pagamento = $5,
      banca          = $6,
      tipo_documento = $7,
      stato          = $8,
      metodo_pagamento = $9,
      data_creazione  = $10,
      utente_id       = $11
    WHERE numero_fattura = $12
      AND azienda_id     = $13
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
    numeroFattura,
    azienda_id
  ];
  await query(sql, values);
}

/**
 * Elimina una spesa su base numero_fattura **e** azienda_id
 * @param {string} numeroFattura
 * @param {string} companyId
 */
export async function deleteSpesa(numeroFattura, companyId) {
  const sql = `
    DELETE FROM documents
     WHERE numero_fattura = $1
       AND azienda_id     = $2
  `;
  await query(sql, [numeroFattura, companyId]);
}

/////////////////////
// test di connessione
/////////////////////
async function testDB() {
  try {
    await query('SELECT 1');
    console.log('✅ Connessione al DB OK');
  } catch (err) {
    console.error('❌ Errore connessione DB:', err);
  }
}
testDB();
