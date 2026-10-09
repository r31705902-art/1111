#!/bin/sh
# Сборка всех образов из исходников и сохранение в images/*.tar.gz
# Использование: ./scripts/build-images.sh [registry/префикс]   напр. ghcr.io/myname
set -e
cd "$(dirname "$0")/.."
P=${1:+$1/}
mkdir -p images
for a in main edge bot encoder; do
  echo "== vn-$a"; docker build -f $a/Dockerfile -t ${P}vn-$a:latest .
done
docker save ${P}vn-main:latest ${P}vn-edge:latest ${P}vn-bot:latest | gzip > images/vn-main-edge-bot.tar.gz
docker save ${P}vn-encoder:latest | gzip > images/vn-encoder.tar.gz
[ -n "$1" ] && for a in main edge bot encoder; do docker push ${P}vn-$a:latest; done
echo "готово: images/"
