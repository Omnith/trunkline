# builder
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch
COPY . .
# note: not hermetic - better-sqlite3's install script downloads its linux prebuilt
# from GitHub Releases at install time (slim has no compiler fallback by design)
RUN pnpm install --frozen-lockfile \
 && pnpm run build \
 && pnpm prune --prod

# runtime
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    TRUNKLINE_BIND=0.0.0.0 \
    TRUNKLINE_DB=/data/trunkline.db \
    TRUNKLINE_EVENTS=/data/trunkline.events.jsonl
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4747/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/trunkline.js"]
CMD ["serve"]
