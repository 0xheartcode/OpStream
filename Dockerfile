# OpStream — Production Dockerfile
#
# Self-contained: builds directly from the OpStream/ repo root.
# No parent directory context needed.
#
# Build manually:
#   docker build -t opstream .
#
# Two-stage build: better-sqlite3 is a native addon that requires build tools.
# We compile it in the builder stage and copy only the output to the siim runtime.

# Stage 1: build (has compiler toolchain)
FROM node:24-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies (compiles better-sqlite3 native addon here)
COPY package*.json ./
RUN npm install --prefer-offline

# Stage 2: runtime (no build tools — slimmer image)
FROM node:24-alpine AS runtime

# dumb-init: proper PID 1 signal handling (SIGTERM clean shutdown)
RUN apk add --no-cache dumb-init

WORKDIR /app

# Bring in compiled node_modules from the builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

COPY src/        ./src/
COPY tsconfig.json ./

# Create persistent directories (overridden by volume mounts at runtime)
RUN mkdir -p /app/data /app/logs

# Drop root — run as unprivileged user
RUN addgroup -g 1001 -S opstream && \
    adduser  -u 1001 -S opstream -G opstream && \
    chown -R opstream:opstream /app
USER opstream

EXPOSE 3001

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "src/main.ts", "start"]
