FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libtommath1 libncurses6 git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/api apps/api
COPY scripts/setup-firebird.mjs scripts/setup-firebird.mjs
ENV FIREBIRD_RUNTIME_DIR=/opt/relay-firebird
RUN node scripts/setup-firebird.mjs && npm run build -w apps/api
COPY contexts contexts
COPY skills skills
RUN mkdir -p /data/workspaces && chown -R node:node /data /app/contexts /app/skills /opt/relay-firebird
ENV NODE_ENV=production API_HOST=0.0.0.0 FIREBIRD_CLIENT_LIBRARY=/opt/relay-firebird/lib/libfbclient.so
USER node
EXPOSE 8000
CMD ["node", "apps/api/dist/server.js"]
