FROM node:20-slim

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Render defaults to port 10000
EXPOSE 10000

# Run with V8 memory optimizations and exposed garbage collection for Render RAM protection
CMD ["node", "--optimize_for_size", "--max-old-space-size=350", "--expose-gc", "bot.mjs"]
