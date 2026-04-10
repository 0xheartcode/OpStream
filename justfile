# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  OpStream — justfile                                                         ║
# ║  Pure Layer 2 chain scanner for OPNET                                        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

# ── Colours ───────────────────────────────────────────────────────────────────
export RED    := '\033[0;31m'
export GREEN  := '\033[0;32m'
export YELLOW := '\033[0;33m'
export BLUE   := '\033[0;34m'
export CYAN   := '\033[0;36m'
export BOLD   := '\033[1m'
export RESET  := '\033[0m'

# ── Config ────────────────────────────────────────────────────────────────────
DB_PATH  := env_var_or_default("DB_PATH", "data/opstream.db")
APP_NAME := "opstream"
PM2_NAME := "opstream"

# ── Default ───────────────────────────────────────────────────────────────────
default:
    @just --list

# ══════════════════════════════════════════════════════════════════════════════
# §1  Setup
# ══════════════════════════════════════════════════════════════════════════════

# Install dependencies
install:
    @echo "${BLUE}▶ Installing dependencies...${RESET}"
    npm install
    @echo "${GREEN}✔ Done${RESET}"

# Create .env from .env.example (skips if .env already exists)
env-init:
    #!/usr/bin/env bash
    if [ -f .env ]; then
        echo "${YELLOW}⚠  .env already exists — skipping (edit it manually)${RESET}"
    else
        cp .env.example .env
        echo "${GREEN}✔ Created .env from .env.example${RESET}"
        echo "${YELLOW}   Edit .env and set OPNET_RPC_URL before running${RESET}"
    fi

# Full setup: install + .env init
setup: install env-init
    @echo "${GREEN}✔ Setup complete — run 'just start' to begin${RESET}"

# ══════════════════════════════════════════════════════════════════════════════
# §2  Run
# ══════════════════════════════════════════════════════════════════════════════

# Bootstrap + live: catch up to chain tip, then follow it (recommended)
start:
    @echo "${BLUE}▶ Starting OpStream (bootstrap → live)...${RESET}"
    npx tsx src/main.ts start

# Bootstrap only: scan from BOOTSTRAP_FROM_BLOCK to chain tip, then exit
bootstrap:
    @echo "${BLUE}▶ Running bootstrap scan...${RESET}"
    npx tsx src/main.ts bootstrap

# Catchup: incremental scan from last checkpoint to chain tip, then exit
catchup:
    @echo "${BLUE}▶ Running catchup (from last checkpoint)...${RESET}"
    npx tsx src/main.ts catchup

# Live indexer only: follow chain tip (assumes already bootstrapped)
live:
    @echo "${BLUE}▶ Starting live indexer...${RESET}"
    npx tsx src/main.ts live

# ══════════════════════════════════════════════════════════════════════════════
# §3  Develop / Validate
# ══════════════════════════════════════════════════════════════════════════════

# Run tests
test:
    @echo "${BLUE}▶ Running tests...${RESET}"
    npx vitest run

# Watch mode tests
test-watch:
    npx vitest

# TypeScript type check (no emit)
typecheck:
    @echo "${BLUE}▶ Type checking...${RESET}"
    npx tsc --noEmit
    @echo "${GREEN}✔ No type errors${RESET}"

# ══════════════════════════════════════════════════════════════════════════════
# §4  Database
# ══════════════════════════════════════════════════════════════════════════════

