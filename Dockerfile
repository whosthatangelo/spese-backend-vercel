# Usa una immagine Node ufficiale
FROM FROM node:20

# Imposta la cartella di lavoro
WORKDIR /app

# Copia tutti i file nel container
COPY . .

# Installa le dipendenze
RUN npm install

# Espone la porta 8080
EXPOSE 8080

# Avvia l'app
CMD ["npm", "run", "start"]
