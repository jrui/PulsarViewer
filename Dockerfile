# Build stage
FROM golang:1.22-alpine AS builder

WORKDIR /build

# Copy Go backend source
COPY src/backend ./src/backend

WORKDIR /build/src/backend

# Build the backend
RUN CGO_ENABLED=0 GOOS=linux go build -o pulsarviewer-backend ./cmd/main.go

# Runtime stage
FROM alpine:latest

WORKDIR /app

# Copy built binary from builder
COPY --from=builder /build/src/backend/pulsarviewer-backend /app/

# Copy web UI
COPY public /app/public

# Expose ports
EXPOSE 3000 50051

# Run the backend
CMD ["./pulsarviewer-backend"]
