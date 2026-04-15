FROM node:20-alpine

# better-sqlite3 needs build tools for native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY server.js ./

# Create data directory for SQLite database
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
