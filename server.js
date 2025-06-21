import app from './api/index.js';
import fs from 'fs';

console.log('🔁 Server init...');

const PORT = process.env.PORT || 3000;

try {
  // test dummy: file presente?
  if (!fs.existsSync('./db.js')) {
    console.error('❌ db.js non trovato!');
  }

  app.listen(PORT, () => {
    console.log(`🚀 Server avviato su http://localhost:${PORT}`);
  });
} catch (err) {
  console.error('❌ Errore nel lancio del server:', err);
}
