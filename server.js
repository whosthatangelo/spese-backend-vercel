import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { getAllSpese, addSpesa, updateSpesa, deleteSpesa } from './db.js';

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

/* === Config Upload === */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ dest: 'uploads/' });

/* === Simulazione trascrizione vocale === */
async function transcribeAudio(filePath) {
  console.log("🧠 Simulazione trascrizione audio da:", filePath);
  // Qui potresti usare OpenAI Whisper in futuro
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

/* === Endpoint Upload Audio === */
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    const filePath = path.join(__dirname, req.file.path);
    const testo = await transcribeAudio(filePath);
    const spesa = parseExpenseFromText(testo);

    await addSpesa(spesa);
    res.json(spesa);
  } catch (err) {
    console.error("❌ Errore /upload-audio:", err);
    res.status(500).json({ error: "Errore durante l’elaborazione audio" });
  }
});

/* === REST API classiche === */

// ✅ GET tutte le spese
app.get('/expenses', async (req, res) => {
  const spese = await getAllSpese();
  res.json(spese);
});

// ➕ POST nuova spesa
app.post('/expenses', async (req, res) => {
  try {
    const nuovaSpesa = req.body;
    console.log("📥 POST ricevuto:", nuovaSpesa);
    await addSpesa(nuovaSpesa);
    res.status(201).json({ message: 'Spesa salvata' });
  } catch (err) {
    console.error("❌ Errore nel salvataggio:", err);
    res.status(500).json({ error: "Errore nel salvataggio della spesa" });
  }
});

// ✏️ PUT modifica spesa
app.put('/expenses/:id', async (req, res) => {
  const id = req.params.id;
  const datiModificati = req.body;
  await updateSpesa(id, datiModificati);
  res.json({ message: 'Spesa modificata' });
});

// 🗑️ DELETE elimina spesa
app.delete('/expenses/:id', async (req, res) => {
  const id = req.params.id;
  await deleteSpesa(id);
  res.json({ message: 'Spesa eliminata' });
});

// 📊 GET statistiche
app.get('/stats', async (req, res) => {
  const spese = await getAllSpese();

  const totale = spese.reduce((acc, s) => acc + parseFloat(s.importo || 0), 0);
  const numero = spese.length;

  const spesePerGiorno = spese.reduce((acc, s) => {
    acc[s.data] = (acc[s.data] || 0) + parseFloat(s.importo || 0);
    return acc;
  }, {});

  const media_per_giorno = (totale / Object.keys(spesePerGiorno).length).toFixed(2);

  const prodotti = {};
  spese.forEach(s => {
    prodotti[s.prodotto] = (prodotti[s.prodotto] || 0) + 1;
  });

  const top_prodotto = Object.entries(prodotti).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

  res.json({
    totale: totale.toFixed(2),
    numero,
    media_per_giorno,
    top_prodotto
  });
});

// 🚀 Avvio server
app.listen(PORT, () => {
  console.log(`✅ Backend attivo su http://localhost:${PORT}`);
});
