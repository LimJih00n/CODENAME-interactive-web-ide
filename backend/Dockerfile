# Node.js 이미지를 사용
FROM node:16

# 작업 디렉토리 설정
WORKDIR /app

# package.json 파일과 node_modules 설치
COPY package*.json ./
RUN npm install

# 애플리케이션 소스 복사
COPY . .

# 포트 노출
EXPOSE 4000

# 서버 실행
CMD ["node", "server.js"]
