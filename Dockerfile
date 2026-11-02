# Playwright image tag must match the playwright version in package-lock.json
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
# The captcha is read by src/ocr.py (Python + Pillow + pytesseract, which calls the tesseract program).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pil python3-pytesseract tesseract-ocr \
 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000
EXPOSE 10000
CMD ["node", "src/server.js"]
