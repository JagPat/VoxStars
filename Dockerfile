# VOX STARS Cockpit — container image for Coolify
FROM node:20-alpine

WORKDIR /app

# Deterministic production install from the committed lockfile
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY . .

# Production mode: the server refuses to start without a strong COACH_PIN,
# so set COACH_PIN in the deployment environment before deploying.
ENV NODE_ENV=production
# Shared data lives on a persistent volume mounted at /data (set in Coolify)
ENV DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000
VOLUME ["/data"]

# Simple container healthcheck (Coolify also uses /api/health).
# /api/health returns 503 when the state file is corrupt, so a degraded
# store surfaces as an unhealthy container instead of silent data loss.
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
