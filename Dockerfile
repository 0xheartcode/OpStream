# OpStream — Production Dockerfile
#
# Build context: Opnet-devs/ parent directory (one level up from OpStream/)
#
# Build manually:
#   docker build -f OpStream/Dockerfile -t opstream ..
#
# docker-compose.yml sets the context automatically — use that instead.
#
# Two-stage build: better-sqlite3 is a native addon that requires build tools.
# We compile it in the builder stage and copy only the output to the slim runtime.

# ── Stage 1: build (has compiler toolchain) ──────────────────────────────────
FROM node:24-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies (compiles better-sqlite3 native addon here)
COPY OpStream/package*.json ./
RUN npm install --prefer-offline

# ── Stage 2: runtime (no build tools — slimmer image) ────────────────────────
FROM node:24-alpine AS runtime

# dumb-init: proper PID 1 signal handling (SIGTERM → clean shutdown)
RUN apk add --no-cache dumb-init

WORKDIR /app

# Bring in compiled node_modules from the builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Copy source
COPY OpStream/src/        ./src/
COPY OpStream/tsconfig.json ./

# Create persistent directories (overridden by volume mounts at runtime)
RUN mkdir -p /app/data /app/logs

# Drop root — run as unprivileged user
RUN addgroup -g 1001 -S opstream && \
    adduser  -u 1001 -S opstream -G opstream && \
    chown -R opstream:opstream /app
USER opstream

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "src/main.ts", "start"]
