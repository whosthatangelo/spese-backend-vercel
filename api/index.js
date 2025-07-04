import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { OpenAI } from 'openai';
import {
  getAllSpese,
  saveDocumento,
  updateSpesa,
  deleteSpesa
} from '../db.js';

import pg from 'pg';
const db = new pg.Pool({ connectionString: process.env.POSTGRES_URL });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID,
  project: process.env.OPENAI_PROJECT_ID,
});

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ dest: '/tmp' });

app.use(cors());
app.use(express.json());

/* ——————————————————————————————————————————————————————————— */
/* 1) Middleware: estrai userId e companyId dagli headers */
/* ——————————————————————————————————————————————————————————— */
app.use((req, res, next) => {
  const userIdHeader = req.header('x-user-id');
  const companyId = req.header('x-company-id');

  // Cast esplicito: evita errore "text = integer"
  if (userIdHeader) {
    const parsedUserId = parseInt(userIdHeader, 10);
    if (isNaN(parsedUserId)) {
      return res.status(400).json({ error: 'x-user-id non valido' });
    }
    req.userId = parsedUserId;
  }

  // consenti /login e /companies anche senza x-company-id
  if (req.path === '/login' || req.path === '/companies') {
    return next();
  }

  if (!req.userId) {
    return res.status(401).json({ error: 'Utente non autenticato' });
  }

  if (!companyId) {
    return res.status(400).json({ error: 'Header x-company-id mancante' });
  }

  req.companyId = companyId;
  next();
});



/* ——————————————————————————————————————————————————————————— */
/* 2) Middleware: verifica che user appartenga alla company */
/* ——————————————————————————————————————————————————————————— */
async function ensureMembership(req, res, next) {
  try {
    const { userId, companyId } = req;
    const result = await db.query(
      'SELECT 1 FROM user_companies WHERE utente_id = $1 AND azienda_id = $2',
      [userId, companyId]
    );
    if (result.rowCount === 0) {
      return res.status(403).json({ error: 'Accesso negato per questa azienda' });
    }
    next();
  } catch (err) {
    console.error('❌ Errore controllo membership:', err);
    res.status(500).json({ error: 'Errore interno controllo azienda' });
  }
}
// Applica a tutte le rotte protette
app.use(
  [
    '/upload-audio',
    '/expenses',
    '/incomes',
    '/stats',
    '/income-stats',
    '/latest-expenses',
    '/latest-income'
  ],
  ensureMembership
);

/* ——————————————————————————————————————————————————————————— */
/* 3) GET /companies → lista aziende dell’utente */
/* ——————————————————————————————————————————————————————————— */
app.get('/companies', async (req, res) => {
  const userId = req.userId;
  console.log(`🔎 Chiamata /companies per userId: ${userId}`);

  if (!userId || isNaN(userId)) {
    return res.status(400).json({ error: 'userId non valido o mancante' });
  }

  try {
    const result = await db.query(`
      SELECT c.id, c.nome
      FROM companies c
      JOIN user_companies uc ON uc.azienda_id = c.id::text
      WHERE uc.utente_id = $1::text
    `, [userId]);

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Errore /companies:', err);
    res.status(500).json({ error: 'Errore interno nel recupero aziende' });
  }
});



/* === LOGIN UTENTE === */
app.post('/login', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email richiesta' });
  }

  try {
    const result = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (result.rows.length > 0) {
      return res.json({ userId: result.rows[0].id });
    } else {
      return res.status(401).json({ error: 'Email non trovata' });
    }
  } catch (err) {
    console.error('❌ Errore login:', err);
    res.status(500).json({ error: 'Errore login utente' });
  }
});


/* === Trascrizione vocale === */
async function transcribeAudio(file) {
  const outputPath = `/tmp/${path.parse(file.originalname).name}.mp3`;

  await new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-i', file.path,
      '-f', 'mp3',
      '-acodec', 'libmp3lame',
      '-ar', '44100',
      '-y',
      outputPath
    ]);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log('✅ Conversione completata:', outputPath);
        resolve();
      } else {
        reject(new Error(`❌ FFmpeg exited with code ${code}`));
      }
    });
  });

  return await openai.audio.transcriptions.create({
    file: fs.createReadStream(outputPath),
    model: 'whisper-1',
    response_format: 'json',
    language: 'it'
  });
}


// ===== VERSIONE MIGLIORATA DI normalizeFields =====

