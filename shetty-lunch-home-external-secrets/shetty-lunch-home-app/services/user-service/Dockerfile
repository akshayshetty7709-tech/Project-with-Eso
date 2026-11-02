# ---- stage 1: install production dependencies ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# Uses the lockfile when present (reproducible, recommended). Falls back to npm install
# so the project still builds before you have generated package-lock.json.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi

# ---- stage 2: runtime image ----
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json server.js ./
# the official node image ships a non-root user "node" (uid 1000)
USER node
CMD ["node", "server.js"]
