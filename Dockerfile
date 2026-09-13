FROM node:20-slim

# Install git and shell utilities
RUN apt-get update && apt-get install -y \
    git \
    bash \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create data directory for volumes
RUN mkdir -p /app/data/sessions /app/data/workspace

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
