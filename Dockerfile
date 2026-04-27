FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

ENV NODE_ENV=production
ENV PORT=3000
ENV MAX_REQUEST_MB=50
ENV DEFAULT_WIDTH_PX=900
ENV DEFAULT_MAX_HEIGHT_PX=30000
ENV LOAD_REMOTE_IMAGES=false
ENV DEFAULT_TIMEZONE=UTC

EXPOSE 3000

CMD ["node", "src/server.js"]
