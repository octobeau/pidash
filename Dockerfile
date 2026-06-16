FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

RUN apk add --no-cache openssl su-exec

COPY package.json server.js ./
COPY public ./public
COPY config ./config
COPY docker-entrypoint.sh ./
RUN chmod +x /app/docker-entrypoint.sh

# Create an unprivileged user for runtime
RUN addgroup -S nodeuser && adduser -S nodeuser -G nodeuser
RUN chown -R nodeuser:nodeuser /app

EXPOSE 8080 8443
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
