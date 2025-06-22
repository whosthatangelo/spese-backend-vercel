// api/index.js
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
  addSpesa,
  updateSpesa,
  deleteSpesa,
  saveDocumento,
} from '../db.js';

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
      return res.status(400).json({ error: 'File audio mancante o non valido.' });
    }

    console.log("📁 Audio ricevuto:", req.file.originalname);
    const transcription = await transcribeAudio(req.file);
    console.log("🗣️ Testo trascritto:", transcription.text);

    const parsedData = await extractDataFromText(transcription.text);
    console.log("🧾 Dati estratti:", parsedData);

    await saveDocumento(parsedData);
    res.json(parsedData);
  } catch (error) {
    console.error("❌ Errore /upload-audio:", error);
    res.status(500).json({ error: 'Errore nel salvataggio della spesa' });
  }
});

/* === API legacy JSON === */
app.get('/expenses', async (req, res) => {
  const spese = await getAllSpese();
  res.json(spese);
});

app.post('/expenses', async (req, res) => {
  try {
    await addSpesa(req.body);
    res.status(201).json({ message: 'Spesa salvata' });
  } catch (err) {
    res.status(500).json({ error: 'Errore nel salvataggio' });
  }
});

app.put('/expenses/:id', async (req, res) => {
  await updateSpesa(req.params.id, req.body);
  res.json({ message: 'Spesa modificata' });
});

app.delete('/expenses/:id', async (req, res) => {
  await deleteSpesa(req.params.id);
  res.json({ message: 'Spesa eliminata' });
});

app.get('/stats', async (req, res) => {
  const spese = await getAllSpese();
  const totale = spese.reduce((acc, s) => acc + parseFloat(s.importo || 0), 0);
  const numero = spese.length;
  const perGiorno = spese.reduce((acc, s) => {
    acc[s.data] = (acc[s.data] || 0) + parseFloat(s.importo || 0);
    return acc;
  }, {});
  const media_per_giorno = (totale / Object.keys(perGiorno).length).toFixed(2);
  const prodotti = {};
  spese.forEach(s => prodotti[s.prodotto] = (prodotti[s.prodotto] || 0) + 1);
  const top_prodotto = Object.entries(prodotti).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';
  res.json({ totale: totale.toFixed(2), numero, media_per_giorno, top_prodotto });
});

app.get('/', (req, res) => {
  res.send('✅ Backend attivo!');
});

export default app;
