FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Instala también devDependencies: tsx se usa en runtime (sin paso de build)
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY content ./content
# Chromium para el Buscador (Playwright), instalado con sus dependencias del sistema
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium
RUN mkdir -p /app/wa_auth /app/browser_profile && chown -R node:node /app/wa_auth /app/browser_profile /app/content
USER node
EXPOSE 3000
CMD ["npx", "tsx", "src/worker.ts"]
