// server.js
import app from './api/index.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server avviato su http://0.0.0.0:${PORT}`);
});