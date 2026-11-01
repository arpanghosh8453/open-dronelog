# =============================================================================
# Open Drone Log — Docker multi-stage build
#
# Stage 1: Build Rust backend (Axum web server)
# Stage 2: Build React frontend (Vite)
# Stage 3: Python venv for custom parsers (built where pip/apt are available)
# Stage 4: Runtime — distroless, non-root, single Axum process (API + frontend)
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Rust backend build
# ---------------------------------------------------------------------------
FROM rust:1.85-bookworm@sha256:e51d0265072d2d9d5d320f6a44dde6b9ef13653b035098febd68cce8fa7c0bc4 AS backend-builder

# Install system deps for DuckDB bundled build
RUN apt-get update && apt-get install -y \
    cmake \
    pkg-config \
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
FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS frontend-builder

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
# Stage 3: Python venv for custom parser scripts
#
# Built on Debian 13 so the interpreter version (3.13.5) matches the
# distroless python3-debian13 runtime image, which the venv points back to.
# ---------------------------------------------------------------------------
FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS python-venv

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Optional Python dependencies for custom parser scripts.
# Users can edit requirements.txt and rebuild the image.
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/parser-venv && \
    /opt/parser-venv/bin/python -m pip install --no-cache-dir -r /tmp/requirements.txt && \
    # pip is not needed at runtime
    /opt/parser-venv/bin/python -m pip uninstall -y pip

# Data directory skeleton: distroless has no shell, so create it here and
# copy it over with the right ownership.
RUN mkdir -p /data/drone-logbook

# ---------------------------------------------------------------------------
# Stage 4: Runtime (distroless: no shell, no package manager)
#
# python3-debian13 ships glibc, libstdc++ (needed by bundled DuckDB) and
# Python 3.13 for custom parsers. The :nonroot variant runs as UID 65532.
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/python3-debian13:nonroot@sha256:1c32c3720dc4c7f0c7dbe998737f32c200add6511eca7cec705008be488b87d6 AS runtime

# Python venv for custom parsers; make "python3" resolve to the venv interpreter
COPY --from=python-venv /opt/parser-venv /opt/parser-venv
ENV PATH="/opt/parser-venv/bin:/usr/local/bin:/usr/bin:/bin"

# Backend binary and frontend build (served by the Axum backend)
COPY --from=backend-builder /build/src-tauri/target/release/open-dronelog /app/open-dronelog
COPY --from=frontend-builder /build/dist /app/www

# Data directory owned by the unprivileged user, created before VOLUME so new
# volumes inherit the ownership.
COPY --from=python-venv --chown=65532:65532 /data /data

# Environment variables
ENV DATA_DIR=/data/drone-logbook
ENV STATIC_DIR=/app/www
ENV PORT=8080
ENV HOST=0.0.0.0
ENV RUST_LOG=DEBUG

# Writable HOME for parser libraries that cache under ~ (mount a tmpfs on /tmp
# when running with a read-only root filesystem); no .pyc writes.
ENV HOME=/tmp
ENV PYTHONDONTWRITEBYTECODE=1

# Unprivileged HTTP port (no privileges needed to bind)
EXPOSE 8080

# Run as non-root (explicit, matches the :nonroot base)
USER 65532:65532

# Probe the server over loopback; needs no shell or curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["/app/open-dronelog", "--healthcheck"]

# Persistent data volume
VOLUME ["/data/drone-logbook"]

# The base image's entrypoint is python3; run the backend instead
ENTRYPOINT ["/app/open-dronelog"]
