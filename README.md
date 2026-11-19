# Swachh Safar PWA

Offline-first registration for Swachh Safar: React + Vite + Tailwind, SQLite WASM on OPFS, sign-in against the Swachh Safar backend (PostgreSQL), installable PWA.

```bash
npm install
npm run dev            # http://localhost:5173
npm run build && npm run preview   # production PWA on http://localhost:4173
npm test               # unit tests
npm run test:e2e       # Playwright browser tests (builds + previews automatically)
```

See [docs/PHASE1.md](docs/PHASE1.md) for the architecture, the registration and sync workflow, the tests, and Android testing steps.

Production deployment (IP + port, nginx, systemd, PostgreSQL, rollback): [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Android installation and the physical-device test sheet: [docs/ANDROID_TESTING.md](docs/ANDROID_TESTING.md).
