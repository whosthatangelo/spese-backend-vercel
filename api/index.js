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

// Configurazione multer migliorata con validazione
const upload = multer({ 
  dest: '/tmp',
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/m4a', 'audio/webm', 'audio/ogg'];
    if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(wav|mp3|m4a|webm|ogg)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Formato audio non supportato'), false);
    }
  }
});

app.use(cors());
app.use(express.json());

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

/* === Trascrizione vocale migliorata === */
async function transcribeAudio(file) {
  const outputPath = `/tmp/${Date.now()}_${path.parse(file.originalname).name}.mp3`;

  try {
    // Conversione con parametri ottimizzati per la trascrizione
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        '-i', file.path,
        '-f', 'mp3',
        '-acodec', 'libmp3lame',
        '-ar', '16000', // Frequenza ottimale per Whisper
        '-ac', '1',     // Mono audio
        '-b:a', '64k',  // Bitrate ottimizzato
        '-y',
        outputPath
      ]);

      let stderr = '';
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log('✅ Conversione completata:', outputPath);
          resolve();
        } else {
          console.error('❌ FFmpeg stderr:', stderr);
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
    });

    // Trascrizione con parametri ottimizzati
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(outputPath),
      model: 'whisper-1',
      response_format: 'verbose_json', // Ottieni più informazioni
      language: 'it',
      temperature: 0.2, // Più deterministico
      prompt: "Trascrivi questo audio che parla di spese, incassi, fatture, pagamenti e documenti commerciali in italiano." // Context hint
    });

    return transcription;
  } finally {
    // Cleanup dei file temporanei
    try {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (cleanupError) {
      console.warn('⚠️ Errore pulizia file:', cleanupError);
    }
  }
}

