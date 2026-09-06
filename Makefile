.PHONY: lint-ci-scripts check-services all install install-node install-bun install-rust install-oxvelte install-wasm-pack install-frontend install-services install-hooks setup-env setup-env-prod local-env dump-prod production production-check build-frontend reload-services test test-gateway test-history test-frontend test-harness test-ci-scripts bench-mls clean run-ci lint-frontend

# Cible par défaut : installation complète et déploiement LOCAL
.DEFAULT_GOAL := all

all: install install-hooks build-frontend reload-services
	@echo ""
	@echo "${BOLD}${GREEN}🎉 INSTALLATION COMPLÈTE TERMINÉE (DEV LOCAL)${RESET}"
	@echo "---------------------------------------------------"
	@echo "${GREEN}✅ Dépendances installées${RESET}"
	@echo "${GREEN}✅ Git hooks configurés${RESET}"
	@echo "${GREEN}✅ Frontend buildé${RESET}"
	@echo "${GREEN}✅ Services Docker rechargés${RESET}"
	@echo "---------------------------------------------------"
	@echo ""

# ── Déploiement Production ────────────────────────────────────────────────────
production: production-check
	@echo ""
	@echo "${BOLD}${BLUE}🚀 DÉPLOIEMENT PRODUCTION${RESET}"
	@echo "---------------------------------------------------"

ifeq ($(OS),Windows_NT)
	@powershell -NoProfile -Command "$$u=(Get-Content infrastructure/.env | Where-Object { $$_.ToString() -match '^GHCR_USERNAME=' } | Select-Object -First 1) -replace '^GHCR_USERNAME=', ''; $$t=(Get-Content infrastructure/.env | Where-Object { $$_.ToString() -match '^GHCR_TOKEN=' } | Select-Object -First 1) -replace '^GHCR_TOKEN=', ''; if (-not [string]::IsNullOrWhiteSpace($$u) -and -not [string]::IsNullOrWhiteSpace($$t)) { $$t | docker login ghcr.io -u $$u --password-stdin | Out-Null; Write-Host '${GREEN}✅ Auth GHCR OK${RESET}' } else { Write-Host '${YELLOW}⚠️  GHCR_USERNAME/GHCR_TOKEN absents dans infrastructure/.env (pull public/local only)${RESET}' }"
else
	@GHCR_U=$$(grep -E '^GHCR_USERNAME=' infrastructure/.env | cut -d= -f2 || true); \
	GHCR_T=$$(grep -E '^GHCR_TOKEN=' infrastructure/.env | cut -d= -f2 || true); \
	if [ -n "$$GHCR_U" ] && [ -n "$$GHCR_T" ]; then \
		echo "$$GHCR_T" | docker login ghcr.io -u "$$GHCR_U" --password-stdin >/dev/null; \
		echo "${GREEN}✅ Auth GHCR OK${RESET}"; \
	else \
		echo "${YELLOW}⚠️  GHCR_USERNAME/GHCR_TOKEN absents dans infrastructure/.env (pull public/local only)${RESET}"; \
	fi
endif

	@echo "${BLUE}📥 Pulling Docker images from GHCR…${RESET}"
	@docker compose -f infrastructure/docker-compose.prod.yml pull || \
		echo "${YELLOW}⚠️  Pull partiel/échoué - tentative de démarrage avec images locales disponibles${RESET}"
	@echo "${BLUE}🛑 Stopping existing containers…${RESET}"
	@docker compose -f infrastructure/docker-compose.prod.yml down --remove-orphans
	@echo "${BLUE}🚀 Starting production services…${RESET}"
	@docker compose -f infrastructure/docker-compose.prod.yml up -d --remove-orphans
	@echo ""
	@echo "${BOLD}${GREEN}✅ DÉPLOIEMENT PRODUCTION TERMINÉ${RESET}"
	@echo "---------------------------------------------------"
	@echo "${GREEN}✅ Configuration validée${RESET}"
	@echo "${GREEN}✅ Images Docker pullées${RESET}"
	@echo "${GREEN}✅ Services démarrés${RESET}"
	@echo "---------------------------------------------------"
	@echo ""
	@echo "${YELLOW}🔍 Vérifier les services :${RESET}"
	@echo "  docker compose -f infrastructure/docker-compose.prod.yml ps"
	@echo ""
	@echo "${YELLOW}📋 Voir les logs :${RESET}"
	@echo "  docker compose -f infrastructure/docker-compose.prod.yml logs -f"
	@echo ""

