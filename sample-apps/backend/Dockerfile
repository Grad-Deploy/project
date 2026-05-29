FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm ci --production
EXPOSE 3000
USER node
CMD ["node", "index.js"]
