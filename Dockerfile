# syntax=docker/dockerfile:1.7
# Production Dockerfile for the Orbi Mail backend (Railway / generic container host).
# Builds shared + backend, applies prisma migrations at runtime startup.

FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

# ---------- Dependencies layer ----------
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/shared/package.json packages/shared/
COPY packages/frontend/package.json packages/frontend/
COPY packages/electron/package.json packages/electron/
COPY packages/ios/package.json packages/ios/
COPY prisma ./prisma
RUN npm ci --include=dev

# ---------- Build layer ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/backend packages/backend
RUN npx prisma generate --schema=prisma/schema.prisma
RUN npm run build -w packages/shared
RUN npm run build -w packages/backend

# ---------- Runtime layer ----------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/backend/dist packages/backend/dist
COPY --from=build /app/packages/backend/package.json packages/backend/package.json

EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy --schema=prisma/schema.prisma && node packages/backend/dist/index.js"]