/* === Normalizzazione dati migliorata === */
function normalizeFields(data) {
  const normalize = (value) => value?.toString()?.toLowerCase()?.trim();
  const isValidDate = (str) => /^\d{4}-\d{2}-\d{2}$/.test(str);

  // Parser date naturali più robusto
  const parseNaturalDate = (value) => {
    if (!value) return null;

    const today = new Date();
    const normalizedValue = normalize(value);

    // Date relative
    if (normalizedValue === "oggi") return today.toISOString().split("T")[0];
    if (normalizedValue === "ieri") {
      const d = new Date(today);
      d.setDate(today.getDate() - 1);
      return d.toISOString().split("T")[0];
    }
    if (normalizedValue === "domani") {
      const d = new Date(today);
      d.setDate(today.getDate() + 1);
      return d.toISOString().split("T")[0];
    }

    // Parse date in formato italiano (dd/mm/yyyy, dd-mm-yyyy)
    const italianDatePattern = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/;
    const match = value.match(italianDatePattern);
    if (match) {
      let [, day, month, year] = match;
      if (year.length === 2) year = '20' + year;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    // Se già in formato ISO, mantienilo
    if (isValidDate(value)) return value;

    return value;
  };

  // Mappe di normalizzazione più complete
  const metodoPagamentoMap = {
    'contanti': 'Contanti',
    'cash': 'Contanti',
    'soldi': 'Contanti',
    'bancomat': 'POS',
    'pos': 'POS',
    'carta': 'Carta di Credito',
    'carta di credito': 'Carta di Credito',
    'carta di debito': 'POS',
    'bonifico': 'Bonifico',
    'bonifico bancario': 'Bonifico',
    'assegno': 'Assegno',
    'paypal': 'PayPal',
    'satispay': 'Satispay'
  };

  const tipoDocumentoMap = {
    'fattura': 'Fattura',
    'ricevuta': 'Ricevuta',
    'scontrino': 'Scontrino',
    'documento di trasporto': 'Documento di Trasporto',
    'bolla': 'Documento di Trasporto',
    'ddt': 'Documento di Trasporto',
    'nota di credito': 'Nota di Credito',
    'preventivo': 'Preventivo'
  };

  const tipoPagamentoMap = {
    'fine mese': 'Fine mese',
    'immediato': 'Immediato',
    'subito': 'Immediato',
    'contanti': 'Immediato',
    '30 giorni': '30 giorni',
    'trenta giorni': '30 giorni',
    '60 giorni': '60 giorni',
    'sessanta giorni': '60 giorni',
    'a vista': 'A vista'
  };

  // Applica normalizzazioni
  if (data.metodo_pagamento) {
    data.metodo_pagamento = metodoPagamentoMap[normalize(data.metodo_pagamento)] || data.metodo_pagamento;
  }

  if (data.tipo_documento) {
    data.tipo_documento = tipoDocumentoMap[normalize(data.tipo_documento)] || data.tipo_documento;
  }

  if (data.tipo_pagamento) {
    data.tipo_pagamento = tipoPagamentoMap[normalize(data.tipo_pagamento)] || data.tipo_pagamento;
  }

  if (data.metodo_incasso) {
    data.metodo_incasso = metodoPagamentoMap[normalize(data.metodo_incasso)] || data.metodo_incasso;
  }

  // Normalizza importi
  if (data.importo) {
    // Rimuovi caratteri non numerici eccetto punto e virgola
    let importo = data.importo.toString().replace(/[^\d.,]/g, '');
    // Sostituisci virgola con punto per formato decimale
    importo = importo.replace(',', '.');
    data.importo = parseFloat(importo) || 0;
  }

  // Normalizza date
  if (data.data_fattura) {
    data.data_fattura = parseNaturalDate(data.data_fattura);
    if (data.data_fattura && data.data_fattura !== "non disponibile" && !isValidDate(data.data_fattura)) {
      console.warn(`⚠️ Formato data_fattura non valido: ${data.data_fattura}`);
      data.data_fattura = new Date().toISOString().split("T")[0]; // Fallback a oggi
    }
  }

  if (data.data_incasso) {
    data.data_incasso = parseNaturalDate(data.data_incasso);
    if (data.data_incasso && data.data_incasso !== "non disponibile" && !isValidDate(data.data_incasso)) {
      console.warn(`⚠️ Formato data_incasso non valido: ${data.data_incasso}`);
      data.data_incasso = new Date().toISOString().split("T")[0]; // Fallback a oggi
    }
  }

  if (data.data_creazione) {
    data.data_creazione = parseNaturalDate(data.data_creazione);
    if (!isValidDate(data.data_creazione)) {
      data.data_creazione = new Date().toISOString().split("T")[0];
    }
  }

  return data;
}

/* === Parsing con OpenAI migliorato === */
async function extractDataFromText(text, confidence = 0) {
  // Prompt più strutturato e intelligente
  const prompt = `
Analizza questo testo trascritto da un audio e determina se si tratta di una SPESA o di un INCASSO.

TESTO: "${text}"

IMPORTANTE: 
- Se si parla di pagare, comprare, acquistare, spendere → è una SPESA
- Se si parla di vendere, incassare, ricevere denaro → è un INCASSO
- Se hai dubbi, considera come SPESA

Rispondi SOLO con un oggetto JSON valido seguendo questi schemi:

Per SPESA:
{
  "tipo": "spesa",
  "numero_fattura": "estratto dal testo o genera automaticamente",
  "data_fattura": "YYYY-MM-DD (usa oggi se non specificato)",
  "importo": numero_senza_valuta,
  "valuta": "EUR",
  "azienda": "nome_fornitore_estratto",
  "tipo_pagamento": "Immediato/Fine mese/30 giorni/60 giorni/A vista",
  "banca": "nome_banca_se_presente",
  "tipo_documento": "Fattura/Ricevuta/Scontrino/Documento di Trasporto",
  "stato": "Pagata/Da pagare",
  "metodo_pagamento": "Contanti/POS/Carta di Credito/Bonifico/Assegno",
  "data_creazione": "YYYY-MM-DD",
  "utente_id": "user_1",
  "note": "eventuali_note_aggiuntive"
}

Per INCASSO:
{
  "tipo": "incasso",
  "data_incasso": "YYYY-MM-DD (usa oggi se non specificato)",
  "importo": numero_senza_valuta,
  "valuta": "EUR",
  "metodo_incasso": "Contanti/POS/Carta di Credito/Bonifico/Assegno",
  "data_creazione": "YYYY-MM-DD",
  "utente_id": "user_1",
  "cliente": "nome_cliente_se_presente",
  "note": "eventuali_note_aggiuntive"
}

REGOLE:
- Estrai tutti i dati possibili dal testo
- Se un campo non è presente, usa un valore predefinito logico
- Per le date usa il formato YYYY-MM-DD
- Per importi usa solo numeri (es: 123.45)
- Non aggiungere testo extra, solo il JSON
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini', // Modello più economico ed efficiente
    messages: [
      { 
        role: 'system', 
        content: 'Sei un esperto contabile che estrae dati strutturati da trascrizioni audio di documenti commerciali. Rispondi sempre e solo con JSON valido.' 
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.1, // Molto deterministico
    max_tokens: 500
  });

  const response = completion.choices[0].message.content.trim();

  try {
    console.log("🧠 Output AI grezzo:", response);

    // Pulizia della risposta per estrarre solo il JSON
    let jsonStr = response;
    if (response.includes('```json')) {
      jsonStr = response.split('```json')[1].split('```')[0];
    } else if (response.includes('```')) {
      jsonStr = response.split('```')[1].split('```')[0];
    }

    const parsed = JSON.parse(jsonStr);
    const normalized = normalizeFields(parsed);

    // Aggiungi metadati sulla qualità della trascrizione
    normalized.confidence_score = confidence;
    normalized.original_text = text;

    return normalized;
  } catch (err) {
    console.error("❌ Errore parsing JSON:", err);
    console.error("❌ Risposta AI:", response);
    throw new Error(`Parsing JSON fallito: ${err.message}`);
  }
}

