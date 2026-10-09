# V_N encoder (ffmpeg 9 static: SVT-AV1 + libaom + x264) — запускать на своём ПК/VPS/GitHub Actions, НЕ на Render free.
# build from repo root:  docker build -f encoder/Dockerfile -t vn-encoder .
# Для NVENC (видеокарта NVIDIA) статический ffmpeg не подходит — запускай encoder.js на хосте с родным ffmpeg.
FROM mwader/static-ffmpeg:9.0.2 AS ff
FROM node:24-alpine
COPY --from=ff /ffmpeg /ffprobe /usr/local/bin/
WORKDIR /app
COPY shared ./shared
COPY encoder ./encoder
ENV NODE_ENV=production WORK_DIR=/work
RUN mkdir -p /work
VOLUME /work
ENTRYPOINT ["node", "encoder/src/encoder.js"]
CMD ["worker"]
