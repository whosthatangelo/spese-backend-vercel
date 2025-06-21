// server.js
import app from './api/index.js';

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`🚀 Server avviato su http://0.0.0.0:${PORT}`);
});