# Show database stats: row counts per table + file size
db-status:
    #!/usr/bin/env bash
    DB="${DB_PATH:-data/opstream.db}"
    if [ ! -f "$DB" ]; then
        echo "${RED}✘ Database not found: $DB${RESET}"
        exit 1
    fi
    echo "${CYAN}Database: $DB${RESET}"
    SIZE=$(du -sh "$DB" | cut -f1)
    echo "${CYAN}Size:     $SIZE${RESET}"
    echo ""
    QUERY="SELECT 'blocks' AS \"table\", count(*) AS rows FROM blocks UNION ALL SELECT 'transactions', count(*) FROM transactions UNION ALL SELECT 'tx_outputs', count(*) FROM tx_outputs UNION ALL SELECT 'events', count(*) FROM events UNION ALL SELECT 'token_deployments', count(*) FROM token_deployments UNION ALL SELECT 'scan_checkpoints', count(*) FROM scan_checkpoints UNION ALL SELECT 'tokens', count(*) FROM tokens UNION ALL SELECT 'runtime_metrics', count(*) FROM runtime_metrics UNION ALL SELECT 'error_log', count(*) FROM error_log;"
    sqlite3 -header -column "$DB" "$QUERY"
    echo ""
    sqlite3 "$DB" "SELECT 'Checkpoint: block ' || last_block || '  (updated ' || datetime(updated_at, 'unixepoch') || ')' FROM scan_checkpoints WHERE scan_type = 'indexer';"

# Show recent errors from the error_log table
db-errors N="20":
    #!/usr/bin/env bash
    DB="${DB_PATH:-data/opstream.db}"
    QUERY="SELECT datetime(created_at,'unixepoch') as time, level, component, message FROM error_log ORDER BY created_at DESC LIMIT {{N}};"
    sqlite3 -header -column "$DB" "$QUERY"

# Backup the database (timestamped copy in data/)
db-backup:
    #!/usr/bin/env bash
    DB="${DB_PATH:-data/opstream.db}"
    if [ ! -f "$DB" ]; then
        echo "${RED}✘ No database at $DB${RESET}"
        exit 1
    fi
    TS=$(date +%Y%m%d_%H%M%S)
    DEST="data/opstream_backup_${TS}.db"
    cp "$DB" "$DEST"
    echo "${GREEN}✔ Backed up to $DEST${RESET}"

# Vacuum the database (reclaim space after large deletes)
db-vacuum:
    #!/usr/bin/env bash
    DB="${DB_PATH:-data/opstream.db}"
    echo "${BLUE}▶ Running VACUUM on $DB...${RESET}"
    sqlite3 "$DB" "VACUUM;"
    echo "${GREEN}✔ Done${RESET}"

# Reset the database (destructive — prompts for confirmation)
db-reset:
    #!/usr/bin/env bash
    DB="${DB_PATH:-data/opstream.db}"
    echo "${RED}${BOLD}⚠  This will DELETE the database: $DB${RESET}"
    read -r -p "Type 'yes' to confirm: " CONFIRM
    if [ "$CONFIRM" = "yes" ]; then
        rm -f "$DB"
        echo "${GREEN}✔ Database removed — it will be recreated on next run${RESET}"
    else
        echo "${YELLOW}Aborted${RESET}"
    fi

# ══════════════════════════════════════════════════════════════════════════════
# §5  Production (PM2)
# ══════════════════════════════════════════════════════════════════════════════

# Start OpStream under PM2 (bootstrap + live)
pm2-start:
    @echo "${BLUE}▶ Starting OpStream under PM2...${RESET}"
    pm2 start "npx tsx src/main.ts start" \
        --name "{{PM2_NAME}}" \
        --restart-delay 5000 \
        --max-restarts 10 \
        --log "logs/opstream.log" \
        --merge-logs
    pm2 save
    @echo "${GREEN}✔ OpStream running as PM2 process '{{PM2_NAME}}'${RESET}"

# Stop the PM2 process
pm2-stop:
    @echo "${YELLOW}▶ Stopping {{PM2_NAME}}...${RESET}"
    pm2 stop {{PM2_NAME}}

# Restart the PM2 process
pm2-restart:
    @echo "${YELLOW}▶ Restarting {{PM2_NAME}}...${RESET}"
    pm2 restart {{PM2_NAME}}

# Delete the PM2 process (full removal)
pm2-delete:
    @echo "${RED}▶ Removing {{PM2_NAME}} from PM2...${RESET}"
    pm2 delete {{PM2_NAME}}

# Show PM2 status
pm2-status:
    pm2 show {{PM2_NAME}}

