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
ARG GITHUB_TOKEN=""
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X boardripper/updater.Version=${APP_VERSION} -X boardripper/updater.GitHubToken=${GITHUB_TOKEN}" \
    -o server .

# Stage 3: Final minimal image
FROM scratch
COPY --from=backend /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=backend /app/backend/server /server
COPY --from=frontend /app/frontend/dist /static
EXPOSE 8080
ENV STATIC_DIR=/static
ENV DATA_DIR=/data
ENV LIBRARY_DIR=/library
ENV PORT=8080
ENTRYPOINT ["/server"]