production-check:
	@echo "${BLUE}🔍 Vérification de la configuration production…${RESET}"

ifeq ($(OS),Windows_NT)
	@if not exist infrastructure\.env ( \
		echo "${YELLOW}⚠️  infrastructure/.env manquant - création depuis le template${RESET}" & \
		powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -Prod & \
		echo "${YELLOW}⚠️  Éditez infrastructure/.env (POSTGRES_PASSWORD, DOMAIN…) puis relancez.${RESET}" & \
		exit /b 1 \
	)
	@powershell -NoProfile -Command "$$prefix = (Get-Content infrastructure/.env | Where-Object { $$_.ToString() -match '^IMAGE_PREFIX=' } | Select-Object -First 1) -replace '^IMAGE_PREFIX=', ''; if ([string]::IsNullOrWhiteSpace($$prefix) -or $$prefix -eq 'your-github-org/canari') { if (Select-String -Path infrastructure/.env -Pattern '^IMAGE_PREFIX=' -Quiet) { (Get-Content infrastructure/.env) -replace '^IMAGE_PREFIX=.*', 'IMAGE_PREFIX=emse-students/canari' | Set-Content infrastructure/.env } else { Add-Content infrastructure/.env 'IMAGE_PREFIX=emse-students/canari' }; Write-Host '${YELLOW}⚠️  IMAGE_PREFIX corrigé vers emse-students/canari${RESET}' }"
	@powershell -NoProfile -Command "$$jwt = (Get-Content infrastructure/.env | Where-Object { $$_.ToString() -match '^JWT_SECRET=' } | Select-Object -First 1) -replace '^JWT_SECRET=', ''; if ([string]::IsNullOrWhiteSpace($$jwt) -or $$jwt -eq 'your-secret-jwt-key-here-change-me') { Write-Host '${RED}❌ JWT_SECRET non configuré dans infrastructure/.env${RESET}'; Write-Host '${BLUE}Générez-en un : openssl rand -hex 32${RESET}'; exit 1 }"
	@powershell -NoProfile -Command "if (Select-String -Path infrastructure/.env -Pattern '^POSTGRES_PASSWORD=change-me-strong-password' -Quiet) { Write-Host '${YELLOW}⚠️  Changez POSTGRES_PASSWORD dans infrastructure/.env${RESET}' }"
	@echo "${GREEN}✅ Configuration validée${RESET}"
else
	@if [ ! -f infrastructure/.env ]; then \
		echo "${YELLOW}⚠️  infrastructure/.env manquant - création depuis le template${RESET}"; \
		chmod +x scripts/setup-env.sh; \
		./scripts/setup-env.sh --prod; \
		echo ""; \
		echo "${YELLOW}⚠️  Éditez infrastructure/.env (POSTGRES_PASSWORD, DOMAIN…) puis relancez.${RESET}"; \
		exit 1; \
	fi
	@PREFIX=$$(grep -E '^IMAGE_PREFIX=' infrastructure/.env | cut -d= -f2 || true); \
	if [ -z "$$PREFIX" ] || [ "$$PREFIX" = "your-github-org/canari" ]; then \
		if grep -q '^IMAGE_PREFIX=' infrastructure/.env; then \
			sed -i.bak 's|^IMAGE_PREFIX=.*|IMAGE_PREFIX=emse-students/canari|' infrastructure/.env; \
			rm -f infrastructure/.env.bak; \
		else \
			echo 'IMAGE_PREFIX=emse-students/canari' >> infrastructure/.env; \
		fi; \
		echo "${YELLOW}⚠️  IMAGE_PREFIX corrigé vers emse-students/canari${RESET}"; \
	fi
	@JWT=$$(grep -E '^JWT_SECRET=' infrastructure/.env | cut -d= -f2 || true); \
	if [ -z "$$JWT" ] || [ "$$JWT" = "your-secret-jwt-key-here-change-me" ]; then \
		echo "${RED}❌ JWT_SECRET non configuré dans infrastructure/.env${RESET}"; \
		echo "${BLUE}Générez-en un : openssl rand -hex 32${RESET}"; \
		exit 1; \
	fi
	@if grep -q '^POSTGRES_PASSWORD=change-me-strong-password' infrastructure/.env; then \
		echo "${YELLOW}⚠️  Changez POSTGRES_PASSWORD dans infrastructure/.env${RESET}"; \
	fi
	@echo "${GREEN}✅ Configuration validée${RESET}"
endif

# Note: le frontend est servi par le container Docker nginx (infrastructure/local/Dockerfile.frontend)
# HTTPS est géré par Cloudflare Tunnel. Pas de nginx externe.

