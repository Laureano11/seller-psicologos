FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Instala también devDependencies: tsx se usa en runtime (sin paso de build)
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY content ./content
RUN mkdir -p /app/wa_auth /app/data && chown -R node:node /app/wa_auth /app/data /app/content
USER node
EXPOSE 3000
CMD ["npx", "tsx", "src/worker.ts"]
