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
app.post('/login', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email richiesta' });
  }

  try {
    const result = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (result.rows.length > 0) {
      return res.json({ userId: result.rows[0].id });
    }

    const insert = await db.query('INSERT INTO users (email) VALUES ($1) RETURNING id', [email]);
    return res.json({ userId: insert.rows[0].id });
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

Estrai in formato JSON i seguenti campi con valori più coerenti possibile:
- numero_fattura
- data_fattura (formato YYYY-MM-DD)
- importo (solo il numero in euro)
- valuta (EUR)
- azienda (es: città o luogo citato)
- tipo_pagamento (es: contanti, carta, bonifico)
- banca (se presente)
- tipo_documento (es: fattura, ricevuta)
- stato (lasciare stringa vuota se non presente)
- metodo_pagamento (stesso di tipo_pagamento se non distinto)
- data_creazione (usa la data di oggi in formato YYYY-MM-DD)
- utente_id (user_1)

Rispondi solo con il JSON richiesto.
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'Sei un assistente che estrae dati da testi parlati trascritti.' },
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
    console.log("🧾 Dati estratti:", parsedData);

    await saveDocumento(parsedData);

    return res.status(200).json({
      message: 'Spesa vocale salvata con successo',
      spesa: parsedData
    });
  } catch (error) {
    console.error("❌ Errore /upload-audio:", error);
    return res.status(200).json({
      message: 'Errore durante il salvataggio della spesa',
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

app.post('/expenses', async (req, res) => {
  try {
    await saveDocumento(req.body);
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

app.get('/', (req, res) => {
  res.send('✅ Backend attivo!');
});

export default app;