# Détection de l'OS pour la compatibilité
ifeq ($(OS),Windows_NT)
    # Windows
    GREEN :=
    RED :=
    BLUE :=
    BOLD :=
    RESET :=
    CHECK_CMD := where
    NULL_DEV := NUL
    # Sur Windows avec cmd.exe, les structures conditionnelles complexes dans une ligne sont difficiles
    # On simplifie pour utiliser cargo test directement
    RUST_TEST_CMD := cargo test
else
    # Linux / MacOS
    GREEN := $(shell tput -Txterm setaf 2)
    RED := $(shell tput -Txterm setaf 1)
    BLUE := $(shell tput -Txterm setaf 4)
    BOLD := $(shell tput -Txterm bold)
    RESET := $(shell tput -Txterm sgr0)
    CHECK_CMD := command -v
    NULL_DEV := /dev/null
    # Commande avec vérification de coverage
    RUST_TEST_CMD := if command -v cargo-tarpaulin >/dev/null; then \
        echo "   (Coverage enabled via cargo-tarpaulin)"; \
        cargo tarpaulin --out Xml --output-dir coverage; \
    else \
        cargo test; \
    fi
endif

# ── Installation des dépendances ──────────────────────────────────────────────
install: install-node install-bun install-rust install-oxvelte install-wasm-pack install-frontend install-services

# node WITHOUT npm. bun is this repository's package manager everywhere; node survives only as
# the runtime jest needs (see test-history), and `node --run` executes package.json scripts with
# no package manager at all. Checking for npm would fail a machine perfectly able to build and
# test this repo.
ifeq ($(OS),Windows_NT)
install-node:
	@echo "${BLUE}ℹ️ Node.js auto-install skipped on Windows${RESET}"
	@echo "${BLUE}ℹ️ Install manually from: https://nodejs.org/${RESET}"

install-bun:
	@echo "${BLUE}ℹ️ Bun auto-install skipped on Windows${RESET}"
	@echo "${BLUE}ℹ️ Install manually if needed: https://bun.sh/docs/installation${RESET}"

install-rust:
	@echo "${BLUE}ℹ️ Rust auto-install skipped on Windows${RESET}"
	@echo "${BLUE}ℹ️ Install manually from: https://rustup.rs/${RESET}"

install-wasm-pack:
	@echo "${BLUE}ℹ️ wasm-pack auto-install skipped on Windows${RESET}"
	@echo "${BLUE}ℹ️ Install manually, PINNED to the version CI uses: cargo install wasm-pack --locked --version 0.15.0${RESET}"
else
install-node:
	@echo "${BLUE}📦 Checking Node.js installation (runtime for jest only)…${RESET}"
	@if command -v node >/dev/null 2>&1; then \
		echo "${GREEN}✅ Node.js already installed: $$(node --version)${RESET}"; \
	else \
		echo "${BLUE}⬇️ Installing Node.js via nvm…${RESET}"; \
		if [ ! -d "$$HOME/.nvm" ]; then \
			curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash; \
			export NVM_DIR="$$HOME/.nvm"; \
			[ -s "$$NVM_DIR/nvm.sh" ] && \. "$$NVM_DIR/nvm.sh"; \
		else \
			export NVM_DIR="$$HOME/.nvm"; \
			[ -s "$$NVM_DIR/nvm.sh" ] && \. "$$NVM_DIR/nvm.sh"; \
		fi; \
		nvm install --lts; \
		nvm use --lts; \
		echo "${YELLOW}⚠ Open a new shell or run: source ~/.bashrc${RESET}"; \
	fi

install-bun:
	@echo "${BLUE}📦 Checking Bun installation…${RESET}"
	@if command -v bun >/dev/null 2>&1; then \
		echo "${GREEN}✅ Bun already installed: $$(bun --version)${RESET}"; \
	else \
		echo "${BLUE}⬇️ Installing Bun…${RESET}"; \
		curl -fsSL https://bun.sh/install | bash; \
		echo "${YELLOW}⚠ Open a new shell or run: export PATH=\"$$HOME/.bun/bin:$$PATH\"${RESET}"; \
	fi

