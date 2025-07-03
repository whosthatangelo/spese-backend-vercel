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

/* === LOGIN UTENTE === */
/* === LOGIN UTENTE SOLO SE GIÀ ESISTENTE === */
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

/* === Parsing con OpenAI === */
async function extractDataFromText(text) {
  const prompt = `
  Hai ricevuto questo testo trascritto da un file audio:

  "${text}"

  Devi capire con certezza se si tratta di una **spesa** (es: fattura, pagamento, acquisto) oppure di un **incasso** (es: incasso giornaliero, entrata di cassa, somma ricevuta).

  🔹 Se è una **spesa**, l'utente sta comunicando una fattura o pagamento effettuato. In tal caso, restituisci solo un oggetto JSON con questi campi:
  {
    tipo: "spesa",
    numero_fattura: "...",
    data_fattura: "YYYY-MM-DD",
    importo: ...,
    valuta: "EUR",
    azienda: "...",
    tipo_pagamento: "...",
    banca: "...",
    tipo_documento: "...",
    stato: "",
    metodo_pagamento: "...",
    data_creazione: "YYYY-MM-DD",
    utente_id: "user_1"
  }

  🔹 Se è un **incasso**, l'utente sta dichiarando un'entrata economica (es: "incasso del giorno", "ricevuto pagamento", "entrata giornaliera"). In tal caso, restituisci solo un oggetto JSON con questi campi:
  {
    tipo: "incasso",
    data_incasso: "YYYY-MM-DD",
    importo: ...,
    valuta: "EUR",
    metodo_incasso: "...",
    data_creazione: "YYYY-MM-DD",
    utente_id: "user_1"
  }

  ⚠️ ATTENZIONE: 
  - Rispondi **esclusivamente** con un singolo oggetto JSON valido, senza testo extra.
  - Se hai anche il minimo dubbio, preferisci la classificazione come "spesa".
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
    return JSON.parse(response);
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
        parsedData.data_creazione = new Date().toISOString();  // ✅ Imposta timestamp reale
        await saveDocumento(parsedData);
        return res.status(200).json({
          message: 'Spesa salvata con successo',
          spesa: parsedData
        });
      } else if (parsedData.tipo === 'incasso') {
        await db.query(
          `INSERT INTO incomes (data_incasso, importo, valuta, metodo_incasso, data_creazione, utente_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            parsedData.data_incasso,
            parsedData.importo,
            parsedData.valuta,
            parsedData.metodo_incasso,
            new Date().toISOString(),
            parsedData.utente_id
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
  const spese = await getAllSpese();
  res.json(spese);
});

/* === API incassi === */
app.get('/incomes', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM incomes ORDER BY data_incasso DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Errore nel recupero incassi:', err);
    res.status(500).json({ error: 'Errore nel recupero incassi' });
  }
});

// 🗑️ Elimina un incasso
app.delete('/incomes/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await db.query('DELETE FROM incomes WHERE id = $1', [id]);
    res.json({ message: 'Incasso eliminato' });
  } catch (err) {
    console.error('❌ Errore nella cancellazione incasso:', err);
    res.status(500).json({ error: 'Errore nella cancellazione incasso' });
  }
});

// ✏️ Modifica un incasso
app.put('/incomes/:id', async (req, res) => {
  try {
    const { data_incasso, importo, valuta, metodo_incasso, utente_id } = req.body;
    await db.query(
      `UPDATE incomes SET 
        data_incasso = $1,
        importo = $2,
        valuta = $3,
        metodo_incasso = $4,
        utente_id = $5
      WHERE id = $6`,
      [data_incasso, importo, valuta, metodo_incasso, utente_id, req.params.id]
    );
    res.json({ message: 'Incasso aggiornato con successo' });
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
    res.status(201).json({ message: 'Spesa salvata' });
  } catch (err) {
    res.status(500).json({ error: 'Errore nel salvataggio' });
  }
});


app.put('/expenses/:numero_fattura', async (req, res) => {
  try {
    await updateSpesa(req.params.numero_fattura, req.body);
    res.json({ message: 'Spesa modificata' });
  } catch (err) {
    res.status(500).json({ error: 'Errore nella modifica' });
  }
});

app.delete('/expenses/:numero_fattura', async (req, res) => {
  try {
    await deleteSpesa(req.params.numero_fattura);
    res.json({ message: 'Spesa eliminata' });
  } catch (err) {
    res.status(500).json({ error: 'Errore nella cancellazione' });
  }
});

app.get('/stats', async (req, res) => {
  const spese = await getAllSpese();
  const totale = spese.reduce((acc, s) => acc + parseFloat(s.importo || 0), 0);
  const numero = spese.length;
  const perGiorno = spese.reduce((acc, s) => {
    acc[s.data_fattura] = (acc[s.data_fattura] || 0) + parseFloat(s.importo || 0);
    return acc;
  }, {});
  const media_per_giorno = (totale / Object.keys(perGiorno).length).toFixed(2);
  res.json({ totale: totale.toFixed(2), numero, media_per_giorno });
});

app.get('/income-stats', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM incomes');
    const incassi = result.rows;

    const totale = incassi.reduce((acc, i) => acc + parseFloat(i.importo || 0), 0);
    const numero = incassi.length;

    const perGiorno = incassi.reduce((acc, i) => {
      const giorno = i.data_incasso?.toISOString?.().split('T')[0] || i.data_incasso;
      acc[giorno] = (acc[giorno] || 0) + parseFloat(i.importo || 0);
      return acc;
    }, {});

    const media_per_giorno = (totale / Object.keys(perGiorno).length || 1).toFixed(2);

    res.json({ totale: totale.toFixed(2), numero, media_per_giorno });
  } catch (err) {
    console.error('❌ Errore /income-stats:', err);
    res.status(500).json({ error: 'Errore nel calcolo delle statistiche incassi' });
  }
});

app.get('/', (req, res) => {
  res.send('✅ Backend attivo!');
});


// Ultimi 3 incassi
app.get('/latest-income', async (req, res) => {
  const result = await db.query(`
    SELECT * FROM incomes
    ORDER BY data_creazione DESC
    LIMIT 3
  `);
  res.json(result.rows);
});

// Ultime 3 spese
app.get('/latest-expenses', async (req, res) => {
  const result = await db.query(`
    SELECT * FROM documents
    ORDER BY data_creazione DESC
    LIMIT 3
  `);
  res.json(result.rows);
});


export default app;
