# Deployment & Scripts Audit

## Executive Summary

The deployment infrastructure uses environment variables for secrets (good), but has several concerning patterns: hardcoded server IPs, hardcoded contract addresses in test scripts, SSH key references without rotation policies, and no clear separation between dev/staging/prod configurations. The deployment process is largely reproducible but lacks safeguards against accidental production deployments.

**Risk Level: MEDIUM-HIGH** - No critical secrets are hardcoded, but operational security gaps exist.

---

## Critical (P0 - Production risk)

- [ ] **Hardcoded Production Server IP** - `scripts/deployment/deploy-to-vultr.sh:9` and `scripts/deployment/deploy-bun.sh:8` hardcode `136.244.85.89`
  - Risk: Easy to accidentally target production server
  - Fix: Use environment variables with explicit confirmation prompts

- [ ] **SSH Key Path Hardcoded** - `auto-deploy.sh:7` uses `~/.ssh/xln_deploy`
  - Risk: Assumes specific key exists, no key rotation mechanism
  - Fix: Use SSH agent or environment variable for key path

- [ ] **Root SSH Access to Production** - All deployment scripts use `root@server`
  - Risk: Excessive privileges, no audit trail
  - Fix: Use dedicated deploy user with limited sudo

---

## High (P1)

- [ ] **Hardcoded Contract Address in Test Script** - `jurisdictions/scripts/test-deployed-contract.cjs:4`
  ```javascript
  const contractAddress = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
  ```
  - Risk: Test will silently pass/fail on wrong contract
  - Fix: Read from deployment artifacts or environment

- [ ] **No Mainnet Deployment Confirmation** - `deploy-base.cjs` deploys to mainnet without explicit confirmation
  - Risk: Accidental mainnet deployment possible
  - Fix: Add interactive confirmation for non-testnet networks

- [ ] **Auto-commit on Deploy** - `scripts/deployment/deploy-to-vultr.sh:76-79`
  ```bash
  git add .
  git commit -m "Auto-commit before deployment - $(date)"
  ```
  - Risk: Can commit unintended changes, sensitive files
  - Fix: Remove auto-commit or use explicit file list

- [ ] **Private Key via Environment Variable** - `jurisdictions/hardhat.config.cjs:39,44`
  ```javascript
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  ```
  - Current state: Acceptable for CLI use
  - Risk: Easy to leak in CI logs, shell history
  - Improvement: Consider using hardware wallet or key management service for mainnet

---

## Medium (P2)

- [ ] **No Deployment Lock Mechanism** - Multiple developers could deploy simultaneously
  - Fix: Add deployment lock file or CI/CD mutex

- [ ] **Missing HTTPS Enforcement** - Nginx config serves HTTP without forced redirect
  - Location: `scripts/deployment/setup-server.sh:177-229`
  - Fix: Add HTTPS redirect block

- [ ] **Aggressive Cache Clearing** - `deploy-contracts.sh:64-69` removes all build artifacts
  - Risk: Longer builds, potential inconsistency if interrupted
  - Fix: Use incremental builds where possible

- [ ] **Default Hardhat Address Detection** - `scripts/dev/dev.sh:41`
  ```bash
  default_hardhat="0x5FbDB2315678afecb367f032d93F642f64180aa3"
  ```
  - Risk: Could mask deployment failures if this address happens to exist
  - Fix: Use deployment receipts, not address comparisons

- [ ] **API Keys in Environment** - `scripts/news-cron.ts:89,630` expects `ANTHROPIC_API_KEY`
  - Current state: Acceptable pattern
  - Risk: Needs .env.example file to document required variables

- [ ] **UFW Force Reset** - `scripts/deployment/setup-server-bun.sh:206`
  ```bash
  ufw --force reset >/dev/null
  ```
  - Risk: Could lock out administrator if SSH rule fails
  - Fix: Test SSH connectivity before firewall changes

---

## Low (P3)

- [ ] **Magic Port Numbers** - 8545, 8546, 8547 hardcoded throughout
  - Fix: Centralize port configuration

