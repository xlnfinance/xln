# repo structure - private (real work) vs public (showcase)

---

## current setup

```
~/xln/  ← THIS IS THE PRIVATE REPO (all real work here)
├── reports/           ← PRIVATE: SEO, testing, architecture analysis
├── scripts/           ← PRIVATE: deployment, monitoring, automation
├── research/          ← PRIVATE: experimental features, not ready yet
├── runtime/           ← PUBLIC: Core protocol code
├── jurisdictions/     ← PUBLIC: Smart contracts
├── frontend/          ← PUBLIC: UI (with tests)
├── vibepaper/         ← PUBLIC: Documentation
├── .archive/          ← PRIVATE: Old implementations (reference only)
├── CLAUDE.md          ← PUBLIC: How we work (transparency)
└── LAUNCH_CHECKLIST.md ← PUBLIC: Quality standards

root@xln.finance:/root/xln ← Production server (deploys from THIS repo)
```

---

## what goes where

| Directory | Private | Public | Production Server | Purpose |
|-----------|---------|--------|-------------------|---------|
| runtime/ | ✅ | ✅ | ✅ | Core protocol (show quality) |
| jurisdictions/ | ✅ | ✅ | ✅ | Smart contracts (open source) |
| frontend/ | ✅ | ✅ | ✅ | UI + tests |
| vibepaper/ | ✅ | ✅ | ❌ | Docs (not needed on server) |
| reports/ | ✅ | ❌ | ❌ | Internal analysis |
| scripts/ | ✅ | ❌ | ❌ | Deployment scripts |
| research/ | ✅ | ❌ | ❌ | Experiments |
| .archive/ | ✅ | ❌ | ❌ | Old code for reference |
| CLAUDE.md | ✅ | ✅ | ❌ | Process transparency |

---

## file structure

### private repo (~/xln - THIS ONE)

```
xln/
├── reports/                    # Internal analysis (gitignored for public)
│   ├── 2025-11-07-seo-audit.md
│   ├── 2025-11-08-test-results.md
│   └── 2025-11-15-architecture-review.md
│
├── scripts/                    # Private automation (gitignored)
│   ├── deploy.sh              # Server deployment
│   ├── monitor.sh             # Health checks
│   └── sync-to-public.sh      # Mirror to xlnfinance/xln
│
├── research/                   # Experiments (gitignored)
│   ├── quadtree-optimization/
│   └── zk-proofs-poc/
│
├── runtime/                    # PUBLISHED
│   ├── runtime.ts
│   ├── entity-consensus.ts
│   └── account-consensus.ts
│
├── jurisdictions/              # PUBLISHED
│   ├── Depository.sol
│   ├── EntityProvider.sol
│   └── SubcontractProvider.sol
│
├── frontend/                   # PUBLISHED
│   ├── src/
│   ├── tests/
│   └── static/
│
├── vibepaper/                  # PUBLISHED
│   ├── readme.md
│   └── jea.md
│
├── .archive/                   # PRIVATE (old reference code)
│   └── 2024_src/
│
├── CLAUDE.md                   # PUBLISHED (process transparency)
├── LAUNCH_CHECKLIST.md         # PUBLISHED (quality standards)
└── README.md                   # PUBLISHED (project overview)
```

### public repo (xlnfinance/xln on GitHub)

```
xln/
├── runtime/           # Same as private
├── jurisdictions/     # Same as private
├── frontend/          # Same as private
├── vibepaper/         # Same as private
├── CLAUDE.md          # Same as private
├── README.md          # Same as private
└── LICENSE            # MIT/Apache

NO reports/, scripts/, research/, .archive/
```

---

## deployment flow

### current (works, but needs verification)

```bash
# Local development (private repo)
cd ~/xln
git add .
git commit -m "feat: something"
git push origin main

# Production server
root@xln.finance:/root/xln
# Pulls from github.com/xlnfinance/xln (currently points here?)
# Needs to verify it's pulling from correct repo
```

### what needs to happen

```bash
# Option A: Server stays private (RECOMMENDED)
root@xln.finance:/root/xln ← Keep pulling from private repo
# Public repo is just a mirror for show

# Option B: Server uses public
# Need to ensure auto-deploy.sh filters out reports/ scripts/ research/
# Before pushing to public
```

---

## sync workflow

### manual sync (for now)

```bash
# Work in private repo
cd ~/xln
git add .
git commit -m "feat: new feature"
git push origin main

# Auto-deployed to xln.finance (server pulls from private)

# When ready to show publicly:
git push github-public main  # reports/ scripts/ research/ auto-filtered by .gitignore
```

### automated sync (future)

```bash
# scripts/sync-to-public.sh
#!/bin/bash
cd ~/xln
git push private main        # Push to private (server uses this)
git push public main         # Mirror to public (gitignored files excluded)
```

---

## gitignore strategy

**.gitignore (private repo):**
```
# Normal stuff
node_modules/
.env
build/

# Private files (excluded from public mirror)
reports/
scripts/
research/
```

**When you push to public:** Git automatically excludes gitignored files = public repo never sees reports/ scripts/ research/

---

## server setup verification

**Need to check:**
```bash
ssh root@xln.finance

# Check current git remote
cd /root/xln
git remote -v
# Should show: origin = private repo (NOT xlnfinance/xln)

# Check deployment script
cat auto-deploy.sh
# Should pull from private repo
```

---

## migration plan

### immediate (today)
1. ✅ Move _reports → reports
2. ✅ Move _scripts → scripts
3. ✅ Move _research → research
4. ✅ Update .gitignore
5. ⏳ Verify server deployment source

### short-term (this week)
6. Setup second remote: `git remote add public git@github.com:xlnfinance/xln.git`
7. Create sync script: `scripts/sync-to-public.sh`
8. Test sync (dry run)
9. First public push (filtered)

### long-term (Q1 2026)
10. Self-hosted Gitea
11. Private on your servers
12. Public stays on GitHub (mirror only)

---

## commands

```bash
# Check what's ignored
git status --ignored

# See what would be pushed to public
git ls-files | grep -v reports/ | grep -v scripts/ | grep -v research/

# Verify server setup
ssh root@xln.finance "cd /root/xln && git remote -v && pwd"
```

---

## analogy

**Linux kernel:**
- Public: kernel.org (everyone sees)
- Private: Red Hat patches (competitive advantage)
- Servers: Run private versions

**XLN:**
- Public: xlnfinance/xln (attract talent)
- Private: ~/xln (real work)
- Server: Runs private version

---

## security

**Never commit to ANY repo:**
- .env files
- Private keys
- API secrets
- Customer data

**Private repo CAN contain:**
- Strategic plans (reports/)
- Deployment scripts (scripts/)
- Experimental code (research/)
- Competitive analysis

**Public repo ONLY contains:**
- Production code
- Public documentation
- Open source license

---

**Last updated:** 2025-11-07
**Maintained by:** Egor + Claude