# Stream PM2 logs (Ctrl+C to exit)
pm2-logs:
    pm2 logs {{PM2_NAME}}

# ══════════════════════════════════════════════════════════════════════════════
# §6  Utilities
# ══════════════════════════════════════════════════════════════════════════════

# Print current checkpoint and chain tip gap
status:
    #!/usr/bin/env bash
    DB="${DB_PATH:-data/opstream.db}"
    if [ ! -f "$DB" ]; then
        echo "${YELLOW}No database found at $DB — run 'just bootstrap' first${RESET}"
        exit 0
    fi
    CHECKPOINT=$(sqlite3 "$DB" "SELECT last_block FROM scan_checkpoints WHERE scan_type='indexer';" 2>/dev/null || echo "none")
    BLOCKS=$(sqlite3 "$DB" "SELECT count(*) FROM blocks;" 2>/dev/null || echo "0")
    EVENTS=$(sqlite3 "$DB" "SELECT count(*) FROM events;" 2>/dev/null || echo "0")
    TXS=$(sqlite3 "$DB" "SELECT count(*) FROM transactions;" 2>/dev/null || echo "0")
    echo "${CYAN}${BOLD}OpStream Status${RESET}"
    echo "  Checkpoint:   block ${CHECKPOINT}"
    echo "  Blocks:       ${BLOCKS}"
    echo "  Transactions: ${TXS}"
    echo "  Events:       ${EVENTS}"

# Check all prerequisites (node version, tsx, sqlite3, pm2)
doctor:
    #!/usr/bin/env bash
    echo "${CYAN}${BOLD}OpStream Doctor${RESET}"
    echo ""

    # Node.js
    if command -v node >/dev/null 2>&1; then
        NODE_VER=$(node --version)
        MAJOR=$(echo "$NODE_VER" | cut -d. -f1 | tr -d 'v')
        if [ "$MAJOR" -ge 22 ]; then
            echo "  ${GREEN}✔${RESET}  node $NODE_VER"
        else
            echo "  ${RED}✘${RESET}  node $NODE_VER — need v22+"
        fi
    else
        echo "  ${RED}✘${RESET}  node — not found"
    fi

    # tsx
    if npx tsx --version >/dev/null 2>&1; then
        TSX_VER=$(npx tsx --version 2>/dev/null | head -1)
        echo "  ${GREEN}✔${RESET}  tsx $TSX_VER"
    else
        echo "  ${YELLOW}⚠${RESET}  tsx — run 'just install'"
    fi

    # sqlite3 CLI (for db-status / db-reset)
    if command -v sqlite3 >/dev/null 2>&1; then
        echo "  ${GREEN}✔${RESET}  sqlite3 $(sqlite3 --version | cut -d' ' -f1)"
    else
        echo "  ${YELLOW}⚠${RESET}  sqlite3 CLI — not found (db-status / db-errors won't work)"
    fi

    # pm2
    if command -v pm2 >/dev/null 2>&1; then
        echo "  ${GREEN}✔${RESET}  pm2 $(pm2 --version)"
    else
        echo "  ${YELLOW}⚠${RESET}  pm2 — not found (install with: npm install -g pm2)"
    fi

    # .env
    if [ -f .env ]; then
        echo "  ${GREEN}✔${RESET}  .env found"
    else
        echo "  ${YELLOW}⚠${RESET}  .env missing — run 'just env-init'"
    fi

    # data dir
    DB="${DB_PATH:-data/opstream.db}"
    if [ -f "$DB" ]; then
        SIZE=$(du -sh "$DB" | cut -f1)
        echo "  ${GREEN}✔${RESET}  database: $DB ($SIZE)"
    else
        echo "  ${YELLOW}⚠${RESET}  no database yet — run 'just bootstrap'"
    fi

    # logs dir
    if [ -d logs ]; then
        echo "  ${GREEN}✔${RESET}  logs/ directory exists"
    else
        echo "  ${YELLOW}⚠${RESET}  logs/ missing — PM2 will create it on first start"
    fi
    echo ""
