// db.js
import { readFile, writeFile } from 'fs/promises';
import { query } from './pg.js'; // ✅ CORRETTA

const FILE_PATH = '/tmp/spese.json';

//
// === JSON File-based operations (legacy) ===
//

// 🔄 Legge le spese
export async function getAllSpese() {
  try {
    const data = await readFile(FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// ➕ Aggiunge una spesa
export async function addSpesa(spesa) {
  const spese = await getAllSpese();
  spese.push({ id: Date.now(), ...spesa });
  await writeFile(FILE_PATH, JSON.stringify(spese, null, 2));
}

// ✏️ Modifica una spesa
export async function updateSpesa(id, nuovaSpesa) {
  let spese = await getAllSpese();
  spese = spese.map(s => s.id == id ? { ...s, ...nuovaSpesa } : s);
  await writeFile(FILE_PATH, JSON.stringify(spese, null, 2));
}

// 🗑️ Cancella una spesa
export async function deleteSpesa(id) {
  let spese = await getAllSpese();
  spese = spese.filter(s => s.id != id);
  await writeFile(FILE_PATH, JSON.stringify(spese, null, 2));
}

//
// === PostgreSQL: Nuovo salvataggio su DB ===
//

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

  const query = `
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

  await query(query, values);
}

// 🔍 Test connessione e tabella
async function testDB() {
  try {
    const res = await query('SELECT * FROM documents LIMIT 1');
    console.log('✅ Connessione al DB riuscita. Primo record:', res.rows[0]);
  } catch (err) {
    console.error('❌ Errore di connessione o query:', err);
  }
}

testDB(); // ← esegui al lancio
