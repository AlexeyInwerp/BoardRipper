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
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server .

# Stage 3: Final minimal image
FROM scratch
COPY --from=backend /app/backend/server /server
COPY --from=frontend /app/frontend/dist /static
EXPOSE 8080
ENV STATIC_DIR=/static
ENV DATA_DIR=/data
ENV LIBRARY_DIR=/library
ENV PORT=8080
ENTRYPOINT ["/server"]
