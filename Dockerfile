# Usa un'immagine base Node.js
FROM node:18

# Crea la cartella app
WORKDIR /app

# Copia tutto il contenuto
COPY . .

# Installa le dipendenze
RUN npm ci

# Esponi la porta su cui ascolta Express
EXPOSE 8080

# Avvia l'app
CMD ["npm", "run", "start"]
