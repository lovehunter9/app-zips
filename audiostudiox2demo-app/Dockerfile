# Audio Studio X2 Demo — single image (SPA build + Node server + ffmpeg)
FROM node:20-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:20-bookworm-slim AS server
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./
COPY --from=web /web/dist ./web/dist
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.js"]