- [ ] **No Version Pinning for External Tools** - `curl | bash` patterns for Bun/Node install
  - Fix: Pin to specific versions for reproducibility

- [ ] **Logs Not Rotated** - Logs go to `logs/` without rotation config
  - Fix: Add logrotate configuration

---

## Deployment Process Review

### Is it safe?
**Partially.** The use of environment variables for secrets is correct. However:
1. No deployment confirmation for production
2. No deployment audit trail
3. Root access used instead of limited deploy user
4. Auto-commit could leak sensitive changes

### Is it reproducible?
**Mostly.** Good aspects:
- Contract compilation with `--force` flag
- Fresh cache clearing before deployment
- R2R smoke test validates deployment

Concerns:
- External tool versions not pinned (Bun, Node)
- No Dockerfile or infrastructure-as-code
- `npm` mixed with `bun` in some places (`frontend/package.json` scripts)

### Recommended Improvements

1. **Add deployment confirmation prompt for mainnet**
   ```bash
   if [[ "$NETWORK" == "base-mainnet" ]]; then
     read -p "Deploy to MAINNET? Type 'yes-mainnet' to confirm: " confirm
     [[ "$confirm" != "yes-mainnet" ]] && exit 1
   fi
   ```

2. **Create `.env.example`** documenting required variables:
   ```
   DEPLOYER_PRIVATE_KEY=  # For mainnet/testnet deployment
   BASE_SEPOLIA_RPC=      # Optional: custom RPC
   ANTHROPIC_API_KEY=     # For news cron
   ```

3. **Use dedicated deploy user** instead of root

4. **Add deployment lock file** to prevent concurrent deploys

---

## Files Reviewed

### Shell Scripts (root)
- `/Users/zigota/xln/deploy.sh` - Main deployment script
- `/Users/zigota/xln/auto-deploy.sh` - SSH-based auto deployment
- `/Users/zigota/xln/deploy-contracts.sh` - Contract deployment orchestrator
- `/Users/zigota/xln/bootstrap.sh` - One-liner installer
- `/Users/zigota/xln/dev-full.sh` - Development environment setup
- `/Users/zigota/xln/reset-networks.sh` - Network reset script

### Deployment Scripts
- `/Users/zigota/xln/scripts/deployment/deploy-to-vultr.sh` - Vultr deployment
- `/Users/zigota/xln/scripts/deployment/deploy-bun.sh` - Bun-based deployment
- `/Users/zigota/xln/scripts/deployment/setup-server.sh` - Server provisioning
- `/Users/zigota/xln/scripts/deployment/setup-server-bun.sh` - Bun server setup
- `/Users/zigota/xln/scripts/deployment/deploy-direct.cjs` - Direct contract deploy

### Development Scripts
- `/Users/zigota/xln/scripts/dev/dev.sh` - Dev environment check
- `/Users/zigota/xln/scripts/dev/start-networks.sh` - Start local blockchains
- `/Users/zigota/xln/scripts/dev/stop-networks.sh` - Stop local blockchains

### Contract Deployment
- `/Users/zigota/xln/jurisdictions/scripts/deploy-entity-provider.cjs` - EntityProvider deploy
- `/Users/zigota/xln/jurisdictions/scripts/deploy-base.cjs` - Base chain deployment
- `/Users/zigota/xln/jurisdictions/scripts/test-base-connection.cjs` - Connection test
- `/Users/zigota/xln/jurisdictions/scripts/test-deployed-contract.cjs` - Contract verification
- `/Users/zigota/xln/jurisdictions/scripts/verify-contract-functions.cjs` - Function verification

### Configuration
- `/Users/zigota/xln/jurisdictions/hardhat.config.cjs` - Hardhat network config
- `/Users/zigota/xln/package.json` - NPM scripts
- `/Users/zigota/xln/.gitignore` - Confirms .env files excluded

---

## Summary Table

| Category | Count | Status |
|----------|-------|--------|
| Critical (P0) | 3 | Needs immediate attention |
| High (P1) | 4 | Should fix before production |
| Medium (P2) | 6 | Plan to fix |
| Low (P3) | 3 | Nice to have |

**Total Issues: 16**
