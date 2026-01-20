# Multi-stage build for PulsarViewer backend (Go)
# Usage (from repo root):
#   docker build -f refactored/backend/Dockerfile -t pulsarviewer-backend .
#   docker run --rm -p 3000:3000 -p 50051:50051 pulsarviewer-backend

FROM golang:1.22 as builder
WORKDIR /app

# Copy module definitions
COPY refactored/backend/go.mod refactored/backend/go.sum ./
RUN go mod download

# Copy source
COPY refactored/backend/cmd ./cmd
COPY refactored/backend/internal ./internal
COPY public ./public

# Build static binary
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /app/pulsarviewer ./cmd/main.go

FROM gcr.io/distroless/static-debian12
WORKDIR /app

# Copy binary and static assets
COPY --from=builder /app/pulsarviewer /app/pulsarviewer
COPY --from=builder /app/public /app/public

EXPOSE 3000 50051
ENTRYPOINT ["/app/pulsarviewer"]
