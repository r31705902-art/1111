#!/bin/sh
# Загрузка готовых образов из images/ и (по желанию) публикация в реестр
# ./scripts/load-images.sh ghcr.io/myname   (перед этим: docker login ghcr.io)
set -e
cd "$(dirname "$0")/.."
for f in images/*.tar.gz; do echo "== $f"; docker load -i "$f"; done
if [ -n "$1" ]; then for a in main edge bot encoder; do docker tag vn-$a:latest $1/vn-$a:latest && docker push $1/vn-$a:latest; done; fi
