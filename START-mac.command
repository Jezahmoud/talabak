#!/bin/bash
# انقر مرتين لبدء التجربة على ماك
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js غير مثبت. سيفتح موقعه الآن، ثبت نسخة LTS ثم انقر هذا الملف مرة أخرى."
  open "https://nodejs.org"; read -p "اضغط Enter للإغلاق"; exit 1
fi
[ -d node_modules ] || npm install
npm start
