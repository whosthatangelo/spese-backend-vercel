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
// Aggiungi questi endpoint al tuo api/index.js
import { requirePermission, requireSuperAdmin, requireAdminAzienda, getUserPermissions } from '../middleware/auth.js';
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

  // ✅ AGGIUNTO /user/status alla lista delle rotte che non richiedono company
  if (req.path === '/' || req.path === '/companies' || req.path === '/auth/google' || req.path === '/logout' || 
      req.path.startsWith('/admin/') || req.path === '/user/permissions' || req.path === '/user/status' || 
      req.path === '/setup-database' || req.path.startsWith('/debug/')) {
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
/* 3) GET /companies → lista aziende dell'utente */
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

/* === LOGIN CON GOOGLE === */
app.post('/auth/google', async (req, res) => {
  try {
    const { email, name, photoURL, uid } = req.body;

    if (!email || !uid) {
      return res.status(400).json({ error: 'Email e UID Google sono richiesti' });
    }

    console.log(`🔐 Tentativo login Google per: ${email}`);

    // Controlla se l'utente esiste già
    let userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    let user;

    if (userResult.rows.length > 0) {
      // Utente esistente: aggiorna i dati Google
      user = userResult.rows[0];
      await db.query(`
        UPDATE users 
        SET name = $1, profile_picture = $2, google_id = $3, last_login = NOW()
        WHERE email = $4
      `, [name || user.name, photoURL, uid, email]);

      console.log(`✅ Utente esistente aggiornato: ${email}`);
    } else {
      // Nuovo utente: crea record
      const insertResult = await db.query(`
        INSERT INTO users (email, name, profile_picture, google_id, created_at, last_login)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        RETURNING *
      `, [email, name || email.split('@')[0], photoURL, uid]);

      user = insertResult.rows[0];
      console.log(`✅ Nuovo utente Google creato: ${email}`);
    }

    res.json({
      userId: user.id,
      message: 'Login Google completato con successo',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        photoURL: user.profile_picture
      }
    });

  } catch (error) {
    console.error('❌ Errore Google Auth:', error);
    res.status(500).json({ error: 'Errore durante l\'autenticazione Google' });
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

// ===== VERSIONE CORRETTA DI normalizeFields =====
function normalizeFields(data) {
  const normalize = (value) => value?.toLowerCase()?.trim();
  const isValidDate = (str) => /^\d{4}-\d{2}-\d{2}$/.test(str);

  // ✨ Mappa parole tipo "oggi" in vere date - VERSIONE MIGLIORATA
  const parseNaturalDate = (value) => {
    if (!value) return value;

    // Normalizza il valore prima di controllare
    const normalizedValue = normalize(value);
    const today = new Date();

    // Controlla se contiene parole chiave (non solo uguaglianza esatta)
    if (normalizedValue.includes("oggi") || normalizedValue.includes("di oggi")) {
      return today.toISOString().split("T")[0];
    }
    if (normalizedValue.includes("ieri") || normalizedValue.includes("di ieri")) {
      const d = new Date(today);
      d.setDate(today.getDate() - 1);
      return d.toISOString().split("T")[0];
    }
    if (normalizedValue.includes("domani") || normalizedValue.includes("di domani")) {
      const d = new Date(today);
      d.setDate(today.getDate() + 1);
      return d.toISOString().split("T")[0];
    }

    // Se è già una data valida, restituiscila com'è
    if (isValidDate(normalizedValue)) {
      return normalizedValue;
    }

    // Prova a parsare altre espressioni di date comuni in italiano
    const datePatterns = [
      // "7 luglio" -> "2025-07-07"
      /(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/i,
      // "del 7 luglio" -> "2025-07-07"
      /del\s+(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/i
    ];

    const months = {
      'gennaio': '01', 'febbraio': '02', 'marzo': '03', 'aprile': '04',
      'maggio': '05', 'giugno': '06', 'luglio': '07', 'agosto': '08',
      'settembre': '09', 'ottobre': '10', 'novembre': '11', 'dicembre': '12'
    };

    for (const pattern of datePatterns) {
      const match = normalizedValue.match(pattern);
      if (match) {
        const day = match[1].padStart(2, '0');
        const month = months[match[2].toLowerCase()];
        const year = today.getFullYear();
        return `${year}-${month}-${day}`;
      }
    }

    return value; // Se non trova pattern, restituisce il valore originale
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

  // 🔧 FIX: Gestione campi vuoti e date mancanti
  if (data.tipo === 'spesa' && (!data.data_fattura || data.data_fattura === '')) {
    data.data_fattura = 'oggi'; // Default per spese
  }

  if (data.tipo === 'incasso' && (!data.data_incasso || data.data_incasso === '')) {
    data.data_incasso = 'oggi'; // Default per incassi
  }

  // 🔧 FIX: Mapping POS nei campi sbagliati
  if (data.tipo_pagamento === 'POS' && !data.metodo_pagamento) {
    data.metodo_pagamento = 'POS';
    data.tipo_pagamento = '';
  }

  if (data.tipo_pagamento === 'POS' && !data.metodo_incasso && data.tipo === 'incasso') {
    data.metodo_incasso = 'POS';
    data.tipo_pagamento = '';
  }

  if (data.metodo_pagamento)
    data.metodo_pagamento = metodoPagamentoMap[normalize(data.metodo_pagamento)] || data.metodo_pagamento;

  if (data.tipo_documento)
    data.tipo_documento = tipoDocumentoMap[normalize(data.tipo_documento)] || data.tipo_documento;

  if (data.tipo_pagamento)
    data.tipo_pagamento = tipoPagamentoMap[normalize(data.tipo_pagamento)] || data.tipo_pagamento;

  if (data.metodo_incasso)
    data.metodo_incasso = metodoPagamentoMap[normalize(data.metodo_incasso)] || data.metodo_incasso;

  // 🗓️ Normalizza le date con la funzione migliorata
  if (data.data_fattura) {
    data.data_fattura = parseNaturalDate(data.data_fattura);
    if (data.data_fattura !== "non disponibile" && !isValidDate(data.data_fattura)) {
      console.warn(`⚠️ Formato data_fattura non valido: ${data.data_fattura}, uso data odierna`);
      data.data_fattura = new Date().toISOString().split("T")[0];
    }
  }

  if (data.data_incasso) {
    data.data_incasso = parseNaturalDate(data.data_incasso);
    if (data.data_incasso !== "non disponibile" && !isValidDate(data.data_incasso)) {
      console.warn(`⚠️ Formato data_incasso non valido: ${data.data_incasso}, uso data odierna`);
      data.data_incasso = new Date().toISOString().split("T")[0];
    }
  }

  if (data.data_creazione) {
    data.data_creazione = parseNaturalDate(data.data_creazione);
    if (!isValidDate(data.data_creazione)) {
      // fallback automatico alla data corrente se errata
      data.data_creazione = new Date().toISOString().split("T")[0];
    }
  }

  return data;
}

/* === Parsing con OpenAI MIGLIORATO === */
async function extractDataFromText(text) {
  const prompt = `
  Analizza questo testo trascritto da audio e determina se è una SPESA o un INCASSO:

  "${text}"

  🔍 REGOLE DI CLASSIFICAZIONE:
  - Se contiene: "incasso", "incassato", "ricevuto", "entrata", "guadagno" → INCASSO
  - Se contiene: "spesa", "speso", "pagato", "acquistato", "fattura" → SPESA
  - In caso di dubbio, analizza il contesto

  🔹 Se è una **SPESA**, restituisci:
  {
    "tipo": "spesa",
    "numero_fattura": "...",
    "data_fattura": "oggi|ieri|domani|YYYY-MM-DD",
    "importo": 123.45,
    "valuta": "EUR",
    "azienda": "...",
    "tipo_pagamento": "...",
    "banca": "...",
    "tipo_documento": "...",
    "stato": "",
    "metodo_pagamento": "Contanti|POS|Carta di Credito|Bonifico|...",
    "data_creazione": "oggi",
    "utente_id": "user_1"
  }

  🔹 Se è un **INCASSO**, restituisci:
  {
    "tipo": "incasso",
    "data_incasso": "oggi|ieri|domani|YYYY-MM-DD",
    "importo": 123.45,
    "valuta": "EUR",
    "metodo_incasso": "Contanti|POS|Carta di Credito|Bonifico|...",
    "data_creazione": "oggi",
    "utente_id": "user_1"
  }

  ⚠️ IMPORTANTE:
  - Se il testo contiene "incasso" o "incassato" → tipo: "incasso"
  - Mappa sempre POS/Bancomat → "POS"
  - NUMERI: "37 e 43" significa 37,43 (non 37+43=80)
  - Se mancano informazioni, usa stringhe vuote
  - Per le date usa "oggi", "ieri", "domani" quando appropriato
  - Rispondi SOLO con JSON valido, nessun testo aggiuntivo
  `;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { 
        role: 'system', 
        content: 'Sei un esperto contabile che classifica spese e incassi. Analizza con attenzione le parole chiave per determinare il tipo corretto.' 
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.1 // Più deterministico
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
app.post('/upload-audio', requirePermission('expenses', 'create'), upload.single('audio'), async (req, res) => {
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
      const doc = {
        ...parsedData,
        azienda_id: req.companyId,
        utente_id: req.userId, // Assegna automaticamente l'utente
        data_creazione: new Date().toISOString()
      };
      await saveDocumento(doc);
      return res.status(200).json({
        message: 'Spesa salvata con successo',
        spesa: doc
      });

    } else if (parsedData.tipo === 'incasso') {
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
          req.userId, // Assegna automaticamente l'utente
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
app.get('/expenses', requirePermission('expenses', 'read'), async (req, res) => {
  try {
    const { companyId, userId, userRole, userPermissions } = req;

    let query = 'SELECT * FROM documents WHERE azienda_id = $1';
    let params = [companyId];

    // Se l'utente può vedere solo le proprie spese
    if (userPermissions.expenses?.scope === 'own') {
      query += ' AND utente_id = $2';
      params.push(userId);
    }

    query += ' ORDER BY data_creazione DESC';

    const result = await db.query(query, params);

    console.log(`📊 Spese caricate per ${userRole}: ${result.rows.length} risultati`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Errore /expenses:', err);
    res.status(500).json({ error: 'Errore recupero spese' });
  }
});

/* === API incassi === */
app.get('/incomes', requirePermission('incomes', 'read'), async (req, res) => {
  try {
    const { companyId, userId, userRole, userPermissions } = req;

    let query = 'SELECT * FROM incomes WHERE azienda_id = $1';
    let params = [companyId];

    // Se l'utente può vedere solo i propri incassi
    if (userPermissions.incomes?.scope === 'own') {
      query += ' AND utente_id = $2';
      params.push(userId);
    }

    query += ' ORDER BY data_incasso DESC';

    const result = await db.query(query, params);

    console.log(`💰 Incassi caricati per ${userRole}: ${result.rows.length} risultati`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Errore /incomes:', err);
    res.status(500).json({ error: 'Errore recupero incassi' });
  }
});

// 🗑️ Elimina un incasso
// 🗑️ Elimina un incasso PROTETTO
app.delete('/incomes/:id', requirePermission('incomes', 'delete'), async (req, res) => {
  try {
    const { companyId, userId, userPermissions } = req;
    const id = req.params.id;

    let query = 'DELETE FROM incomes WHERE id = $1 AND azienda_id = $2';
    let params = [id, companyId];

    // Se può eliminare solo i propri incassi
    if (userPermissions.incomes?.scope === 'own') {
      query += ' AND utente_id = $3';
      params.push(userId);
    }

    query += ' RETURNING *';

    const result = await db.query(query, params);

    if (!result.rowCount) {
      return res.status(404).json({ error: 'Incasso non trovato o non autorizzato' });
    }
    res.json({ message: 'Incasso eliminato', deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Errore cancellazione incasso:', err);
    res.status(500).json({ error: 'Errore nella cancellazione incasso' });
  }
});

// ✏️ Modifica un incasso PROTETTO
app.put('/incomes/:id', requirePermission('incomes', 'update'), async (req, res) => {
  try {
    const { companyId, userId, userPermissions } = req;
    const { data_incasso, importo, valuta, metodo_incasso, utente_id } = req.body;

    let query = `UPDATE incomes SET 
      data_incasso = $1,
      importo      = $2,
      valuta       = $3,
      metodo_incasso = $4,
      utente_id    = $5,
      updated_at   = CURRENT_TIMESTAMP
     WHERE id = $6 AND azienda_id = $7`;
    let params = [data_incasso, importo, valuta, metodo_incasso, utente_id, req.params.id, companyId];

    // Se può modificare solo i propri incassi
    if (userPermissions.incomes?.scope === 'own') {
      query += ' AND utente_id = $8';
      params.push(userId);
    }

    query += ' RETURNING *';

    const result = await db.query(query, params);

    if (!result.rowCount) {
      return res.status(404).json({ error: 'Incasso non trovato o non autorizzato' });
    }
    res.json({ message: 'Incasso aggiornato con successo', updated: result.rows[0] });
  } catch (err) {
    console.error('❌ Errore modifica incasso:', err);
    res.status(500).json({ error: 'Errore nella modifica incasso' });
  }
});

/* === Creazione spesa via API PROTETTA === */
app.post('/expenses', requirePermission('expenses', 'create'), async (req, res) => {
  try {
    const doc = {
      ...req.body,
      azienda_id: req.companyId,
      utente_id: req.userId, // Assegna automaticamente l'utente che crea
      data_creazione: new Date().toISOString()
    };
    await saveDocumento(doc);
    res.status(201).json({ message: 'Spesa salvata', data: doc });
  } catch (err) {
    console.error('❌ Errore POST /expenses:', err);
    res.status(500).json({ error: 'Errore nel salvataggio spesa' });
  }
});

// ✏️ Modifica spesa PROTETTA
app.put('/expenses/:numero_fattura', requirePermission('expenses', 'update'), async (req, res) => {
  try {
    const { userPermissions, userId, companyId } = req;

    // Se può modificare solo le proprie spese, controlla ownership
    if (userPermissions.expenses?.scope === 'own') {
      const checkOwnership = await db.query(
        'SELECT utente_id FROM documents WHERE numero_fattura = $1 AND azienda_id = $2',
        [req.params.numero_fattura, companyId]
      );

      if (checkOwnership.rows.length === 0 || 
          checkOwnership.rows[0].utente_id !== userId.toString()) {
        return res.status(403).json({ error: 'Non puoi modificare questa spesa' });
      }
    }

    await updateSpesa(req.params.numero_fattura, {
      ...req.body,
      azienda_id: companyId
    });
    res.json({ message: 'Spesa modificata' });
  } catch (err) {
    console.error('❌ Errore modifica spesa:', err);
    res.status(500).json({ error: 'Errore nella modifica spesa' });
  }
});

// 🗑️ Elimina spesa PROTETTA
app.delete('/expenses/:numero_fattura', requirePermission('expenses', 'delete'), async (req, res) => {
  try {
    const { userPermissions, userId, companyId } = req;

    // Se può eliminare solo le proprie spese, controlla ownership
    if (userPermissions.expenses?.scope === 'own') {
      const checkOwnership = await db.query(
        'SELECT utente_id FROM documents WHERE numero_fattura = $1 AND azienda_id = $2',
        [req.params.numero_fattura, companyId]
      );

      if (checkOwnership.rows.length === 0 || 
          checkOwnership.rows[0].utente_id !== userId.toString()) {
        return res.status(403).json({ error: 'Non puoi eliminare questa spesa' });
      }
    }

    await deleteSpesa(req.params.numero_fattura, companyId);
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


/* === LOGOUT UTENTE === */
app.post('/logout', async (req, res) => {
  try {
    const { userId, email } = req.body;

    console.log(`🚪 Logout richiesto per userId: ${userId}, email: ${email}`);

    // Aggiorna last_login nel database
    if (userId) {
      await db.query(
        'UPDATE users SET last_login = NOW() WHERE id = $1',
        [userId]
      );
      console.log(`✅ Last login aggiornato per userId: ${userId}`);
    }

    res.json({ 
      message: 'Logout completato con successo',
      timestamp: new Date().toISOString()
    });

    console.log(`🚪 Logout completato per userId: ${userId}`);

  } catch (error) {
    console.error('❌ Errore durante logout:', error);
    res.status(500).json({ error: 'Errore durante il logout' });
  }
});



/* === GET USER PERMISSIONS === */
app.get('/user/permissions', async (req, res) => {
  try {
    const { userId } = req;
    const companyId = req.header('x-company-id'); // ← Leggi direttamente l'header

    if (!userId) {
      return res.status(401).json({ error: 'Utente non autenticato' });
    }

    if (!companyId) {
      return res.json({ 
        role: 'none', 
        permissions: {},
        needsCompanySelection: true 
      });
    }

    const permissions = await getUserPermissions(userId, companyId);
    res.json(permissions);
  } catch (error) {
    console.error('❌ Errore /user/permissions:', error);
    res.status(500).json({ error: 'Errore recupero permessi' });
  }
});

// 3️⃣ AGGIUNGI questo nuovo endpoint DOPO l'endpoint /user/permissions:
app.get('/user/status', async (req, res) => {
  try {
    const { userId } = req;

    if (!userId) {
      return res.status(401).json({ error: 'Utente non autenticato' });
    }

    // Verifica se l'utente esiste
    const userResult = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Utente non trovato' });
    }

    const user = userResult.rows[0];

    // Verifica se l'utente ha companies
    const companiesResult = await db.query(`
      SELECT c.id, c.nome, r.name as role_name
      FROM companies c
      JOIN user_companies uc ON uc.azienda_id = c.id::text
      JOIN roles r ON r.id = uc.role_id
      WHERE uc.utente_id = $1::text
    `, [userId]);

    const hasCompanies = companiesResult.rows.length > 0;

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        profile_picture: user.profile_picture
      },
      hasCompanies,
      companies: companiesResult.rows,
      needsCompanyAssignment: !hasCompanies
    });

  } catch (error) {
    console.error('❌ Errore /user/status:', error);
    res.status(500).json({ error: 'Errore recupero stato utente' });
  }
});

/* === GESTIONE COMPANIES (Solo Super Admin) === */

// Lista tutte le companies (Super Admin)
app.get('/admin/companies', requireSuperAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT c.*, 
             COUNT(uc.utente_id) as user_count,
             u.name as admin_name, u.email as admin_email
      FROM companies c
      LEFT JOIN user_companies uc ON uc.azienda_id = c.id::text
      LEFT JOIN users u ON u.id::text = (
        SELECT uc2.utente_id FROM user_companies uc2 
        JOIN roles r ON r.id = uc2.role_id 
        WHERE uc2.azienda_id = c.id::text AND r.name = 'admin_azienda' 
        LIMIT 1
      )
      GROUP BY c.id, u.name, u.email
      ORDER BY c.nome
    `);

    console.log(`🏢 Admin companies: trovate ${result.rows.length} aziende`);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Errore /admin/companies:', error);
    res.status(500).json({ error: 'Errore recupero companies' });
  }
});


// Crea nuova company (Super Admin)
app.post('/admin/companies', requireSuperAdmin, async (req, res) => {
  try {
    const { nome, admin_email } = req.body;

    if (!nome || !admin_email) {
      return res.status(400).json({ error: 'Nome e email admin richiesti' });
    }

    // Verifica che l'admin esista
    const adminResult = await db.query('SELECT id FROM users WHERE email = $1', [admin_email]);
    if (adminResult.rows.length === 0) {
      return res.status(400).json({ error: 'Admin email non trovata nel sistema' });
    }

    const adminUserId = adminResult.rows[0].id;

    // Crea la company
    const companyResult = await db.query(
      'INSERT INTO companies (nome) VALUES ($1) RETURNING *',
      [nome]
    );
    const newCompany = companyResult.rows[0];

    // Assegna l'admin alla company
    const adminRoleResult = await db.query('SELECT id FROM roles WHERE name = $1', ['admin_azienda']);
    const adminRoleId = adminRoleResult.rows[0].id;

    await db.query(
      'INSERT INTO user_companies (utente_id, azienda_id, role_id) VALUES ($1, $2, $3)',
      [adminUserId.toString(), newCompany.id.toString(), adminRoleId]
    );

    console.log(`✅ Company creata: ${nome} con admin ${admin_email}`);
    res.json({ 
      message: 'Company creata con successo',
      company: newCompany,
      admin: { id: adminUserId, email: admin_email }
    });

  } catch (error) {
    console.error('❌ Errore creazione company:', error);
    res.status(500).json({ error: 'Errore creazione company' });
  }
});

/* === GESTIONE UTENTI AZIENDA (Admin Azienda + Super Admin) === */

// Lista utenti della propria azienda
// Lista utenti della propria azienda O di tutte se Super Admin
app.get('/admin/users', requireAdminAzienda, async (req, res) => {
  try {
    const { companyId, userRole } = req;

    // 🔧 FIX: Se Super Admin può scegliere quale company vedere
    let targetCompanyId = companyId;
    if (userRole === 'super_admin' && req.query.company_id) {
      targetCompanyId = req.query.company_id;
    }

    // 🔧 FIX: Se Super Admin senza company_id, mostra tutte
    let query;
    let params;

    if (userRole === 'super_admin' && !req.query.company_id) {
      // Super Admin vede tutti gli utenti di tutte le aziende
      query = `
        SELECT u.id, u.email, u.name, u.profile_picture, u.created_at, u.last_login,
               r.name as role_name, uc.role_id, c.nome as company_name, c.id as company_id
        FROM users u
        JOIN user_companies uc ON uc.utente_id = u.id::text
        JOIN roles r ON r.id = uc.role_id
        JOIN companies c ON c.id = uc.azienda_id::integer
        ORDER BY c.nome, r.id ASC, u.name ASC
      `;
      params = [];
    } else {
      // Admin azienda o Super Admin con company specifica
      query = `
        SELECT u.id, u.email, u.name, u.profile_picture, u.created_at, u.last_login,
               r.name as role_name, uc.role_id
        FROM users u
        JOIN user_companies uc ON uc.utente_id = u.id::text
        JOIN roles r ON r.id = uc.role_id
        WHERE uc.azienda_id = $1
        ORDER BY r.id ASC, u.name ASC
      `;
      params = [targetCompanyId];
    }

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Errore /admin/users:', error);
    res.status(500).json({ error: 'Errore recupero utenti' });
  }
});

// Invita nuovo utente (Admin Azienda + Super Admin)
app.post('/admin/users/invite', requireAdminAzienda, async (req, res) => {
  try {
    const { email, role_name } = req.body;
    const { companyId } = req;

    if (!email || !role_name) {
      return res.status(400).json({ error: 'Email e ruolo richiesti' });
    }

    // Verifica che il ruolo esista e sia assegnabile
    const roleResult = await db.query('SELECT id FROM roles WHERE name = $1', [role_name]);
    if (roleResult.rows.length === 0) {
      return res.status(400).json({ error: 'Ruolo non valido' });
    }

    // Verifica che l'utente esista nel sistema
    const userResult = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: 'Utente non trovato. Deve prima registrarsi con Google.' });
    }

    const userId = userResult.rows[0].id;
    const roleId = roleResult.rows[0].id;

    // Verifica che non sia già nella company
    const existingResult = await db.query(
      'SELECT 1 FROM user_companies WHERE utente_id = $1 AND azienda_id = $2',
      [userId, companyId]
    );

    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: 'Utente già presente in questa azienda' });
    }

    // Aggiungi utente alla company
    await db.query(
      'INSERT INTO user_companies (utente_id, azienda_id, role_id) VALUES ($1, $2, $3)',
      [userId, companyId, roleId]
    );

    console.log(`✅ Utente invitato: ${email} come ${role_name} in company ${companyId}`);
    res.json({ 
      message: 'Utente invitato con successo',
      user: { email, role: role_name }
    });

  } catch (error) {
    console.error('❌ Errore invito utente:', error);
    res.status(500).json({ error: 'Errore invito utente' });
  }
});

// Cambia ruolo utente (Admin Azienda + Super Admin)
app.put('/admin/users/:userId/role', requireAdminAzienda, async (req, res) => {
  try {
    const { userId: targetUserId } = req.params;
    const { role_name } = req.body;
    const { companyId } = req;

    if (!role_name) {
      return res.status(400).json({ error: 'Nuovo ruolo richiesto' });
    }

    // Verifica che il ruolo esista
    const roleResult = await db.query('SELECT id FROM roles WHERE name = $1', [role_name]);
    if (roleResult.rows.length === 0) {
      return res.status(400).json({ error: 'Ruolo non valido' });
    }

    const roleId = roleResult.rows[0].id;

    // Aggiorna il ruolo
    const updateResult = await db.query(
      'UPDATE user_companies SET role_id = $1 WHERE utente_id = $2 AND azienda_id = $3 RETURNING *',
      [roleId, targetUserId, companyId]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Utente non trovato in questa azienda' });
    }

    console.log(`✅ Ruolo aggiornato: user ${targetUserId} ora è ${role_name}`);
    res.json({ 
      message: 'Ruolo aggiornato con successo',
      updated: updateResult.rows[0]
    });

  } catch (error) {
    console.error('❌ Errore cambio ruolo:', error);
    res.status(500).json({ error: 'Errore cambio ruolo' });
  }
});

// Lista ruoli disponibili
app.get('/admin/roles', requireAdminAzienda, async (req, res) => {
  try {
    const result = await db.query('SELECT id, name FROM roles ORDER BY id');
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Errore /admin/roles:', error);
    res.status(500).json({ error: 'Errore recupero ruoli' });
  }
});


// 🔧 AGGIUNGI QUESTO ENDPOINT TEMPORANEO al backend/api/index.js

// 🔧 SOSTITUISCI l'endpoint /setup-database con questa versione corretta

app.get('/setup-database', async (req, res) => {
  try {
    console.log('🔧 Iniziando setup database...');

    // 1. Crea tabella roles se non esiste
    await db.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        permissions JSONB NOT NULL DEFAULT '{}'
      )
    `);

    // 2. Crea tabella companies se non esiste
    await db.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 3. Crea tabella user_companies se non esiste
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_companies (
        id SERIAL PRIMARY KEY,
        utente_id TEXT NOT NULL,
        azienda_id TEXT NOT NULL,
        role_id INTEGER REFERENCES roles(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(utente_id, azienda_id)
      )
    `);

    // 4. Inserisci ruoli
    const roles = [
      {
        name: 'super_admin',
        permissions: {
          "companies": {"create": true, "read": true, "update": true, "delete": true, "scope": "global"},
          "users": {"create": true, "read": true, "update": true, "delete": true, "assign_roles": true, "scope": "global"},
          "expenses": {"create": true, "read": true, "update": true, "delete": true, "scope": "global"},
          "incomes": {"create": true, "read": true, "update": true, "delete": true, "scope": "global"},
          "admin": {"full_access": true}
        }
      },
      {
        name: 'admin_azienda',
        permissions: {
          "users": {"create": true, "read": true, "update": true, "delete": true, "assign_roles": true, "scope": "company"},
          "expenses": {"create": true, "read": true, "update": true, "delete": true, "scope": "company"},
          "incomes": {"create": true, "read": true, "update": true, "delete": true, "scope": "company"},
          "admin": {"company_level": true}
        }
      },
      {
        name: 'user',
        permissions: {
          "expenses": {"create": true, "read": true, "update": true, "delete": true, "scope": "own"},
          "incomes": {"create": true, "read": true, "update": true, "delete": true, "scope": "own"}
        }
      }
    ];

    for (const role of roles) {
      await db.query(`
        INSERT INTO roles (name, permissions) VALUES ($1, $2)
        ON CONFLICT (name) DO UPDATE SET permissions = $2
      `, [role.name, JSON.stringify(role.permissions)]);
    }

    // 5. Trova utente iamangeloiaia@gmail.com
    const userResult = await db.query(
      'SELECT id FROM users WHERE email = $1',
      ['iamangeloiaia@gmail.com']
    );

    if (userResult.rows.length === 0) {
      return res.json({ 
        error: 'Utente iamangeloiaia@gmail.com non trovato',
        message: 'Devi prima fare login con Google'
      });
    }

    const userId = userResult.rows[0].id;

    // 6. Crea company principale (senza ON CONFLICT su ID)
    const companyResult = await db.query(`
      SELECT id FROM companies WHERE nome = 'Main Company'
    `);

    let companyId;
    if (companyResult.rows.length === 0) {
      const insertResult = await db.query(`
        INSERT INTO companies (nome) VALUES ('Main Company') RETURNING id
      `);
      companyId = insertResult.rows[0].id;
    } else {
      companyId = companyResult.rows[0].id;
    }

    // 7. Assegna come super admin
    await db.query(`
      INSERT INTO user_companies (utente_id, azienda_id, role_id)
      VALUES ($1, $2, (SELECT id FROM roles WHERE name = 'super_admin'))
      ON CONFLICT (utente_id, azienda_id) 
      DO UPDATE SET role_id = (SELECT id FROM roles WHERE name = 'super_admin')
    `, [userId, companyId.toString()]);

    // 8. Verifica risultato
    const verifyResult = await db.query(`
      SELECT u.email, r.name as role_name, c.nome as company_name, c.id as company_id
      FROM users u
      JOIN user_companies uc ON uc.utente_id = u.id::text
      JOIN companies c ON c.id = uc.azienda_id::integer
      JOIN roles r ON r.id = uc.role_id
      WHERE u.email = 'iamangeloiaia@gmail.com'
    `);

    res.json({
      success: true,
      message: 'Database setup completato!',
      user: verifyResult.rows[0] || 'Nessun risultato',
      userId: userId,
      companyId: companyId
    });

  } catch (error) {
    console.error('❌ Errore setup database:', error);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
});

// Aggiungi questo in backend/api/index.js
app.get('/debug/permissions/:userId/:companyId', async (req, res) => {
  try {
    const { userId, companyId } = req.params;

    console.log(`🔍 Debug - userId: ${userId}, companyId: ${companyId}`);

    // Test query diretta
    const result = await db.query(`
      SELECT uc.*, r.name as role_name, r.permissions, u.email
      FROM user_companies uc
      JOIN roles r ON r.id = uc.role_id
      JOIN users u ON u.id = uc.utente_id::integer
      WHERE uc.utente_id = $1 AND uc.azienda_id = $2
    `, [userId, companyId]);

    res.json({
      query: `userId=${userId}, companyId=${companyId}`,
      results: result.rows,
      rowCount: result.rowCount
    });

  } catch (error) {
    res.json({ error: error.message });
  }
});



// Aggiungi endpoint nel backend
app.get('/fix-user-company3', async (req, res) => {
  try {
    await db.query(`
      INSERT INTO user_companies (utente_id, azienda_id, role_id)
      VALUES ('1', '3', (SELECT id FROM roles WHERE name = 'super_admin'))
      ON CONFLICT (utente_id, azienda_id) 
      DO UPDATE SET role_id = (SELECT id FROM roles WHERE name = 'super_admin')
    `);

    res.json({ success: true, message: 'Utente aggiunto come super_admin per company 3!' });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Aggiungi in backend/api/index.js
app.get('/debug/headers', async (req, res) => {
  res.json({
    'x-user-id': req.header('x-user-id'),
    'x-company-id': req.header('x-company-id'),
    userId: req.userId,
    companyId: req.companyId,
    allHeaders: req.headers
  });
});

export default app;