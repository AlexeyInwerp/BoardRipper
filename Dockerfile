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
USER 65532:65532
EXPOSE 8080
ENV STATIC_DIR=/static
ENV DATA_DIR=/data
ENV LIBRARY_DIR=/library
ENV PORT=8080
ENTRYPOINT ["/server"]