install-rust:
	@echo "${BLUE}📦 Checking Rust/cargo installation…${RESET}"
	@if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then \
		echo "${GREEN}✅ Rust already installed: $$(rustc --version)${RESET}"; \
		echo "${GREEN}✅ cargo already installed: $$(cargo --version)${RESET}"; \
		rust_version=$$(rustc --version | sed -E 's/rustc ([0-9]+\.[0-9]+\.[0-9]+).*/\1/'); \
		if [ "$$(printf '%s\n%s\n' '1.97.0' "$$rust_version" | sort -V | head -n1)" != "1.97.0" ]; then \
			echo "${YELLOW}⚠ Rust >= 1.97.0 required (oxvelte). Run: rustup update stable${RESET}"; \
		fi; \
	else \
		echo "${BLUE}⬇️ Installing Rust via rustup…${RESET}"; \
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.97.0; \
		. "$$HOME/.cargo/env"; \
		rustup target add wasm32-unknown-unknown; \
		echo "${YELLOW}⚠ Open a new shell or run: source ~/.cargo/env${RESET}"; \
	fi

install-oxvelte:
	@echo "${BLUE}📦 Checking oxvelte installation…${RESET}"
	@sh ./scripts/install-oxvelte.sh

install-wasm-pack:
	@echo "${BLUE}📦 Checking wasm-pack installation…${RESET}"
	@./scripts/install-wasm-pack.sh
endif

install-frontend:
	@echo "${BLUE}📦 Installing frontend dependencies…${RESET}"
	@cd frontend && bun install --frozen-lockfile
	@echo "${BLUE}🔄 Running svelte-kit sync…${RESET}"
	@cd frontend && bunx svelte-kit sync
	@echo "${BLUE}🔄 Generating WASM + protobuf bindings…${RESET}"
	@cd frontend && bun run generate
	@echo "${GREEN}✅ Frontend prêt${RESET}"

install-services:
	@echo "📦 Installing core-service…"
	@cd apps/core-service && bun install --frozen-lockfile
	@echo "📦 Installing social-service…"
	@cd apps/social-service && bun install --frozen-lockfile
	@echo "📦 Installing chat-delivery-service…"
	@cd apps/chat-delivery-service && bun install --frozen-lockfile
	@echo "📦 Installing media-service…"
	@cd apps/media-service && bun install --frozen-lockfile
	@echo "✅ Services Node.js prêts"

# One installer. The four-branch ladder this replaces (bun, then $$HOME/.bun/bin/bun,
# then npm, then nvm+npm) resolved a DIFFERENT dependency tree per branch for the same
# directory - and the npm branches ignored the committed bun.lock entirely, so
# `make install` handed you a frontend unrelated to what CI builds. Which branch fired
# was invisible. If bun is missing, that is the thing to fix, not to route around.
install-hooks:
	@echo "${BLUE}🪝 Installing Git hooks via Husky…${RESET}"
	@cd frontend && bun install --frozen-lockfile
	@echo "${GREEN}✅ Git hooks configurés${RESET}"

# ── Environment & Secrets Management ──────────────────────────────────────────
# Développement : crée frontend/.env + infrastructure/.env avec secrets générés
setup-env:
	@chmod +x scripts/setup-env.sh
	@./scripts/setup-env.sh

# Production : crée uniquement infrastructure/.env (frontend/.env ignoré en prod)
setup-env-prod:
	@chmod +x scripts/setup-env.sh
	@./scripts/setup-env.sh --prod

# ── Local mirroring production (décidé avec l'utilisateur le 2026-09-02) ──────
# `setup-env` ci-dessus fabrique un environnement local avec des secrets GÉNÉRÉS : aucun tiers ne
# répond (ni Stripe, ni FCM, ni MiGallery, ni Authentik). `local-env` fait l'autre chose : il
# reprend les identifiants tiers de la PRODUCTION, régénère les secrets d'authentification, et
# localise la topologie. Les deux sont légitimes ; celui-ci sert à développer contre le vrai monde.
#
# Le snapshot passe par un fichier temporaire hors du dépôt, jamais par le transcript.
local-env:
	@echo "${BLUE}🔐 Fabrication de infrastructure/.env + frontend/.env depuis la production…${RESET}"
	@chmod +x infrastructure/local/env-from-prod.sh
	@snap=$$(mktemp "$${TMPDIR:-/tmp}/canari-prod-env.XXXXXX"); \
	  trap 'rm -f "$$snap"' EXIT; \
	  ssh=$${CANARI_SSH:-$$([ -x /c/WINDOWS/System32/OpenSSH/ssh.exe ] && echo /c/WINDOWS/System32/OpenSSH/ssh.exe || echo ssh)}; \
	  "$$ssh" -o ConnectTimeout=30 -o BatchMode=yes canari 'cat /home/canari/canari/infrastructure/.env' > "$$snap"; \
	  ./infrastructure/local/env-from-prod.sh "$$snap"
	@echo "${GREEN}✅ .env locaux écrits${RESET}"

