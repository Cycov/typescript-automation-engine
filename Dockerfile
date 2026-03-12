ARG BUILD_FROM=ghcr.io/hassio-addons/base:16.3.2
FROM ${BUILD_FROM}

# Install Node.js and build tools for native modules (better-sqlite3)
RUN apk add --no-cache nodejs npm python3 make g++

# Set up working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --production=false

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Copy default automation templates
COPY defaults/ ./defaults/

# Copy SKILL.md for AI export
COPY SKILL.md ./

# Build TypeScript (main process + api module)
RUN npx tsc

# Copy UI HTML to dist (not compiled by tsc)
RUN mkdir -p ./dist/main/ui && \
    cp ./src/main/ui/index.html ./dist/main/ui/index.html

# Create tae module symlink for runtime resolution
RUN ln -sf /app/dist/api /app/node_modules/tae

# Copy run script
COPY run.sh /
RUN chmod a+x /run.sh

# Labels
LABEL \
    io.hass.name="TypeScript Automation Engine" \
    io.hass.description="Write and run Home Assistant automations in TypeScript" \
    io.hass.type="addon" \
    io.hass.version="1.6.0"

CMD ["/run.sh"]
