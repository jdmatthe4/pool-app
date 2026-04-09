# ── Stage 1: build the React app ──────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY public ./public
COPY src ./src

# Tell the React app where the API lives at runtime.
# In production both frontend and API are served from the same
# nginx container (nginx proxies /api → backend), so this is
# just a relative path and no env var is needed.
RUN npm run build

# ── Stage 2: serve with nginx ──────────────────────────────────
FROM nginx:1.25-alpine

# Remove the default nginx page
RUN rm -rf /usr/share/nginx/html/*

# Copy built React files
COPY --from=builder /app/build /usr/share/nginx/html

# Copy our nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
