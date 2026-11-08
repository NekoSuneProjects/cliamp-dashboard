FROM node:22-alpine
RUN apk add --no-cache ffmpeg tini font-dejavu
WORKDIR /app
COPY package.json server.js radio-worker.js station-metadata.js stream-destinations.js radio-layout.js radio-artwork.js ./
RUN npm install --omit=dev --no-audit --no-fund
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV PORT=8096 DATA_DIR=/data
EXPOSE 8096
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","server.js"]
