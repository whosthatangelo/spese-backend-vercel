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
async function transcribeAudio(file) {
  console.log("📄 Tipo MIME ricevuto:", file?.mimetype);
  console.log("📦 Dimensione file:", file?.size);

  if (!file || !file.path || !file.mimetype || file.size === 0) {
    throw new Error("File audio non valido o vuoto.");
  }

  const fileStream = fs.createReadStream(file.path);

  const transcription = await openai.audio.transcriptions.create({
    file: fileStream, // ✅ direttamente il file stream!
    model: "whisper-1",
    response_format: "json",
    language: "it"
  });

  return transcription;
}


/* === Parsing testo in spesa === */
function parseExpenseFromText(text) {
  const [rawData, prodotto, luogo, importoRaw] = text.split(',');
  const today = new Date().toISOString().split("T")[0];
  const data = rawData?.trim() || today;
  const importo = parseFloat(importoRaw?.replace(/[^\d.]/g, '')) || 0;

  return {
    data,
    prodotto: prodotto?.trim() || 'Prodotto',
    luogo: luogo?.trim() || 'Luogo',
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

    const spesa = parseExpenseFromText(transcription.text);

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
