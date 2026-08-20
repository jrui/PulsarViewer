#!/bin/bash

# This script prepares the backend and frontend resources for bundling

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/src/backend"
PUBLIC_DIR="$BACKEND_DIR/public"

echo "🔨 Preparing bundle resources..."
echo "Project root: $PROJECT_ROOT"

# Build the backend
echo "📦 Building backend binary..."
cd "$BACKEND_DIR"
go build -o pulsarviewer-backend ./cmd/main.go
echo "✓ Backend built successfully"

# Ensure public directory exists and is accessible
if [ ! -d "$PUBLIC_DIR" ]; then
  echo "❌ Public directory not found at: $PUBLIC_DIR"
  exit 1
fi

echo "✓ Public directory found at: $PUBLIC_DIR"
echo "✓ Bundle resources prepared successfully"
