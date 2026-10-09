# V_N swarm edge node — build from repo root:  docker build -f edge/Dockerfile -t vn-edge .
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=10000
COPY shared ./shared
COPY edge ./edge
USER node
EXPOSE 10000
CMD ["node", "--max-old-space-size=160", "edge/src/edge.js"]
