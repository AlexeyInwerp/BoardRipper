# Stage 1: Build frontend
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY src/frontend/package*.json ./
RUN npm ci
COPY src/frontend/ ./
RUN npm run build

# Stage 2: Build backend
# Run the build stage on the BUILD host's native arch and cross-compile to the
# target arch (GOARCH=$TARGETARCH). CGO is disabled, so cross-compilation is
# trivial and skips slow QEMU emulation of the target toolchain during buildx.
#
# Go 1.25 is required by go-pdfium (its go.mod declares `go 1.25.0`). The PDF
# text index pulled that dependency in, which bumped the toolchain 1.22 -> 1.25.
# modernc.org/sqlite MUST be kept in lock-step with the toolchain: v1.34.5
# (transpiled libc generated for Go 1.21) crashed at runtime under Go 1.25 with
# "unable to open database file: out of memory (14)" the instant the databank
# DB was opened (shipped broken in v0.31.0). v1.50.1 ships libc regenerated for
# Go 1.25 and boots cleanly. If the golang base image moves again, bump
# modernc.org/sqlite to a release whose go.mod `go` directive matches.
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS backend
ARG TARGETARCH
WORKDIR /app/backend
COPY src/backend/go.* ./
RUN go mod download
COPY src/backend/ ./
ARG APP_VERSION=dev
ARG PUBKEY=""
ARG SOURCES="https://ghcr.io/alexeyinwerp/boardripper,https://www.ripperdoc.de/boardripper"
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build \
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
# SQLite needs a writable temp directory for statement journals, sorters, and
# VACUUM. The scratch image has no /tmp and the runtime CWD (/) isn't writable
# by UID 65532, so SQLite's unixTempFileDir() finds nowhere to put a temp file
# and returns SQLITE_IOERR_GETTEMPPATH (extended code 6410) the moment an
# operation needs one. This is invisible on a fresh DB but fatal on a populated
# one: the pdf-index v0→v1 migration drops the large legacy pdf_text/pdf_pages
# tables, and dropping a multi-hundred-MB table opens a statement journal.
# Point all temp-file creation at the always-writable, disk-backed data volume.
# (SQLITE_TMPDIR is the first dir SQLite consults; TMPDIR also covers Go's
# os.TempDir() for any non-SQLite temp needs.) Shipped broken in v0.31.0/v0.31.1.
ENV SQLITE_TMPDIR=/data
ENV TMPDIR=/data
# Return freed heap pages to the OS promptly. Go's default Linux scavenger uses
# MADV_FREE, which leaves freed pages counted in RSS until the kernel is under
# memory pressure — the "consumes many gigs and slowly releases back" profile.
# MADV_DONTNEED drops them immediately so RSS tracks live memory. The runtime
# also derives a soft GOMEMLIMIT from the cgroup memory limit at startup (see
# configureMemoryLimit in main.go) so the GC works harder before RSS climbs.
ENV GODEBUG=madvdontneed=1
ENTRYPOINT ["/server"]
