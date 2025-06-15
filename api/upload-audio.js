import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { addSpesa } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ dest: '/tmp' });

export const config = {
  api: {
    bodyParser: false
  }
};

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  upload.single('audio')(req, res, async err => {
    if (err) {
      console.error('Errore Multer:', err);
      return res.status(500).json({ error: 'Errore nel caricamento audio' });
    }

    // Simulazione trascrizione (puoi sostituire con Whisper)
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

    try {
      await addSpesa(spesa);
      res.json(spesa);
    } catch (error) {
      console.error("❌ Errore nel salvataggio:", error);
      res.status(500).json({ error: 'Errore nel salvataggio della spesa' });
    }
  });
}
