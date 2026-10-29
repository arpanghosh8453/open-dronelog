# =============================================================================
# Open Drone Log — Docker multi-stage build
#
# Stage 1: Build Rust backend (Axum web server)
# Stage 2: Build React frontend (Vite)
# Stage 3: Runtime — Nginx + Axum in a single container
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Rust backend build
# ---------------------------------------------------------------------------
FROM rust:1.85-bookworm AS backend-builder

# Install system deps for DuckDB bundled build
RUN apt-get update && apt-get install -y \
    cmake \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy only Cargo manifests first for layer caching
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock* ./src-tauri/
COPY src-tauri/build.rs ./src-tauri/

# Create dummy source files to cache dependency builds
RUN mkdir -p src-tauri/src && \
    echo 'fn main() {}' > src-tauri/src/main.rs && \
    echo '' > src-tauri/src/lib.rs && \
    echo '' > src-tauri/src/api.rs && \
    echo '' > src-tauri/src/database.rs && \
    echo '' > src-tauri/src/models.rs && \
    echo '' > src-tauri/src/parser.rs && \
    echo '' > src-tauri/src/server.rs && \
    echo '' > src-tauri/src/dronelogbook_parser.rs && \
    echo '' > src-tauri/src/litchi_parser.rs

# Build dependencies only (cached layer)
WORKDIR /build/src-tauri
RUN cargo build --release --features web --no-default-features 2>/dev/null || true

# Copy actual source code
COPY src-tauri/src/ ./src/
COPY src-tauri/icons/ ./icons/

# Rebuild with real source
RUN touch src/main.rs src/lib.rs && \
    cargo build --release --features web --no-default-features

# ---------------------------------------------------------------------------
# Stage 2: Frontend build
# ---------------------------------------------------------------------------
FROM node:22.23.4-bookworm-slim AS frontend-builder

WORKDIR /build

# Copy package files for layer caching
COPY package.json package-lock.json* ./

RUN npm ci

# Copy frontend source
COPY index.html tsconfig.json tsconfig.node.json vite.config.ts postcss.config.js tailwind.config.js ./
COPY src/ ./src/
COPY public/ ./public/

# Build with web backend mode
ENV VITE_BACKEND=web
RUN npx vite build

# ---------------------------------------------------------------------------
# Stage 3: Runtime
# ---------------------------------------------------------------------------
FROM node:22.23.4-bookworm-slim AS runtime


# Install nginx and Python for custom parsers.
RUN apt-get update && apt-get install -y \
    nginx \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default

# Install optional Python dependencies for custom parser scripts.
# Users can edit requirements.txt and rebuild the image.
COPY requirements.txt /app/requirements.txt
RUN python3 -m venv /opt/parser-venv && \
    /opt/parser-venv/bin/python -m pip install --no-cache-dir -U pip && \
    /opt/parser-venv/bin/python -m pip install --no-cache-dir -r /app/requirements.txt

# Ensure parser commands like "python3" use the venv interpreter by default.
ENV PATH="/opt/parser-venv/bin:${PATH}"

# Copy backend binary
COPY --from=backend-builder /build/src-tauri/target/release/open-dronelog /app/open-dronelog

# Copy frontend build
COPY --from=frontend-builder /build/dist /usr/share/nginx/html

# Copy nginx config
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Copy entrypoint
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create data directory
RUN mkdir -p /data/drone-logbook

# Environment variables
ENV DATA_DIR=/data/drone-logbook
ENV PORT=3001
ENV HOST=127.0.0.1
ENV RUST_LOG=DEBUG

# Expose HTTP port
EXPOSE 80

# Persistent data volume
VOLUME ["/data/drone-logbook"]

ENTRYPOINT ["/app/entrypoint.sh"]