function normalizeFields(data) {
  const normalize = (value) => value?.toLowerCase()?.trim();
  const isValidDate = (str) => /^\d{4}-\d{2}-\d{2}$/.test(str);

  // ✨ Mappa parole tipo "oggi" in vere date
  const parseNaturalDate = (value) => {
    const today = new Date();
    if (value === "oggi") return today.toISOString().split("T")[0];
    if (value === "ieri") {
      const d = new Date(today);
      d.setDate(today.getDate() - 1);
      return d.toISOString().split("T")[0];
    }
    if (value === "domani") {
      const d = new Date(today);
      d.setDate(today.getDate() + 1);
      return d.toISOString().split("T")[0];
    }
    return value;
  };

  const metodoPagamentoMap = {
    'contanti': 'Contanti',
    'cash': 'Contanti',
    'denaro': 'Contanti',
    'liquidi': 'Contanti',
    'bancomat': 'POS',
    'pos': 'POS',
    'carta di debito': 'POS',
    'carta': 'Carta di Credito',
    'carta di credito': 'Carta di Credito',
    'credit card': 'Carta di Credito',
    'bonifico': 'Bonifico',
    'bonifico bancario': 'Bonifico',
    'trasferimento': 'Bonifico',
    'assegno': 'Assegno',
    'paypal': 'PayPal',
    'satispay': 'Satispay',
    'revolut': 'Revolut',
    'n26': 'N26',
    'postepay': 'Postepay'
  };

  const tipoDocumentoMap = {
    'fattura': 'Fattura',
    'fattura elettronica': 'Fattura',
    'documento di trasporto': 'Documento di Trasporto',
    'ddt': 'Documento di Trasporto',
    'bolla': 'Documento di Trasporto',
    'bolla di consegna': 'Documento di Trasporto',
    'ricevuta': 'Ricevuta',
    'scontrino': 'Scontrino',
    'scontrino fiscale': 'Scontrino',
    'nota di credito': 'Nota di Credito',
    'preventivo': 'Preventivo',
    'proforma': 'Fattura Proforma'
  };

  const tipoPagamentoMap = {
    'fine mese': 'Fine mese',
    'fm': 'Fine mese',
    'immediato': 'Immediato',
    'subito': 'Immediato',
    'contanti': 'Immediato',
    '30 giorni': '30 giorni',
    '60 giorni': '60 giorni',
    '90 giorni': '90 giorni',
    'a vista': 'A vista',
    'alla consegna': 'Alla consegna',
    'anticipato': 'Anticipato',
    'rateale': 'Rateale',
    'rate': 'Rateale'
  };

  if (data.metodo_pagamento)
    data.metodo_pagamento = metodoPagamentoMap[normalize(data.metodo_pagamento)] || data.metodo_pagamento;

  if (data.tipo_documento)
    data.tipo_documento = tipoDocumentoMap[normalize(data.tipo_documento)] || data.tipo_documento;

  if (data.tipo_pagamento)
    data.tipo_pagamento = tipoPagamentoMap[normalize(data.tipo_pagamento)] || data.tipo_pagamento;

  if (data.metodo_incasso)
    data.metodo_incasso = metodoPagamentoMap[normalize(data.metodo_incasso)] || data.metodo_incasso;

  // 🗓️ Normalizza le date
  if (data.data_fattura) {
    data.data_fattura = parseNaturalDate(normalize(data.data_fattura));
    if (data.data_fattura !== "non disponibile" && !isValidDate(data.data_fattura)) {
      throw new Error(`Formato data_fattura non valido: ${data.data_fattura}`);
    }
  }

  if (data.data_incasso) {
    data.data_incasso = parseNaturalDate(normalize(data.data_incasso));
    if (data.data_incasso !== "non disponibile" && !isValidDate(data.data_incasso)) {
      throw new Error(`Formato data_incasso non valido: ${data.data_incasso}`);
    }
  }

  if (data.data_creazione) {
    data.data_creazione = parseNaturalDate(normalize(data.data_creazione));
    if (!isValidDate(data.data_creazione)) {
      // fallback automatico alla data corrente se errata
      data.data_creazione = new Date().toISOString().split("T")[0];
    }
  }

  return data;
}


