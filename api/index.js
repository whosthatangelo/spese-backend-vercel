// api/index.js
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getAllSpese, addSpesa, updateSpesa, deleteSpesa } from '../db.js';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
dotenv.config();

// ✅ OpenAI
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
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

async function transcribeAudio(file) {
  console.log("📄 Tipo MIME ricevuto:", file?.mimetype);
  console.log("📦 Dimensione file:", file?.size);

  if (!file || !file.path || !file.mimetype || file.size === 0) {
    throw new Error("File audio non valido o vuoto.");
  }

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
        reject(new Error(`❌ FFmpeg process exited with code ${code}`));
      }
    });
  });

  return await openai.audio.transcriptions.create({
    file: fs.createReadStream(outputPath),
    model: "whisper-1",
    response_format: "json",
    language: "it"
  });
}


/* === Parsing testo in spesa === */
function parseExpenseFromText(text) {
  console.log("📜 Testo ricevuto per parsing:", text);
  const today = new Date().toISOString().split("T")[0];

  const lower = text.toLowerCase();
  const regex = /(\d{1,2} [a-z]+)?\s*([a-zàèéìòù]+)?\s*([a-zàèéìòù]+)?\s*(\d+(?:[.,]\d+)?)/i;
  const match = lower.match(regex);

  const data = match?.[1]?.trim() || today;
  const prodotto = match?.[2]?.trim() || 'Prodotto';
  const luogo = match?.[3]?.trim() || 'Luogo';
  const importo = parseFloat(match?.[4]?.replace(',', '.')) || 0;

  return {
    data,
    prodotto,
    luogo,
    importo,
    quantita: null,
    unita_misura: null,
    audio_url: ''
  };
}


/* === Upload Audio === */
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    console.log('📁 File salvato in:', req.file?.path);
    console.log('📄 Tipo MIME ricevuto:', req.file?.mimetype);
    console.log('📦 Dimensione:', req.file?.size);
    console.log("🛠️ File passato a transcribeAudio:", req.file?.originalname, req.file?.mimetype, req.file?.size);

    if (!req.file || !req.file.mimetype || req.file.size === 0) {
      console.error("❌ File audio mancante o non valido:", req.file);
      return res.status(400).json({ error: 'File audio mancante o non valido.' });
    }

    const transcription = await transcribeAudio(req.file);
    console.log("🗣️ Testo trascritto:", transcription.text); // 👈 AGGIUNGI QUESTO

    const spesa = parseExpenseFromText(transcription.text);
    console.log("🧾 Spesa generata:", spesa);

    await addSpesa(spesa);
    res.json(spesa);
  } catch (error) {
    console.error("❌ Errore /upload-audio:", error);
    res.status(500).json({ error: 'Errore nel salvataggio della spesa' });
  }
});

/* === API Spese === */
app.get('/expenses', async (req, res) => {
  const spese = await getAllSpese();
  res.json(spese);
});

app.post('/expenses', async (req, res) => {
  try {
    const nuovaSpesa = req.body;
    await addSpesa(nuovaSpesa);
    res.status(201).json({ message: 'Spesa salvata' });
  } catch (err) {
    console.error("❌ Errore nel salvataggio:", err);
    res.status(500).json({ error: "Errore nel salvataggio della spesa" });
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

// ✅ Nessun app.listen()
export default app;

app.get('/', (req, res) => {
  res.send('✅ Backend attivo!');
});