# Copie la base de production dans la pile locale : dump lecture seule, restauration gardée par un
# ALLOWLIST du projet compose local, effacements partagés avec la copie vers dev, puis vérification.
dump-prod:
	@echo "${BLUE}📦 Copie de la base de production vers la pile locale…${RESET}"
	@chmod +x infrastructure/local/pull-prod-dump.sh infrastructure/local/restore-into-local.sh
	@dump=$$(./infrastructure/local/pull-prod-dump.sh | tail -1); \
	  ./infrastructure/local/restore-into-local.sh "$$dump"
	@echo "${GREEN}✅ Base locale restaurée et vérifiée${RESET}"

# Cible principale
test: test-gateway test-history test-frontend test-harness test-ci-scripts
	@echo ""
	@echo "${BOLD}📊 BILAN DES TESTS${RESET}"
	@echo "---------------------------------------------------"
	@echo "${GREEN}✅ Chat Gateway (Rust)     : PASS${RESET}"
	@echo "${GREEN}✅ Delivery Service (TS)   : PASS${RESET}"
	@echo "${GREEN}✅ Frontend (Vitest)       : PASS${RESET}"
	@echo "${GREEN}✅ Harness self-tests      : PASS${RESET}"
	@echo "---------------------------------------------------"
	@echo ""

# Tests frontend (Vitest - logique de création de conversations)
test-frontend:
	@echo "${BLUE}🧪 Testing Frontend conversation logic…${RESET}"
	@cd frontend && bun run test
	@echo "${GREEN}✅ Frontend tests OK${RESET}"

