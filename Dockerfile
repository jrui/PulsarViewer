FROM node:22.15.0-alpine AS builder
WORKDIR /app

# Install build-time dependencies
COPY package*.json ./
RUN npm install

# Copy sources and build
COPY . ./
RUN npm run build

FROM node:22.15.0-alpine AS runner
WORKDIR /app

# Install only runtime dependencies
COPY package*.json ./
ENV NODE_ENV=production
RUN npm ci --only=production

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist
# Copy static public assets so the server can serve '/'
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "dist/index.js"]
