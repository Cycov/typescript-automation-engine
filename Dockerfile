ARG BUILD_FROM=ghcr.io/hassio-addons/base:21.0.10
FROM ${BUILD_FROM}

# Unpin musl in the world file (the base image pins an exact version that the
# repository may have moved past), upgrade base packages, then install Node and
# the build tools better-sqlite3 needs when no prebuilt binary matches
RUN sed -i 's/^musl=.*/musl/' /etc/apk/world \
    && apk upgrade --no-cache \
    && apk add --no-cache nodejs npm python3 make g++

# Set up working directory
WORKDIR /app

# Install dependencies exactly as locked
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Copy default automation templates
COPY defaults/ ./defaults/

# SKILL.md: AI system prompt, MCP API reference and download
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
    io.hass.version="1.9.4"

CMD ["/run.sh"]
