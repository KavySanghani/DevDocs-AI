# DevDocs AI — Developer Setup Guide

This guide covers setting up your local development environment for DevDocs AI.

---

## 1. Prerequisites

- **Node.js**: `v20.0.0` or higher (verified on Node `v22.x`)
- **npm**: `v10.0.0` or higher
- **Git**: Installed and configured

---

## 2. Environment Setup

1. Copy the environment configuration template:
   ```bash
   cp .env.example .env
   ```

2. Review the variables in `.env`:
   - `PORT`: API server port (default: `4000`)
   - `HOST`: API host interface (default: `0.0.0.0`)
   - `NODE_ENV`: Runtime environment (`development`, `test`, `production`)
   - `LOG_LEVEL`: Pino logger level (`debug`, `info`, `warn`, `error`)
   - `CORS_ORIGIN`: Allowed origins for CORS (default: `http://localhost:5173`)

---

## 3. Installation

Install all dependencies across the monorepo:
```bash
npm install
```

---

## 4. Running the Development Environment

Start both the Fastify API server and the Vite React frontend concurrently:
```bash
npm run dev
```

Or run services individually in dedicated terminals:
- **API Server** (`http://localhost:4000`):
  ```bash
  npm run dev:api
  ```
- **Web Frontend** (`http://localhost:5173`):
  ```bash
  npm run dev:web
  ```

---

## 5. Verification Commands

Run the full verification suite:

```bash
# Typecheck all packages
npm run typecheck

# Run test suites across packages
npm run test

# Build production artifacts
npm run build
```

---

## 6. Probing the Health Endpoint

Once the API server is running, probe the health endpoints:

```bash
# Main application health
curl -s http://localhost:4000/health | jq

# Liveness probe
curl -s http://localhost:4000/health/live | jq

# Readiness probe
curl -s http://localhost:4000/health/ready | jq
```
