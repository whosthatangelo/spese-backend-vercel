// server.js
import app from './api/index.js';

const PORT = process.env.PORT || 8080;

console.log("🔁 Server init...");

app.listen(PORT, () => {
  console.log(`🚀 Server avviato su http://localhost:${PORT}`);
});
