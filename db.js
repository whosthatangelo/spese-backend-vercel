import { readFile, writeFile } from 'fs/promises';

const FILE_PATH = './spese.json';

// 🔄 Legge le spese
export async function getAllSpese() {
  try {
    const data = await readFile(FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// ➕ Aggiunge una spesa
export async function addSpesa(spesa) {
  const spese = await getAllSpese();
  spese.push({ id: Date.now(), ...spesa });
  await writeFile(FILE_PATH, JSON.stringify(spese, null, 2));
}

// ✏️ Modifica una spesa
export async function updateSpesa(id, nuovaSpesa) {
  let spese = await getAllSpese();
  spese = spese.map(s => s.id == id ? { ...s, ...nuovaSpesa } : s);
  await writeFile(FILE_PATH, JSON.stringify(spese, null, 2));
}

// 🗑️ Cancella una spesa
export async function deleteSpesa(id) {
  let spese = await getAllSpese();
  spese = spese.filter(s => s.id != id);
  await writeFile(FILE_PATH, JSON.stringify(spese, null, 2));
}
