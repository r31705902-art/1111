# V_N Telegram bot — build from repo root:  docker build -f bot/Dockerfile -t vn-bot .
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=10000
COPY shared ./shared
COPY bot ./bot
USER node
EXPOSE 10000
CMD ["node", "--max-old-space-size=96", "bot/src/bot.js"]
