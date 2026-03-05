# ⏱ Cronômetro Sincronizado

Cronômetro em tempo real com painel admin e tela de visualização.
Qualquer pessoa que abrir o site verá o mesmo tempo, perfeitamente sincronizado.

---

## 📁 Estrutura dos arquivos

```
cronometro/
├── server.js          ← Backend (Node.js + Socket.io)
├── package.json       ← Dependências
└── public/
    ├── admin.html     ← Painel de controle (senha protegido)
    └── viewer.html    ← Tela somente leitura (compartilhe com todos)
```

---

## 🚀 Como rodar localmente

### 1. Instale o Node.js
Baixe em: https://nodejs.org (versão LTS)

### 2. Instale as dependências
Abra o terminal na pasta do projeto e execute:
```
npm install
```

### 3. Inicie o servidor
```
npm start
```

### 4. Acesse no navegador
- **Admin:** http://localhost:3000/admin.html  (senha: `admin123`)
- **Viewer:** http://localhost:3000/viewer.html

---

## 🌐 Como deixar acessível por outros computadores na mesma rede

Descubra o IP da sua máquina:
- **Windows:** `ipconfig` no terminal → procure "IPv4"
- **Mac/Linux:** `ifconfig` ou `ip a`

Então outras pessoas na mesma rede acessam:
- `http://SEU-IP:3000/viewer.html`

---

## ☁️ Deploy gratuito na internet (acesso de qualquer lugar)

### Opção 1 — Railway (recomendado)
1. Crie conta em https://railway.app
2. Crie novo projeto → "Deploy from GitHub"
3. Faça upload dos arquivos ou use o GitHub
4. Vai gerar uma URL pública automaticamente

### Opção 2 — Render
1. Crie conta em https://render.com
2. New → Web Service → conecte seu repositório
3. Build command: `npm install`
4. Start command: `node server.js`

---

## 🔐 Trocar a senha do Admin

Abra `server.js` e altere esta linha:
```js
const ADMIN_PASSWORD = 'admin123';
```

---

## 🔗 URLs
| Página    | URL                          |
|-----------|------------------------------|
| Admin     | /admin.html                  |
| Viewer    | /viewer.html                 |