/* === Validazione dati === */
function validateData(data) {
  const errors = [];

  if (!data.tipo || !['spesa', 'incasso'].includes(data.tipo)) {
    errors.push('Tipo mancante o non valido');
  }

  if (!data.importo || isNaN(data.importo) || data.importo <= 0) {
    errors.push('Importo mancante o non valido');
  }

  if (data.tipo === 'spesa' && !data.azienda) {
    errors.push('Nome azienda/fornitore mancante per la spesa');
  }

  if (data.tipo === 'spesa' && !data.numero_fattura) {
    // Genera automaticamente un numero fattura
    data.numero_fattura = `AUTO-${Date.now()}`;
  }

  return { isValid: errors.length === 0, errors, data };
}

/* === Upload Audio con gestione errori migliorata === */
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: 'File audio mancante',
        message: 'Nessun file audio ricevuto' 
      });
    }

    console.log("📁 Audio ricevuto:", {
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype
    });

    // Trascrizione
    const transcription = await transcribeAudio(req.file);
    const transcribedText = transcription.text;
    const confidence = transcription.segments ? 
      transcription.segments.reduce((acc, seg) => acc + (seg.avg_logprob || 0), 0) / transcription.segments.length : 0;

    console.log("🗣️ Testo trascritto:", transcribedText);
    console.log("📊 Confidence score:", confidence);

    if (!transcribedText || transcribedText.trim().length < 10) {
      return res.status(400).json({
        error: 'Trascrizione troppo corta o vuota',
        message: 'Il testo trascritto è troppo breve per essere processato',
        transcription: transcribedText
      });
    }

    // Estrazione dati
    const parsedData = await extractDataFromText(transcribedText, confidence);
    console.log("📦 Dati estratti:", parsedData);

    // Validazione
    const validation = validateData(parsedData);
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'Dati non validi',
        message: validation.errors.join(', '),
        data: parsedData,
        transcription: transcribedText
      });
    }

    // Salvataggio nel database
    if (parsedData.tipo === 'spesa') {
      parsedData.data_creazione = new Date().toISOString();
      await saveDocumento(parsedData);

      return res.status(200).json({
        success: true,
        message: 'Spesa salvata con successo',
        data: parsedData,
        transcription: transcribedText,
        confidence: confidence
      });

    } else if (parsedData.tipo === 'incasso') {
      await db.query(
        `INSERT INTO incomes (data_incasso, importo, valuta, metodo_incasso, data_creazione, utente_id, cliente, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          parsedData.data_incasso,
          parsedData.importo,
          parsedData.valuta,
          parsedData.metodo_incasso,
          new Date().toISOString(),
          parsedData.utente_id,
          parsedData.cliente || null,
          parsedData.note || null
        ]
      );

      return res.status(200).json({
        success: true,
        message: 'Incasso salvato con successo',
        data: parsedData,
        transcription: transcribedText,
        confidence: confidence
      });
    }

  } catch (error) {
    console.error("❌ Errore /upload-audio:", error);

    return res.status(500).json({
      success: false,
      error: 'Errore durante l\'elaborazione',
      message: error.message || 'Errore sconosciuto',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/* === API esistenti mantenute === */
app.get('/expenses', async (req, res) => {
  try {
    const spese = await getAllSpese();
    res.json(spese);
  } catch (err) {
    console.error('❌ Errore nel recupero spese:', err);
    res.status(500).json({ error: 'Errore nel recupero spese' });
  }
});

app.get('/incomes', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM incomes ORDER BY data_incasso DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Errore nel recupero incassi:', err);
    res.status(500).json({ error: 'Errore nel recupero incassi' });
  }
});

app.delete('/incomes/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const result = await db.query('DELETE FROM incomes WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Incasso non trovato' });
    }
    res.json({ message: 'Incasso eliminato', deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Errore nella cancellazione incasso:', err);
    res.status(500).json({ error: 'Errore nella cancellazione incasso' });
  }
});

app.put('/incomes/:id', async (req, res) => {
  try {
    const { data_incasso, importo, valuta, metodo_incasso, utente_id, cliente, note } = req.body;
    const result = await db.query(
      `UPDATE incomes SET 
        data_incasso = $1,
        importo = $2,
        valuta = $3,
        metodo_incasso = $4,
        utente_id = $5,
        cliente = $6,
        note = $7,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8 RETURNING *`,
      [data_incasso, importo, valuta, metodo_incasso, utente_id, cliente, note, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Incasso non trovato' });
    }

    res.json({ message: 'Incasso aggiornato con successo', updated: result.rows[0] });
  } catch (err) {
    console.error('❌ Errore nella modifica incasso:', err);
    res.status(500).json({ error: 'Errore nella modifica incasso' });
  }
});

app.post('/expenses', async (req, res) => {
  try {
    const spesaConData = {
      ...req.body,
      data_creazione: new Date().toISOString()
    };
    await saveDocumento(spesaConData);
    res.status(201).json({ message: 'Spesa salvata', data: spesaConData });
  } catch (err) {
    console.error('❌ Errore nel salvataggio spesa:', err);
    res.status(500).json({ error: 'Errore nel salvataggio' });
  }
});

app.put('/expenses/:numero_fattura', async (req, res) => {
  try {
    await updateSpesa(req.params.numero_fattura, req.body);
    res.json({ message: 'Spesa modificata' });
  } catch (err) {
    console.error('❌ Errore nella modifica spesa:', err);
    res.status(500).json({ error: 'Errore nella modifica' });
  }
});

app.delete('/expenses/:numero_fattura', async (req, res) => {
  try {
    await deleteSpesa(req.params.numero_fattura);
    res.json({ message: 'Spesa eliminata' });
  } catch (err) {
    console.error('❌ Errore nella cancellazione spesa:', err);
    res.status(500).json({ error: 'Errore nella cancellazione' });
  }
});

app.get('/stats', async (req, res) => {
  try {
    const spese = await getAllSpese();
    const totale = spese.reduce((acc, s) => acc + parseFloat(s.importo || 0), 0);
    const numero = spese.length;
    const perGiorno = spese.reduce((acc, s) => {
      const giorno = s.data_fattura || new Date().toISOString().split('T')[0];
      acc[giorno] = (acc[giorno] || 0) + parseFloat(s.importo || 0);
      return acc;
    }, {});
    const media_per_giorno = numero > 0 ? (totale / Object.keys(perGiorno).length).toFixed(2) : '0.00';

    res.json({ 
      totale: totale.toFixed(2), 
      numero, 
      media_per_giorno,
      per_giorno: perGiorno
    });
  } catch (err) {
    console.error('❌ Errore nelle statistiche spese:', err);
    res.status(500).json({ error: 'Errore nel calcolo delle statistiche' });
  }
});

app.get('/income-stats', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM incomes');
    const incassi = result.rows;

    const totale = incassi.reduce((acc, i) => acc + parseFloat(i.importo || 0), 0);
    const numero = incassi.length;

    const perGiorno = incassi.reduce((acc, i) => {
      const giorno = i.data_incasso?.toISOString?.().split('T')[0] || i.data_incasso || new Date().toISOString().split('T')[0];
      acc[giorno] = (acc[giorno] || 0) + parseFloat(i.importo || 0);
      return acc;
    }, {});

    const media_per_giorno = numero > 0 ? (totale / Object.keys(perGiorno).length).toFixed(2) : '0.00';

    res.json({ 
      totale: totale.toFixed(2), 
      numero, 
      media_per_giorno,
      per_giorno: perGiorno
    });
  } catch (err) {
    console.error('❌ Errore /income-stats:', err);
    res.status(500).json({ error: 'Errore nel calcolo delle statistiche incassi' });
  }
});

// Ultimi 3 incassi
app.get('/latest-income', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM incomes
      ORDER BY data_creazione DESC
      LIMIT 3
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Errore ultimi incassi:', err);
    res.status(500).json({ error: 'Errore nel recupero ultimi incassi' });
  }
});

// Ultime 3 spese
app.get('/latest-expenses', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM documents
      ORDER BY data_creazione DESC
      LIMIT 3
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Errore ultime spese:', err);
    res.status(500).json({ error: 'Errore nel recupero ultime spese' });
  }
});

// Endpoint per testare la trascrizione
app.post('/test-transcription', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File audio mancante' });
    }

    const transcription = await transcribeAudio(req.file);
    res.json({
      text: transcription.text,
      confidence: transcription.segments ? 
        transcription.segments.reduce((acc, seg) => acc + (seg.avg_logprob || 0), 0) / transcription.segments.length : 0,
      segments: transcription.segments || []
    });
  } catch (error) {
    console.error('❌ Errore test trascrizione:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('✅ Backend attivo e migliorato!');
});

// Middleware per gestione errori globale
app.use((error, req, res, next) => {
  console.error('❌ Errore globale:', error);
  res.status(500).json({ 
    error: 'Errore interno del server',
    message: error.message,
    timestamp: new Date().toISOString()
  });
});

export default app;