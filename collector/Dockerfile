# Imagem do coletor, para hospedar num Railway, Fly ou VPS.
#
# Use isto se o repositório for privado e os 2.000 minutos gratuitos do
# GitHub Actions ficarem apertados, ou se você quiser log e retentativa
# num lugar só.
FROM node:20-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY tsconfig.json ./

# O agendamento fica a cargo da plataforma (cron job do Railway,
# scheduled machine do Fly). O contêiner só executa e sai.
CMD ["npx", "tsx", "src/index.ts", "rodada"]