# Harness self-tests - the three assertions the campaign rig makes about ITSELF.
#
# None of these touches a browser, a phone or production: they are pure assertions over the rig's own
# rules, which is why they belong in `make test` rather than in a phase. All three existed and were
# invoked by NOTHING until 2026-08-22 - mentioned in the wiki, run by hand, and therefore run never.
#
# `classify-selftest` and `srvclassify-selftest` pin every log-classification rule against a line it
# must and must not match; a rule that matches too much has no symptom on a live window, so without
# these a widened pattern silently stops reporting. `checks-selftest` asserts that every phase
# DECLARES the devices its scripts actually drive - the fault that left MUT-18 skipping on every run
# it was ever asked for, blaming the cable instead of a list one file away.
# THE SELF-TESTS FOR THE AUTOMATION ITSELF. `.github/scripts/` decides which dependency updates
# merge with nobody watching, so the predicate behind that decision is tested like any other logic -
# on the inputs a live run never produces, which are the ones that fail closed.
# THE LINT CI RUNS AND THIS MACHINE DID NOT, WHICH IS WHY A PULL REQUEST FOUND IT (2026-09-04).
# `ci.yml` shellchecks exactly this file set and treats even an INFO finding as a failure; nothing
# here ran it, so a self-test file that passed all 19 of its own assertions was refused by the gate
# for `A && B || C` and for a backtick inside a single-quoted string. shellcheck is a single static
# binary and every developer machine that has one can answer this in a second - a gate reachable
# only from a runner is a gate discovered by a red pull request. Skipped with a NAMED line when the
# binary is absent, never silently: a lint that quietly does not run is worse than no lint.
lint-ci-scripts:
	@echo "${BLUE}🧹 shellcheck (the same file set as ci.yml)…${RESET}"
	@if command -v shellcheck >/dev/null 2>&1; then 		shellcheck -x 			.github/scripts/*.sh .github/scripts/lib/*.sh .github/scripts/tests/*.sh 			infrastructure/dev/*.sh infrastructure/deploy/*.sh 			scripts/bump-app-version.sh; 	else 		echo "${YELLOW}⚠️  shellcheck absent - CI WILL still run it (winget install koalaman.shellcheck)${RESET}"; 	fi

test-ci-scripts: lint-ci-scripts
	@echo "${BLUE}🧪 CI script self-tests…${RESET}"
	@bash .github/scripts/tests/ceiling.test.sh
	@bash .github/scripts/tests/compose-wiring.test.sh
	@bash .github/scripts/tests/dev-copy-guards.test.sh
	@bash .github/scripts/tests/dev-gap.test.sh
	@bash .github/scripts/tests/deploy-env.test.sh
	@bash .github/scripts/tests/deploy-migrations.test.sh
	@bash .github/scripts/tests/dependabot-cargo-reach.test.sh
	@bash .github/scripts/tests/dependabot-alerts-report.test.sh
	@bash .github/scripts/tests/bump-version.test.sh
	@bash .github/scripts/tests/bump-staging.test.sh
	@bash .github/scripts/tests/release-preflight.test.sh
	@bash .github/scripts/tests/release-chain.test.sh
	@bash .github/scripts/tests/release-notes-body.test.sh
	@bash .github/scripts/tests/scheduled.test.sh
	@bash .github/scripts/tests/audit-dependencies.test.sh
	@bash .github/scripts/tests/host-update-report.test.sh
	@bun .github/scripts/tests/no-nul-in-source.test.mjs
	@bun .github/scripts/tests/wiki-links.test.mjs
	@bun tools/app-store/submit.test.mjs
	@bun tools/store-divergence/divergence.test.mjs

test-harness:
	@echo "${BLUE}🧪 Harness self-tests…${RESET}"
	@bun tools/cross-client-harness/inventory.mjs --check
	@bun tools/cross-client-harness/archive/rawcheck.mjs
	@bun tools/cross-client-harness/archive/classify-selftest.mjs
	@bun tools/cross-client-harness/archive/srvclassify-selftest.mjs
	@bun tools/cross-client-harness/archive/checks-selftest.mjs
	@bun tools/cross-client-harness/archive/logcatclassify-selftest.mjs
	@bun tools/cross-client-harness/archive/devices-selftest.mjs
	@bun tools/cross-client-harness/archive/debris-selftest.mjs
	@bun tools/cross-client-harness/archive/gate-selftest.mjs
	@bun tools/cross-client-harness/archive/instrument-selftest.mjs
	@bun tools/cross-client-harness/archive/spawn-selftest.mjs
	@bun tools/cross-client-harness/archive/estate-selftest.mjs
	@bun tools/cross-client-harness/archive/exit-selftest.mjs
	@bun tools/cross-client-harness/archive/lucide-selftest.mjs
	@bun tools/cross-client-harness/archive/ports-selftest.mjs
	@bun tools/cross-client-harness/archive/origin-selftest.mjs
	@bun tools/cross-client-harness/archive/ready-selftest.mjs
	@bun tools/cross-client-harness/archive/servable-selftest.mjs
	@bun tools/cross-client-harness/archive/residue-selftest.mjs
	@bun tools/cross-client-harness/archive/gate-probe-selftest.mjs
	@bun tools/cross-client-harness/archive/usability-selftest.mjs
	@echo "${GREEN}✅ Harness self-tests OK${RESET}"

# THE SELF-TESTS THAT NEED THE RIG UP, and therefore not the CI gate. `test-harness` runs on a fresh
# checkout with no devices and no `names.mjs`; this one drives a real browser on W2, so it is run by
# hand when `tabs.mjs`, `chat.mjs` or the preflight's tab repair changes. `gate-selftest.mjs` is what
# stops one of these being added back to the gate, where it can only fail.
test-harness-device:
	@echo "${BLUE}🧪 Harness self-tests needing a live rig…${RESET}"
	@bun tools/cross-client-harness/archive/tabguard-selftest.mjs
	@echo "${GREEN}✅ Device self-tests OK${RESET}"

# Criterion benchmarks for mls-core hot paths (Phase 3 baseline)
bench-mls:
	@echo "${BLUE}📊 Running mls-core Criterion benchmarks…${RESET}"
	@cd frontend/mls-core && cargo bench -p mls-core --bench mls_perf
	@echo "${GREEN}✅ MLS benchmarks done${RESET}"

# Tests Gateway Rust
test-gateway:
	@echo "${BLUE}🧪 Testing Chat Gateway…${RESET}"
	@cd apps/chat-gateway && $(RUST_TEST_CMD)

# Tests Service Historique
# `node --run`, matching `.github/workflows/ci.yml` exactly. These suites are jest, and jest
# under the bun runtime fails `src/controllers/admin-storage.controller.mls.spec.ts` - which
# lives in THIS service, so `bun run` here meant `make test` and the pipeline executed the same
# files on two different runtimes. `node --run` forwards everything after `--` (verified), so
# `--coverage` still reaches jest. No npm: the runtime is the dependency, the package manager
# is not.
test-history:
	@echo "${BLUE}🧪 Testing Chat Delivery Service…${RESET}"
	@cd apps/chat-delivery-service && node --run test -- --coverage

build-frontend:
	@echo "${BLUE}🚀 Building frontend…${RESET}"
	@echo "${BLUE}🔄 Generating WASM + protobuf bindings…${RESET}"
	@cd frontend && bun run generate
	@echo "${BLUE}🔄 Building SvelteKit (adapter-static, la forme TAURI)…${RESET}"
	@cd frontend && bun run build
	@echo "${GREEN}✅ Frontend buildé${RESET}"
	@echo "${YELLOW}ℹ️  Ceci n'est PAS la forme que la pile locale sert : voir 'make local-frontend'${RESET}"

# ── METTRE LE CODE COURANT SUR LA PILE LOCALE ────────────────────────────────────────────────
# LA CIBLE QUI MANQUAIT, ET SON ABSENCE COÛTE UN CONTENEUR MORT (2026-09-04).
#
# `svelte.config.js` choisit adapter-STATIC sauf si `BUILD_WEB` est posé - la polarité est
# volontaire (Tauri par défaut). Les deux images frontend de la pile locale veulent l'autre forme :
# `Dockerfile.frontend-ssr` fait `COPY frontend/build ./` et lance `node index.js`, `Dockerfile.
# frontend` fait `COPY frontend/build/client` et `build/prerendered`. Un `bun run build` nu ne
# produit aucun des trois : l'image se construit sans erreur et le conteneur meurt au démarrage sur
# `Cannot find module '/app/index.js'`. C'est exactement le mode de défaillance que le commentaire
# du `.dockerignore` appelle « le pire possible : un succès ».
#
# Et rebâtir `frontend-ssr` seul ne suffit pas : nginx détient SA copie des assets, donc un client
# rechargé prendrait l'ancien JS avec le nouveau shell. Les deux images, toujours.
#
# ET `VITE_FRONTEND_URL` EST CELLE DE LA PILE, PAS CELLE DU SERVEUR DE DEV. `frontend/.env` est
# généré pour `bun run dev` et y met `http://localhost:1420`, ce qui est juste POUR LUI ; ce build-ci
# est servi par nginx sur 8081. Or `publicAppOrigin()` préfère cette variable à l'origine de la
# fenêtre (il le faut, sinon Tauri partagerait `tauri.localhost`), donc le build héritait de l'URL du
# serveur de dev et TOUT LIEN PARTAGEABLE pointait vers une application qui n'est pas celle qu'on
# utilise. Mesuré le 2026-09-05 par GRP-4 : le lien d'invitation d'un groupe sortait en
# `http://localhost:1420/g/join/<token>`. Une variable, deux consommateurs, deux bonnes réponses -
# celle du consommateur est posée ici.
# La forme est ASSERTÉE, pas espérée : trois chemins, et un échec nomme la variable manquante.
local-frontend:
	@echo "${BLUE}🔄 Building SvelteKit pour la pile locale (BUILD_WEB=1, adapter-node)…${RESET}"
	@cd frontend && BUILD_WEB=1 VITE_FRONTEND_URL=http://localhost:$${CANARI_LOCAL_API_PORT:-8081} bun run build
	@for f in frontend/build/index.js frontend/build/client frontend/build/prerendered; do 	  if [ ! -e "$$f" ]; then 	    echo "${RED}❌ $$f absent : le build n'a pas la forme web. BUILD_WEB=1 a-t-il été pris ?${RESET}"; 	    exit 1; 	  fi; 	done
	@echo "${GREEN}✅ Forme web vérifiée (index.js + client/ + prerendered/)${RESET}"
	@echo "${BLUE}🔄 Rebuild des DEUX images frontend (nginx sert les assets, ssr sert le HTML)…${RESET}"
	@$(LOCAL_COMPOSE) up -d --build frontend-ssr nginx
	@$(MAKE) --no-print-directory check-services
	@echo "${BLUE}ℹ️  Un navigateur déjà ouvert garde l'ancien code : recharger (le harness le fait via bundle.mjs)${RESET}"

# ── LA PILE LOCALE : UN SEUL NOM DE PROJET, ÉCRIT UNE FOIS ───────────────────────────────────
# `docker compose` déduit le nom du projet du DOSSIER du fichier compose, soit `local` - et il
# existe sur cette machine un projet `local` venant d'un ancien checkout (`D:\Documents\...`), avec
# ses propres conteneurs qui lient 3000, 3010, 3012, 3014 et 9092. Sans `-p`, `make run-services`
# faisait donc `down --remove-orphans` puis `up --build` sur CE projet-là, en laissant la vraie pile
# intacte : deux estates, des ports en conflit, et un `docker compose ps` qui ne parle pas de celle
# que le harness interroge. Mesuré le 2026-09-04 - `docker compose ls` listait les deux.
#
# `canari-local` est le nom que la campagne, le harness et toutes les commandes de cette session
# utilisent. Il est ici, une fois, et chaque cible passe par $(LOCAL_COMPOSE).
LOCAL_PROJECT ?= canari-local
LOCAL_COMPOSE = docker compose -p $(LOCAL_PROJECT) -f infrastructure/local/docker-compose.yml --env-file infrastructure/.env

run-services:
	@echo "${BLUE}🚀 Starting services…${RESET}"
	@echo "${BLUE}ℹ️ call-service (SFU) démarré sur le port 3004${RESET}"
	@$(LOCAL_COMPOSE) down --remove-orphans || true
	@$(LOCAL_COMPOSE) up -d --build --remove-orphans
	@$(MAKE) --no-print-directory check-services

# `up -d` REND 0 DÈS QUE LES CONTENEURS SONT LANCÉS, PAS QUAND ILS TIENNENT (2026-09-02).
# Mesuré ce jour-là : trois services NestJS sont sortis en (1) quelques secondes après le
# démarrage - un `dist/` partiel dû à un `.tsbuildinfo` resté dans le contexte Docker - et la
# cible affichait « ✅ Services démarrés ». C'est la règle de la maison appliquée au Makefile :
# un portail vert n'est pas un système qui marche. On laisse le temps de mourir, puis on regarde.
check-services:
	@sleep 8
	@dead=$$($(LOCAL_COMPOSE) ps -a --format '{{.Service}}\t{{.State}}' | awk -F'\t' '$$2 != "running" { print $$1 }'); \
	  if [ -n "$$dead" ]; then \
	    echo "${RED}❌ Services non démarrés :${RESET} $$(echo $$dead | tr '\n' ' ')"; \
	    for s in $$dead; do \
	      echo "${YELLOW}── logs $$s ──${RESET}"; \
	      $(LOCAL_COMPOSE) logs --tail 15 "$$s"; \
	    done; \
	    exit 1; \
	  fi
	@echo "${GREEN}✅ Services démarrés et toujours vivants${RESET}"

reload-services:
	@echo "${BLUE}🔄 Reloading services…${RESET}"
	@$(LOCAL_COMPOSE) down --remove-orphans && \
		$(LOCAL_COMPOSE) up -d --build --remove-orphans
	@echo "${GREEN}✅ Services rechargés${RESET}"

reset-services:
	@echo "${BLUE}🔄 Resetting services (stop + remove volumes)…${RESET}"
	@$(LOCAL_COMPOSE) down -v --remove-orphans && \
		$(LOCAL_COMPOSE) up -d --build --remove-orphans
	@echo "${GREEN}✅ Services reset${RESET}"

reset-services-prod: production-check
	@echo "${BLUE}🔄 Resetting services (stop + remove volumes)…${RESET}"
	@docker compose -f infrastructure/docker-compose.prod.yml --env-file infrastructure/.env down -v --remove-orphans && \
		( docker compose -f infrastructure/docker-compose.prod.yml --env-file infrastructure/.env pull || \
		  echo "${YELLOW}⚠️  Pull partiel/échoué - tentative de démarrage avec images locales disponibles${RESET}" ) && \
		docker compose -f infrastructure/docker-compose.prod.yml --env-file infrastructure/.env up -d --remove-orphans
	@echo "${GREEN}✅ Services reset${RESET}"

update-services-prod: production-check
	@echo "${BLUE}🔄 Updating services…${RESET}"
	@docker compose -f infrastructure/docker-compose.prod.yml --env-file infrastructure/.env pull
	@docker compose -f infrastructure/docker-compose.prod.yml --env-file infrastructure/.env up -d --remove-orphans
	@echo "${GREEN}✅ Services rechargés${RESET}"

# ── CI Pipeline ──────────────────────────────────────────────────────────────
# Runs all checks locally: Rust tests, TS type-check, frontend lint, frontend build.
# Usage: make run-ci
run-ci: lint-frontend test
	@echo ""
	@echo "${BOLD}${GREEN}✅ CI COMPLETE - tous les checks ont passé${RESET}"
	@echo ""

lint-frontend:
	@echo "${BLUE}🧹 Type-checking & linting frontend…${RESET}"
	@cd frontend && bun run check && bun run lint && bun run format:check
	@echo "${GREEN}✅ Frontend type-check + lint OK${RESET}"

