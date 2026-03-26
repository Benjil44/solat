FROM node:20-slim

# Install FFmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Create runtime directories
RUN mkdir -p data media/recordings media/live logs

# Non-root user for security
RUN useradd -r -u 1001 -g daemon djapp && \
    chown -R djapp:daemon /app
USER djapp

EXPOSE 3000 1935

CMD ["node", "server.js"]
