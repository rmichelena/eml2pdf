FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && \
    chown -R pwuser:pwuser /app

COPY --chown=pwuser:pwuser src/ ./src/

ENV NODE_ENV=production
ENV PORT=3000
ENV MAX_REQUEST_MB=50
ENV DEFAULT_WIDTH_PX=900
ENV DEFAULT_MAX_HEIGHT_PX=30000
ENV LOAD_REMOTE_IMAGES=false
ENV DEFAULT_TIMEZONE=UTC
ENV MAX_CONCURRENT_RENDERS=3

USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
