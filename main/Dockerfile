# V_N main server — build from repo root:  docker build -f main/Dockerfile -t vn-main .
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=10000 DATA_DIR=/data
COPY shared ./shared
COPY main ./main
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 10000
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "--max-old-space-size=300", "main/src/server.js"]
