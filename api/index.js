// api/index.js
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getAllSpese, addSpesa, updateSpesa, deleteSpesa } from '../db.js';

const app = express();

// Config per path serverless
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ dest: path.join(__dirname, '../uploads') });

app.use(cors());
app.use(express.json());

/* === Simulazione trascrizione vocale === */
async function transcribeAudio(filePath) {
  console.log("🧠 Simulazione trascrizione audio da:", filePath);
  return "12 giugno, pizza, Milano, 11 euro";
}

/* === Parser semplice del testo === */
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
    audio_url: '' // Potresti salvarlo se vuoi
  };
}

/* === REST API classiche === */
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

import multer from 'multer';

const upload = multer({ dest: '/tmp' }); // Percorso compatibile con Vercel

app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    // Simulazione trascrizione
    const testo = "12 giugno, pizza, Milano, 11 euro";
    const [rawData, prodotto, luogo, importoRaw] = testo.split(',');

    const today = new Date().toISOString().split("T")[0];
    const data = rawData?.trim() || today;
    const importo = parseFloat(importoRaw?.replace(/[^\d.]/g, '')) || 0;

    const spesa = {
      data,
      prodotto: prodotto?.trim() || 'Prodotto',
      luogo: luogo?.trim() || 'Luogo',
      importo,
      quantita: null,
      unita_misura: null,
      audio_url: ''
    };

    await addSpesa(spesa);
    res.json(spesa);
  } catch (error) {
    console.error("❌ Errore /upload-audio:", error);
    res.status(500).json({ error: 'Errore nel salvataggio della spesa' });
  }
});


// ✅ Nessun app.listen() qui! Questo è serverless.
export default app;
