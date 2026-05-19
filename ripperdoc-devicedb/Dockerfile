# ripperdoc-devicedb — canonical online boards-DB service.
#
# Multi-stage build mirroring the BoardRipper Dockerfile idiom:
#   1. golang:1.23-alpine builder — CGO_ENABLED=0 static binaries
#   2. alpine:3 runtime — small but retains a shell so the admin CLI
#      is usable via `docker exec`.
#
# Two binaries are produced and shipped:
#   /usr/local/bin/devicedb-server   — HTTP service (PID 1)
#   /usr/local/bin/devicedb-cli      — admin CLI (used via docker exec)
#
# Mounts:
#   /data  — canonical SQLite + snapshot output (RW)
#   /seed  — read-only mount of the boards.db that seeds an empty DB.
#
# Build args:
#   APP_VERSION  — embedded in version banner (default 'dev')

FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
ARG APP_VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X main.Version=${APP_VERSION}" \
    -o /out/devicedb-server ./cmd/server
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/devicedb-cli ./cmd/admin

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata sqlite-libs && \
    adduser -D -u 65532 devicedb && \
    mkdir -p /data /seed /app/web && \
    chown -R devicedb:devicedb /data /app
COPY --from=build /out/devicedb-server /usr/local/bin/devicedb-server
COPY --from=build /out/devicedb-cli    /usr/local/bin/devicedb-cli
COPY web /app/web
USER devicedb
WORKDIR /app
EXPOSE 8090
ENV LISTEN_ADDR=:8090
ENV DATA_DIR=/data
ENV SEED_DB_PATH=/seed/boards.db
ENV WEB_DIR=/app/web
ENTRYPOINT ["/usr/local/bin/devicedb-server"]