/* === Parsing con OpenAI === */
async function extractDataFromText(text) {
  const prompt = `
  Hai ricevuto questo testo trascritto da un file audio:

  "${text}"

  Devi determinare con certezza se si tratta di una **spesa** oppure di un **incasso**.

  🔹 Se è una **spesa**, restituisci solo questo oggetto JSON:
  {
    "tipo": "spesa",
    "numero_fattura": "...",
    "data_fattura": "YYYY-MM-DD",
    "importo": ...,
    "valuta": "EUR",
    "azienda": "...",
    "tipo_pagamento": "...",
    "banca": "...",
    "tipo_documento": "...",
    "stato": "",
    "metodo_pagamento": "...",
    "data_creazione": "YYYY-MM-DD",
    "utente_id": "user_1"
  }

  🔹 Se è un **incasso**, restituisci solo questo oggetto JSON:
  {
    "tipo": "incasso",
    "data_incasso": "YYYY-MM-DD",
    "importo": ...,
    "valuta": "EUR",
    "metodo_incasso": "...",
    "data_creazione": "YYYY-MM-DD",
    "utente_id": "user_1"
  }

  ⚠️ Rispondi solo con un oggetto JSON valido. Non scrivere spiegazioni. Non includere testo aggiuntivo. Nessun preambolo. Nessun commento.
  Se hai dubbi, scegli “spesa”.
  `;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'Sei un assistente che estrae dati strutturati da testi vocali trascritti.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2
  });

  const response = completion.choices[0].message.content;

  try {
    console.log("🧠 Output AI grezzo:", response);
    const raw = JSON.parse(response);
    return normalizeFields(raw);
  } catch (err) {
    console.error("❌ Errore parsing JSON:", err);
    throw new Error("Parsing JSON fallito.");
  }
}


