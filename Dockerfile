# Stage 1: Build frontend
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY src/frontend/package*.json ./
RUN npm ci
COPY src/frontend/ ./
RUN npm run build

# Stage 2: Build backend
FROM golang:1.22-alpine AS backend
WORKDIR /app/backend
COPY src/backend/go.* ./
RUN go mod download
COPY src/backend/ ./
ARG APP_VERSION=dev
ARG PUBKEY=""
ARG SOURCES="https://ghcr.io/alexeyinwerp/boardripper,https://www.ripperdoc.de/boardripper"
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w \
        -X boardripper/updater.Version=${APP_VERSION} \
        -X boardripper/updater.PubKey=${PUBKEY} \
        -X boardripper/updater.SourceList=${SOURCES}" \
    -o server .

# Pre-create /data and /library owned by the runtime UID. scratch has no
# shell + no mkdir, so we stage the dirs in alpine first and COPY them
# into the final image. Without this, running the image with no host
# bind-mount fails at startup with `mkdir /data: permission denied`
# (the server's MkdirAll can't create top-level dirs as non-root).
RUN mkdir -p /opt/empty/data /opt/empty/library && \
    chown -R 65532:65532 /opt/empty

# Stage 3: Final minimal image. Runs as non-root (UID 65532, the
# `nonroot` user from the distroless convention) so a hypothetical RCE in
# the binary doesn't own the bind-mounted /data and /library volumes.
# scratch has no /etc/passwd, so we synthesize one with just the entry
# that USER references — Go's HTTP stack doesn't need a real user lookup.
FROM scratch
COPY --from=backend /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=backend /app/backend/server /server
COPY --from=frontend /app/frontend/dist /static
# Bundled board reference database. Backend prefers DATA_DIR/boards.db when
# the user has staged a curated copy on their volume; falls back here when
# /data is empty (default fresh install). Override with BOARDDB_PATH.
COPY ["Board Database/boards.db", "/boards.db"]
COPY etc-passwd /etc/passwd
# --chown is required: cross-stage COPY otherwise resets ownership to
# root:root and the runtime UID 65532 can't write into /data (SQLite
# fails with `unable to open database file (14)`).
COPY --chown=65532:65532 --from=backend /opt/empty/data    /data
COPY --chown=65532:65532 --from=backend /opt/empty/library /library
USER 65532:65532
EXPOSE 8080
ENV STATIC_DIR=/static
ENV DATA_DIR=/data
ENV LIBRARY_DIR=/library
ENV PORT=8080
ENTRYPOINT ["/server"]
