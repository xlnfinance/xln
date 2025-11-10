# dual repo strategy - public showcase + private reality

**Pattern:** Linux (public kernel + Red Hat/SUSE internal), Android (AOSP + Google), Chrome (Chromium + Chrome)

---

## structure

### public repo: xlnfinance/xln (GitHub)
**Purpose:** Attract talent, showcase quality, build community

**Contains:**
- ✅ Production code (runtime/, jurisdictions/, frontend/)
- ✅ Public documentation (vibepaper/, CLAUDE.md, README.md)
- ✅ Tests (frontend/tests/, but not _reports/)
- ✅ MIT/Apache license
- ❌ No _reports/ (competitive intelligence)
- ❌ No _scripts/ (deployment secrets)
- ❌ No _research/ (experimental features)

**Audience:**
- Potential contributors (open source developers)
- Investors (VC due diligence)
- Researchers (academic citations)
- Competitors (they'll fork it anyway)

---

### private repo: egor/_xln or self-hosted
**Purpose:** Real work, strategic planning, sensitive analysis

**Contains:**
- ✅ Everything from public repo
- ✅ _reports/ (SEO, testing, architecture audits)
- ✅ _scripts/ (deployment, monitoring, CI/CD)
- ✅ _research/ (experimental consensus algorithms)
- ✅ Competitive intelligence
- ✅ Strategic roadmaps

**Audience:**
- Egor Homakov (owner)
- Future: Core team (2-3 people max)

---

## workflow

### day-to-day development
```bash
# Work in private repo
cd ~/xln  # This is the private version

# Normal git workflow
git add .
git commit -m "feat: new feature"
git push origin main

# _reports/ automatically ignored by .gitignore for public
```

### when ready for public release
```bash
# Option A: Manual sync (simple)
cd ~/xln-public  # Separate clone of public repo
git pull ~/xln main  # Pull from private
# _reports/ won't be included (gitignored)
git push origin main  # Push to public GitHub

# Option B: Automated sync (future)
./sync-to-public.sh  # Filters _* directories, pushes to xlnfinance/xln
```

---

## what goes where?

| Item | Public | Private | Reason |
|------|--------|---------|--------|
| runtime.ts | ✅ | ✅ | Core code = showcase quality |
| Depository.sol | ✅ | ✅ | Smart contracts = open source |
| vibepaper/ | ✅ | ✅ | Architecture docs = attract talent |
| CLAUDE.md | ✅ | ✅ | Shows how we work = transparency |
| _reports/seo/ | ❌ | ✅ | Competitive analysis = private |
| _scripts/deploy.sh | ❌ | ✅ | Server secrets = private |
| _research/ | ❌ | ✅ | Experiments = wait until proven |
| BUG_PREVENTION.md | ✅ | ✅ | Shows process maturity |
| LAUNCH_CHECKLIST.md | ✅ | ✅ | Shows we care about quality |

**Rule:** If you're unsure → put in private first, publish later.

---

## benefits

### public repo benefits
1. **Recruiting** - Devs see quality code, want to contribute
2. **SEO** - GitHub indexed by Google, backlinks to xln.finance
3. **Credibility** - "Open source" = trustworthy in crypto
4. **Community** - External contributors find bugs, suggest features

### private repo benefits
1. **Competitive advantage** - Strategies not visible to competitors
2. **Security** - Deployment scripts, server configs private
3. **Honesty** - Can write "this sucks, need to fix" without PR damage
4. **Speed** - No need to "clean up" for public consumption

---

## security considerations

### what NOT to commit (even to private)
- ❌ API keys, passwords, private keys
- ❌ .env files (use .env.example instead)
- ❌ SSH keys (use ssh-agent)
- ❌ Customer data

### how to handle secrets
```bash
# Good: Environment variables
export DATABASE_URL="postgres://..."
bun run server.ts

# Bad: Hardcoded in code
const db = "postgres://user:pass@host"  # ❌ Never do this
```

---

## migration to self-hosted (future)

**Timeline:** Q1 2026

**Plan:**
1. Set up Gitea/GitLab on your servers
2. Migrate private repo there
3. Keep public repo on GitHub (for visibility)
4. Use GitHub as "mirror" of release branches

**Benefits:**
- Full control (no Microsoft/GitHub dependency)
- Unlimited private repos
- Custom CI/CD pipelines
- Better security (on your infrastructure)

**Tools:**
- Gitea (lightweight, Go-based)
- GitLab CE (feature-rich, heavier)
- cgit (minimalist, C-based)

---

## automation

### claude generates reports
```bash
# After SEO audit
claude → creates _reports/seo/2025-11-07-audit.md
→ git commit -m "report: SEO audit"
→ git push origin main (private repo)
```

### sync to public (automated)
```bash
# Cron job: daily at 2am
0 2 * * * cd ~/xln && ./sync-to-public.sh
```

### ci/cd
```bash
# Private repo: Full tests + deploy
push to private → tests → deploy to xln.finance

# Public repo: Tests only (no deploy)
push to public → tests → report status
```

---

## communication

### what to say publicly
- "We're open source" ✅
- "Check out our GitHub" ✅
- "Here's our architecture" ✅

### what NOT to say publicly
- "We have a private repo with _reports/" ❌
- "Our SEO strategy is..." ❌
- "We're working on X before announcing" ❌

**Rule:** Assume competitors read everything public.

---

## example workflow

```bash
# Monday morning: Planning session
cd ~/xln  # Private repo
claude generates: _reports/architecture/2025-11-11-week-plan.md
git commit -m "report: week plan"

# Monday-Friday: Development
# Work in private repo, commit frequently
git commit -m "feat: add nonce replay protection"
git commit -m "test: add bilateral consensus test"
git commit -m "fix: optimize force-directed layout"

# Friday evening: Sync to public
./sync-to-public.sh
# Pushes code changes to xlnfinance/xln
# Excludes _reports/ automatically

# Weekend: Public repo gets stars, forks, issues
# Monday: Review public feedback, incorporate into private
```

---

## best practices

1. **Commit early, commit often** (in private)
2. **Write honest comments** ("TODO: this is janky")
3. **Document decisions** in _reports/architecture/
4. **Sync to public weekly** (not daily = too noisy)
5. **Use issues publicly** (for community engagement)
6. **Use _reports/ privately** (for strategy)

---

## faq

**Q: What if someone forks the public repo?**
A: That's fine. They get the code but not the strategy (_reports/).

**Q: What if a competitor reads this file?**
A: This file is in private repo (_*). They won't see it.

**Q: Should we ever make _reports/ public?**
A: Maybe in 2027 when we're established. Linux published their internal emails after 10 years.

**Q: What about NDAs?**
A: Anything under NDA goes in private repo only. Never push to public.

---

**Last updated:** 2025-11-07
**Maintained by:** Egor + Claude
**Next review:** After first public release
