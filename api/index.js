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

// ===== VERSIONE MIGLIORATA DI normalizeFields =====

function normalizeFields(data) {
  const normalize = (value) => value?.toLowerCase()?.trim().replace(/\s+/g, ' ');
  const isValidDate = (str) => /^\d{4}-\d{2}-\d{2}$/.test(str);

  // 🧠 Sistema di parsing date molto più intelligente
  const parseNaturalDate = (value) => {
    if (!value) return null;

    const today = new Date();
    const normalized = normalize(value);

    // Date relative
    const relativePatterns = {
      'oggi': 0,
      'ieri': -1,
      'domani': 1,
      'dopodomani': 2,
      'l\'altro ieri': -2,
      'altroieri': -2
    };

    if (relativePatterns.hasOwnProperty(normalized)) {
      const d = new Date(today);
      d.setDate(today.getDate() + relativePatterns[normalized]);
      return d.toISOString().split("T")[0];
    }

    // Giorni della settimana
    const weekDays = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
    const dayIndex = weekDays.indexOf(normalized);
    if (dayIndex !== -1) {
      const targetDay = new Date(today);
      const todayIndex = today.getDay();
      let daysToAdd = dayIndex - todayIndex;

      // Se il giorno è già passato questa settimana, assumiamo la settimana prossima
      if (daysToAdd <= 0) daysToAdd += 7;

      targetDay.setDate(today.getDate() + daysToAdd);
      return targetDay.toISOString().split("T")[0];
    }

    // Formati data italiani
    const italianDatePatterns = [
      /^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/,  // gg/mm/yyyy
      /^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/,  // gg/mm/yy
      /^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/   // yyyy/mm/gg
    ];

    for (const pattern of italianDatePatterns) {
      const match = value.match(pattern);
      if (match) {
        let [, first, second, third] = match;
        let year, month, day;

        if (pattern === italianDatePatterns[2]) {
          // yyyy/mm/gg
          year = parseInt(first);
          month = parseInt(second);
          day = parseInt(third);
        } else {
          // gg/mm/yyyy o gg/mm/yy
          day = parseInt(first);
          month = parseInt(second);
          year = parseInt(third);
          if (year < 100) year += 2000; // Converte yy in yyyy
        }

        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
        }
      }
    }

    return value;
  };

  // 💰 Mapping più completo per metodi di pagamento
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

  // 📄 Mapping documenti più dettagliato
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

  // 💳 Mapping tipologie di pagamento
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

  // 🏢 Normalizzazione nome azienda
  const normalizeCompanyName = (name) => {
    if (!name) return name;

    // Rimuove articoli comuni e normalizza
    const cleaned = name
      .replace(/^(la |il |lo |le |gli |l'|un |una |uno )/i, '')
      .replace(/\b(s\.r\.l|srl|s\.p\.a|spa|s\.n\.c|snc|s\.a\.s|sas|s\.s|ss)\b/gi, match => match.toUpperCase())
      .trim();

    // Capitalizza prima lettera di ogni parola
    return cleaned.replace(/\b\w/g, l => l.toUpperCase());
  };

  // 💶 Normalizzazione importo
  const normalizeAmount = (amount) => {
    if (typeof amount === 'number') return amount;
    if (!amount) return 0;

    const cleaned = amount.toString()
      .replace(/[^\d,.-]/g, '') // Rimuove tutto tranne numeri, virgole, punti, trattini
      .replace(/,/g, '.'); // Converte virgole in punti

    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : Math.abs(parsed); // Sempre positivo
  };

  // Applica tutte le normalizzazioni
  try {
    // Normalizza metodi di pagamento
    if (data.metodo_pagamento) {
      data.metodo_pagamento = metodoPagamentoMap[normalize(data.metodo_pagamento)] || 
                              data.metodo_pagamento;
    }

    if (data.metodo_incasso) {
      data.metodo_incasso = metodoPagamentoMap[normalize(data.metodo_incasso)] || 
                            data.metodo_incasso;
    }

    // Normalizza tipo documento
    if (data.tipo_documento) {
      data.tipo_documento = tipoDocumentoMap[normalize(data.tipo_documento)] || 
                            data.tipo_documento;
    }

    // Normalizza tipo pagamento
    if (data.tipo_pagamento) {
      data.tipo_pagamento = tipoPagamentoMap[normalize(data.tipo_pagamento)] || 
                            data.tipo_pagamento;
    }

    // Normalizza nome azienda
    if (data.azienda) {
      data.azienda = normalizeCompanyName(data.azienda);
    }

    // Normalizza importo
    if (data.importo) {
      data.importo = normalizeAmount(data.importo);
    }

    // Normalizza date
    ['data_fattura', 'data_incasso', 'data_creazione'].forEach(field => {
      if (data[field]) {
        const parsedDate = parseNaturalDate(data[field]);

        if (parsedDate && parsedDate !== "non disponibile") {
          if (isValidDate(parsedDate)) {
            data[field] = parsedDate;
          } else if (field === 'data_creazione') {
            // Fallback per data_creazione
            data[field] = new Date().toISOString().split("T")[0];
          } else {
            data[field] = "non disponibile";
          }
        }
      }
    });

    // Valida e normalizza valuta
    if (data.valuta) {
      const validCurrencies = ['EUR', 'USD', 'GBP', 'CHF'];
      const normalized = data.valuta.toUpperCase();
      data.valuta = validCurrencies.includes(normalized) ? normalized : 'EUR';
    }

    return data;

  } catch (error) {
    console.error('❌ Errore durante normalizzazione:', error);
    throw new Error(`Errore normalizzazione: ${error.message}`);
  }
}

// ===== VERSIONE MIGLIORATA DI extractDataFromText =====

async function extractDataFromText(text, retryCount = 0) {
  const maxRetries = 2;

  // 🧹 Pre-processing del testo
  const cleanText = text
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  // 🔍 Rilevamento intelligente del tipo (spesa vs incasso)
  const detectType = (text) => {
    const incomeKeywords = ['incasso', 'ricevuto', 'introito', 'guadagno', 'entrata', 'vendita', 'fatturato'];
    const expenseKeywords = ['spesa', 'pagato', 'acquistato', 'comprato', 'fattura', 'costo', 'bolletta'];

    const lowerText = text.toLowerCase();
    const incomeScore = incomeKeywords.reduce((acc, word) => acc + (lowerText.includes(word) ? 1 : 0), 0);
    const expenseScore = expenseKeywords.reduce((acc, word) => acc + (lowerText.includes(word) ? 1 : 0), 0);

    return incomeScore > expenseScore ? 'incasso' : 'spesa';
  };

  const detectedType = detectType(cleanText);

  // 🎯 Prompt molto più dettagliato e specifico
  const prompt = `
Analizza questo testo trascritto da audio e estrai i dati in formato JSON.

TESTO: "${text}"

TIPO RILEVATO: ${detectedType}

ISTRUZIONI SPECIFICHE:
1. Determina se è una SPESA o un INCASSO basandoti sul contesto
2. Se menzioni "ho pagato", "ho speso", "fattura", "bolletta" → SPESA
3. Se menzioni "ho ricevuto", "incasso", "vendita", "guadagno" → INCASSO
4. Estrai SOLO i dati menzionati nel testo, usa "non disponibile" per quelli mancanti
5. Per le date, riconosci formati italiani e parole come "oggi", "ieri", "lunedì", ecc.
6. Per gli importi, riconosci formati italiani con virgole (es: "12,50")
7. Identifica automaticamente metodi di pagamento comuni

SCHEMA SPESA:
{
  "tipo": "spesa",
  "numero_fattura": "string o non disponibile",
  "data_fattura": "YYYY-MM-DD o non disponibile",
  "importo": numero,
  "valuta": "EUR",
  "azienda": "string o non disponibile",
  "tipo_pagamento": "string o non disponibile",
  "banca": "string o non disponibile", 
  "tipo_documento": "string o non disponibile",
  "stato": "string o non disponibile",
  "metodo_pagamento": "string o non disponibile",
  "data_creazione": "YYYY-MM-DD",
  "utente_id": "user_1"
}

SCHEMA INCASSO:
{
  "tipo": "incasso",
  "data_incasso": "YYYY-MM-DD o non disponibile",
  "importo": numero,
  "valuta": "EUR",
  "metodo_incasso": "string o non disponibile",
  "data_creazione": "YYYY-MM-DD",
  "utente_id": "user_1"
}

ESEMPI PRATICI:
- "Ho pagato 50 euro oggi alla Coop con bancomat" → spesa, importo=50, azienda="Coop", metodo_pagamento="POS"
- "Ricevuto 1200 euro da cliente ieri" → incasso, importo=1200, data_incasso="ieri"
- "Fattura 123 di 150,50 euro pagata con carta" → spesa, numero_fattura="123", importo=150.50

RISPONDI SOLO CON IL JSON VALIDO. NESSUN TESTO AGGIUNTIVO.
  `;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o', // Modello più recente e potente
      messages: [
        { 
          role: 'system', 
          content: 'Sei un esperto contabile che estrae dati finanziari da testi trascritti. Rispondi sempre con JSON valido.' 
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1, // Più deterministico
      max_tokens: 500,
      response_format: { type: "json_object" } // Forza risposta JSON
    });

    const response = completion.choices[0].message.content;
    console.log("🧠 Output AI:", response);

    // 🔧 Parsing con gestione errori migliorata
    let parsedData;
    try {
      parsedData = JSON.parse(response);
    } catch (jsonError) {
      console.error("❌ Errore JSON:", jsonError);

      // Tenta di pulire e ri-parsare
      const cleanedResponse = response
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .replace(/^\s*[\r\n]/, '')
        .replace(/[\r\n]\s*$/, '');

      parsedData = JSON.parse(cleanedResponse);
    }

    // 🔍 Validazione dei dati estratti
    const validateData = (data) => {
      if (!data.tipo || !['spesa', 'incasso'].includes(data.tipo)) {
        throw new Error('Tipo non valido o mancante');
      }

      if (!data.importo || typeof data.importo !== 'number' || data.importo <= 0) {
        throw new Error('Importo non valido o mancante');
      }

      // Imposta valori di default se mancanti
      data.valuta = data.valuta || 'EUR';
      data.utente_id = data.utente_id || 'user_1';
      data.data_creazione = data.data_creazione || new Date().toISOString().split('T')[0];

      return data;
    };

    const validatedData = validateData(parsedData);

    // 🎯 Applica normalizzazione
    const normalizedData = normalizeFields(validatedData);

    console.log("✅ Dati finali:", normalizedData);
    return normalizedData;

  } catch (error) {
    console.error(`❌ Errore tentativo ${retryCount + 1}:`, error.message);

    // 🔄 Retry con prompt semplificato
    if (retryCount < maxRetries) {
      console.log(`🔄 Ritentativo ${retryCount + 1}/${maxRetries}...`);

      const simplifiedPrompt = `
Estrai dati da: "${text}"
Rispondi con JSON valido:
${detectedType === 'spesa' ? `
{"tipo":"spesa","importo":0,"valuta":"EUR","azienda":"non disponibile","data_fattura":"non disponibile","metodo_pagamento":"non disponibile","utente_id":"user_1"}
` : `
{"tipo":"incasso","importo":0,"valuta":"EUR","data_incasso":"non disponibile","metodo_incasso":"non disponibile","utente_id":"user_1"}
`}
      `;

      return await extractDataFromText(simplifiedPrompt, retryCount + 1);
    }

    // 🚨 Fallback finale con dati minimal
    console.log("🚨 Fallback ai dati minimal");
    return {
      tipo: detectedType,
      importo: 0,
      valuta: 'EUR',
      data_creazione: new Date().toISOString().split('T')[0],
      utente_id: 'user_1',
      ...(detectedType === 'spesa' 
        ? { azienda: 'non disponibile', metodo_pagamento: 'non disponibile' }
        : { metodo_incasso: 'non disponibile' }
      )
    };
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
