FROM oven/bun:1.0

WORKDIR /app

# Copy package.json first for better caching
COPY package.json ./
RUN bun install

# Copy the rest of the application
COPY . .

# Set environment variables
ENV NODE_ENV=production

# Run the application
CMD ["bun", "start"]