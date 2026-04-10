# OpStream — Production Dockerfile
#
# Build context: Opnet-devs/ parent directory (one level up from OpStream/)
# This is required because OpStream depends on a local file: ../OpKit
#
# Build manually:
#   docker build -f OpStream/Dockerfile -t opstream ..
#
# docker-compose.yml sets the context automatically — use that instead.

FROM node:22-alpine

# dumb-init: proper PID 1 signal handling (SIGTERM → clean shutdown)
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy OpKit to the path package.json expects: file:../OpKit → /OpKit
COPY OpKit/ /OpKit/

# Install dependencies (OpStream only — OpKit resolved via file: path above)
COPY OpStream/package*.json ./
RUN npm install --prefer-offline

# Copy source
COPY OpStream/src/        ./src/
COPY OpStream/tsconfig.json ./

# Create persistent directories (overridden by volume mounts at runtime)
RUN mkdir -p /app/data /app/logs

# Drop root — run as unprivileged user
RUN addgroup -g 1001 -S opstream && \
    adduser  -u 1001 -S opstream -G opstream && \
    chown -R opstream:opstream /app /OpKit
USER opstream

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "src/main.ts", "start"]
