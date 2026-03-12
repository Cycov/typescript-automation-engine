#!/command/with-contenv bash
# shellcheck shell=bash
set -eo pipefail

APP_DIR="/app"
DATA_DIR="/data"
AUTOMATIONS_DIR="$DATA_DIR/automations"
DEFAULTS_DIR="$APP_DIR/defaults/automations"
TAE_TYPES_SRC="$APP_DIR/dist/api"

echo "╔═══════════════════════════════════════════════════════╗"
echo "║  TypeScript Automation Engine — Starting...           ║"
echo "╚═══════════════════════════════════════════════════════╝"

# ─── First run: seed default automation files ────────────────
if [ ! -d "$AUTOMATIONS_DIR" ]; then
    echo "First run — creating automations directory..."
    mkdir -p "$AUTOMATIONS_DIR"
    if [ -d "$DEFAULTS_DIR" ]; then
        cp -r "$DEFAULTS_DIR/"* "$AUTOMATIONS_DIR/"
        echo "Default automation files copied to $AUTOMATIONS_DIR"
    fi
fi

# ─── Install type definitions for editor autocomplete ────────
echo "Installing TAE type definitions..."
TAE_TYPES_DEST="$AUTOMATIONS_DIR/node_modules/tae"
mkdir -p "$TAE_TYPES_DEST"

# Copy .d.ts, .js, and .d.ts.map files from compiled api/
if [ -d "$TAE_TYPES_SRC" ]; then
    for f in "$TAE_TYPES_SRC"/*.d.ts "$TAE_TYPES_SRC"/*.js "$TAE_TYPES_SRC"/*.d.ts.map; do
        [ -f "$f" ] && cp "$f" "$TAE_TYPES_DEST/"
    done
fi

# Create package.json for the tae module
cat > "$TAE_TYPES_DEST/package.json" << 'EOF'
{
  "name": "tae",
  "version": "1.0.0",
  "main": "./index.js",
  "types": "./index.d.ts"
}
EOF

# Create tsconfig.json for automations if not present
if [ ! -f "$AUTOMATIONS_DIR/tsconfig.json" ]; then
    cat > "$AUTOMATIONS_DIR/tsconfig.json" << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "outDir": "./dist"
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
EOF
fi

echo "Type definitions installed."

# ─── Ensure tae module symlink exists ────────────────────────
if [ ! -L "$APP_DIR/node_modules/tae" ] && [ ! -d "$APP_DIR/node_modules/tae" ]; then
    ln -sf "$APP_DIR/dist/api" "$APP_DIR/node_modules/tae"
fi

# ─── Start the addon ────────────────────────────────────────
cd "$APP_DIR"
echo "Starting TypeScript Automation Engine..."
exec node dist/main/index.js