/* === Upload Audio === */
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file || !req.file.mimetype || req.file.size === 0) {
      return res.status(400).json({ error: 'File audio mancante o non valido.', spesa: null });
    }

    console.log("📁 Audio ricevuto:", req.file.originalname);

    const transcription = await transcribeAudio(req.file);
    console.log("🗣️ Testo trascritto:", transcription.text);

    const parsedData = await extractDataFromText(transcription.text);
    console.log("📦 Dati estratti:", parsedData);

    if (parsedData.tipo === 'spesa') {
      // inserimento con azienda_id
      const doc = {
        ...parsedData,
        azienda_id: req.companyId,
        data_creazione: new Date().toISOString()
      };
      await saveDocumento(doc);
      return res.status(200).json({
        message: 'Spesa salvata con successo',
        spesa: doc
      });

    } else if (parsedData.tipo === 'incasso') {
      // inserimento con azienda_id
      await db.query(
        `INSERT INTO incomes
           (data_incasso, importo, valuta, metodo_incasso, data_creazione, utente_id, azienda_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          parsedData.data_incasso,
          parsedData.importo,
          parsedData.valuta,
          parsedData.metodo_incasso,
          new Date().toISOString(),
          parsedData.utente_id,
          req.companyId
        ]
      );
      return res.status(200).json({
        message: 'Incasso salvato con successo',
        incasso: parsedData
      });
    } else {
      return res.status(400).json({
        message: 'Tipo non riconosciuto nel JSON',
        error: 'Tipo mancante o non valido',
        spesa: null
      });
    }
  } catch (error) {
    console.error("❌ Errore /upload-audio:", error);
    return res.status(500).json({
      message: 'Errore durante il salvataggio',
      error: error.message || 'Errore sconosciuto',
      spesa: null
    });
  }
});


/* === API spese === */
app.get('/expenses', async (req, res) => {
  try {
    const { companyId } = req;
    const result = await db.query(
      'SELECT * FROM documents WHERE azienda_id = $1 ORDER BY data_creazione DESC',
      [companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Errore /expenses:', err);
    res.status(500).json({ error: 'Errore recupero spese' });
  }
});


/* === API incassi === */
app.get('/incomes', async (req, res) => {
  try {
    const { companyId } = req;
    const result = await db.query(
      'SELECT * FROM incomes WHERE azienda_id = $1 ORDER BY data_incasso DESC',
      [companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Errore /incomes:', err);
    res.status(500).json({ error: 'Errore recupero incassi' });
  }
});

// 🗑️ Elimina un incasso
app.delete('/incomes/:id', async (req, res) => {
  try {
    const { companyId } = req;
    const id = req.params.id;
    const result = await db.query(
      'DELETE FROM incomes WHERE id = $1 AND azienda_id = $2 RETURNING *',
      [id, companyId]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: 'Incasso non trovato o non autorizzato' });
    }
    res.json({ message: 'Incasso eliminato', deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Errore cancellazione incasso:', err);
    res.status(500).json({ error: 'Errore nella cancellazione incasso' });
  }
});

// ✏️ Modifica un incasso
app.put('/incomes/:id', async (req, res) => {
  try {
    const { companyId } = req;
    const { data_incasso, importo, valuta, metodo_incasso, utente_id } = req.body;
    const result = await db.query(
      `UPDATE incomes SET 
        data_incasso = $1,
        importo      = $2,
        valuta       = $3,
        metodo_incasso = $4,
        utente_id    = $5,
        updated_at   = CURRENT_TIMESTAMP
       WHERE id = $6 AND azienda_id = $7
       RETURNING *`,
      [data_incasso, importo, valuta, metodo_incasso, utente_id, req.params.id, companyId]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: 'Incasso non trovato o non autorizzato' });
    }
    res.json({ message: 'Incasso aggiornato con successo', updated: result.rows[0] });
  } catch (err) {
    console.error('❌ Errore modifica incasso:', err);
    res.status(500).json({ error: 'Errore nella modifica incasso' });
  }
});


/* === Creazione spesa via API === */
app.post('/expenses', async (req, res) => {
  try {
    const doc = {
      ...req.body,
      azienda_id: req.companyId,
      data_creazione: new Date().toISOString()
    };
    await saveDocumento(doc);
    res.status(201).json({ message: 'Spesa salvata', data: doc });
  } catch (err) {
    console.error('❌ Errore POST /expenses:', err);
    res.status(500).json({ error: 'Errore nel salvataggio spesa' });
  }
});

// ✏️ Modifica spesa
app.put('/expenses/:numero_fattura', async (req, res) => {
  try {
    await updateSpesa(req.params.numero_fattura, req.body);
    res.json({ message: 'Spesa modificata' });
  } catch (err) {
    console.error('❌ Errore modifica spesa:', err);
    res.status(500).json({ error: 'Errore nella modifica spesa' });
  }
});

// 🗑️ Elimina spesa
app.delete('/expenses/:numero_fattura', async (req, res) => {
  try {
    await deleteSpesa(req.params.numero_fattura);
    res.json({ message: 'Spesa eliminata' });
  } catch (err) {
    console.error('❌ Errore cancellazione spesa:', err);
    res.status(500).json({ error: 'Errore nella cancellazione spesa' });
  }
});


/* === Statistiche spese === */
app.get('/stats', async (req, res) => {
  try {
    const { companyId } = req;
    const result = await db.query(
      'SELECT * FROM documents WHERE azienda_id = $1',
      [companyId]
    );
    const spese = result.rows;
    const totale = spese.reduce((acc, s) => acc + parseFloat(s.importo || 0), 0);
    const numero = spese.length;
    const perGiorno = spese.reduce((acc, s) => {
      acc[s.data_fattura] = (acc[s.data_fattura] || 0) + parseFloat(s.importo || 0);
      return acc;
    }, {});
    const media_per_giorno = numero
      ? (totale / Object.keys(perGiorno).length).toFixed(2)
      : '0.00';

    res.json({ totale: totale.toFixed(2), numero, media_per_giorno, per_giorno: perGiorno });
  } catch (err) {
    console.error('❌ Errore /stats:', err);
    res.status(500).json({ error: 'Errore nel calcolo statistiche spese' });
  }
});


/* === Statistiche incassi === */
app.get('/income-stats', async (req, res) => {
  try {
    const { companyId } = req;
    const result = await db.query(
      'SELECT * FROM incomes WHERE azienda_id = $1',
      [companyId]
    );
    const incassi = result.rows;
    const totale = incassi.reduce((acc, i) => acc + parseFloat(i.importo || 0), 0);
    const numero = incassi.length;
    const perGiorno = incassi.reduce((acc, i) => {
      const giorno = i.data_incasso?.toISOString?.().split('T')[0] || i.data_incasso;
      acc[giorno] = (acc[giorno] || 0) + parseFloat(i.importo || 0);
      return acc;
    }, {});
    const media_per_giorno = numero
      ? (totale / Object.keys(perGiorno).length).toFixed(2)
      : '0.00';

    res.json({ totale: totale.toFixed(2), numero, media_per_giorno, per_giorno: perGiorno });
  } catch (err) {
    console.error('❌ Errore /income-stats:', err);
    res.status(500).json({ error: 'Errore nel calcolo statistiche incassi' });
  }
});


/* === Ultimi 3 incassi === */
app.get('/latest-income', async (req, res) => {
  try {
    const { companyId } = req;
    const result = await db.query(`
      SELECT * FROM incomes
      WHERE azienda_id = $1
      ORDER BY data_creazione DESC
      LIMIT 3
    `, [companyId]);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Errore /latest-income:', err);
    res.status(500).json({ error: 'Errore recupero ultimi incassi' });
  }
});


/* === Ultime 3 spese === */
app.get('/latest-expenses', async (req, res) => {
  try {
    const { companyId } = req;
    const result = await db.query(`
      SELECT * FROM documents
      WHERE azienda_id = $1
      ORDER BY data_creazione DESC
      LIMIT 3
    `, [companyId]);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Errore /latest-expenses:', err);
    res.status(500).json({ error: 'Errore recupero ultime spese' });
  }
});


app.get('/', (req, res) => {
  res.send('✅ Backend attivo!');
});

export default app;
