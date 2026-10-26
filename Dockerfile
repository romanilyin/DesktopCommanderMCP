# Build and run this checkout as a local stdio MCP server.
FROM node:24-alpine

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --include=dev --ignore-scripts
RUN npm rebuild @vscode/ripgrep esbuild sharp
COPY . .
RUN npm run build
CMD ["node", "dist/index.js"]
