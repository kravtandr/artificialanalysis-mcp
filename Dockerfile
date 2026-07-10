# Этап сборки
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Рантайм: HTTP-транспорт, non-root
FROM node:22-alpine
RUN apk add --no-cache tini
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
# tini: node не должен быть PID 1 — иначе SIGTERM от оркестратора игнорируется
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
