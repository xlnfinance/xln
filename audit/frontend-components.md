# Frontend Components Security Audit

**Date**: 2026-01-27
**Auditor**: Claude Opus 4.5
**Scope**: `/frontend/src/lib/components/` and `/frontend/src/lib/view/`

---

## Executive Summary

Overall security posture is **MODERATE** with some areas requiring attention. The codebase demonstrates awareness of security concerns (autocomplete=off on sensitive fields, blurred mnemonic display, copy-to-clipboard patterns). However, several XSS vectors exist via `{@html}` usage, and some sensitive data handling could be improved.

**Key Findings**:
- 18 instances of `{@html}` usage, some rendering i18n content (controlled) but one rendering markdown from external files (P1)
- Mnemonic/key display uses appropriate blur/reveal patterns
- Forms use `autocomplete="off"` on sensitive fields
- No obvious input sanitization on user-provided addresses/amounts (relying on ethers.js validation)
- Error messages truncated but may still leak sensitive paths/data

---

## Critical (P0 - XSS/Key Exposure)

- [ ] **No critical issues found**
  - Private keys are not logged to console
  - Mnemonics are properly hidden by default with reveal buttons
  - No direct `innerHTML` assignments found

---

## High (P1)

- [ ] **DocsView.svelte:170 - Markdown XSS Vector**
  - `{@html renderedHtml}` renders markdown files fetched from `/docs-static/`
  - Uses `marked` library without explicit sanitization
  - **Risk**: If malicious markdown is placed in docs-static, XSS is possible
  - **File**: `/Users/zigota/xln/frontend/src/lib/components/Views/DocsView.svelte`
  - **Recommendation**: Use `marked` with `sanitize: true` or DOMPurify

- [ ] **NetworkLegend.svelte:16 - Template Injection**
  - `{@html \`<img src="${device.icon}" alt="${device.name}" />\`}`
  - While `device` comes from hardcoded array, pattern is dangerous
  - **File**: `/Users/zigota/xln/frontend/src/lib/components/Landing/NetworkLegend.svelte`
  - **Recommendation**: Use Svelte's native `<img>` binding instead

- [ ] **LandingPage.svelte - 17 instances of {@html}**
  - Lines 255, 258-261, 265, 267, 273, 364, 408, 495, 507, 514, 521, 645-646, 667
  - All render from `c.` (i18n content object)
  - **Risk**: If i18n JSON is compromised/user-editable, XSS possible
  - **File**: `/Users/zigota/xln/frontend/src/lib/components/Landing/LandingPage.svelte`
  - **Recommendation**: Review i18n loading chain for injection points

- [ ] **Error messages may leak sensitive data**
  - `ErrorDisplay.svelte:22-24` and `ErrorPopup.svelte:50-51` stringify error objects
  - Error messages are truncated to 200 chars but may still contain paths/keys
  - **Files**:
    - `/Users/zigota/xln/frontend/src/lib/components/Common/ErrorDisplay.svelte`
    - `/Users/zigota/xln/frontend/src/lib/components/Common/ErrorPopup.svelte`
  - **Recommendation**: Scrub sensitive patterns (private keys, file paths) from error display

---

## Medium (P2)

- [ ] **WalletView.svelte:21 - Private key passed as prop**
  - `export let privateKey: string;`
  - Private key flows through component tree as a prop
  - **Risk**: Accidental logging, React DevTools exposure if debugging enabled
  - **File**: `/Users/zigota/xln/frontend/src/lib/components/Wallet/WalletView.svelte`
  - **Recommendation**: Consider a secure vault store pattern with getter functions

- [ ] **ERC20Send.svelte - No CSRF token on transactions**
  - Transaction signing has no explicit CSRF protection
  - Relies on private key being required (acceptable for wallet apps)
  - **File**: `/Users/zigota/xln/frontend/src/lib/components/Wallet/ERC20Send.svelte`
  - **Note**: Low risk for wallet apps, but add nonce if server-side signing added

- [ ] **XLNSend.svelte:113 - Error message leakage**
  - `errorMessage = err instanceof Error ? err.message : 'Transfer failed';`
  - Raw error messages displayed to user
  - **File**: `/Users/zigota/xln/frontend/src/lib/components/Wallet/XLNSend.svelte`
  - **Recommendation**: Map errors to user-friendly messages

- [ ] **DepositToEntity.svelte:184,226 - Raw error display**
  - `error = e.message || 'Approve failed';`
  - Contract revert reasons may contain sensitive info
  - **File**: `/Users/zigota/xln/frontend/src/lib/components/Wallet/DepositToEntity.svelte`

- [ ] **ConsolePanel.svelte:401 - Stack trace exposure**
  - `<pre>{log.stack}</pre>` displays full stack traces
  - **File**: `/Users/zigota/xln/frontend/src/lib/view/panels/ConsolePanel.svelte`
  - **Note**: Acceptable for developer panel, but should be disabled in production

- [ ] **WalletSettings.svelte - Seed phrase copy-to-clipboard**
  - Lines 85-89: Seed phrase can be copied to clipboard
  - Clipboard contents persist and may be accessible to other apps
  - **File**: `/Users/zigota/xln/frontend/src/lib/components/Settings/WalletSettings.svelte`
  - **Recommendation**: Clear clipboard after short timeout, warn users

- [ ] **BrainVaultView.svelte:1447-1449 - Password generator domain input**
  - User-provided domain used in key derivation
  - No validation on domain format
  - **File**: `/Users/zigota/xln/frontend/src/lib/components/Views/BrainVaultView.svelte`
  - **Recommendation**: Validate domain format to prevent injection

---

## Component Security Patterns

### Good Patterns Found

1. **Mnemonic blur/reveal pattern** (BrainVaultView.svelte:1386-1398)
   - Mnemonics hidden by default with visual blur
   - Explicit "reveal" button with user action required
   - Word-by-word display with numbering

2. **Sensitive field autocomplete disabled** (BrainVaultView.svelte:979,995,1102)
   ```html
   autocomplete="off"
   spellcheck="false"
   ```

3. **Copy feedback pattern** (WalletView.svelte:41-44)
   - Visual confirmation of clipboard action
   - Timeout to reset copy state

4. **External link security** (WalletView.svelte:178)
   ```html
   target="_blank"
   rel="noopener noreferrer"
   ```

5. **Address validation** (ERC20Send.svelte:54)
   - Uses ethers.js `isAddress()` for validation
   - Visual feedback for invalid addresses

6. **Error message truncation** (ErrorPopup.svelte:59)
   - Messages limited to 200 chars

7. **Secure identicon generation** (BrainVaultView.svelte:48-99)
   - Deterministic from address, no external requests
   - SVG generated locally and base64 encoded

### Patterns to Adopt

1. **DOMPurify for HTML content**
   - Wrap all `{@html}` usage with sanitization

2. **Secure storage for sensitive data**
   - Use Web Crypto API for key storage
   - Consider IndexedDB with encryption

3. **Input rate limiting**
   - Add debounce to transaction forms

4. **Clipboard timeout**
   - Clear clipboard after 60s when sensitive data copied

---

## Files Reviewed

### Security-Critical Components
| File | Lines | Risk Areas |
|------|-------|------------|
| `/frontend/src/lib/components/Views/BrainVaultView.svelte` | ~2000+ | Mnemonic display, key derivation, password generator |
| `/frontend/src/lib/components/Wallet/WalletView.svelte` | 560 | Private key prop, copy-to-clipboard |
| `/frontend/src/lib/components/Wallet/ERC20Send.svelte` | 1057 | Transaction signing, error handling |
| `/frontend/src/lib/components/Wallet/XLNSend.svelte` | 442 | Reserve transfers, error display |
| `/frontend/src/lib/components/Wallet/DepositToEntity.svelte` | 631 | Contract interactions |
| `/frontend/src/lib/components/Wallet/TokenList.svelte` | 512 | Balance display |
| `/frontend/src/lib/components/Settings/WalletSettings.svelte` | 1096 | Seed reveal, network config |

### XSS-Relevant Components
| File | {@html} Count | Source |
|------|---------------|--------|
| `/frontend/src/lib/components/Views/DocsView.svelte` | 1 | Markdown files |
| `/frontend/src/lib/components/Landing/LandingPage.svelte` | 17 | i18n content |
| `/frontend/src/lib/components/Landing/NetworkLegend.svelte` | 1 | Hardcoded array |

### Error Handling Components
| File | Pattern |
|------|---------|
| `/frontend/src/lib/components/Common/ErrorDisplay.svelte` | Console error capture |
| `/frontend/src/lib/components/Common/ErrorPopup.svelte` | Error toast display |
| `/frontend/src/lib/view/panels/ConsolePanel.svelte` | Developer console |

---

## Recommendations Summary

1. **Immediate**: Add DOMPurify to DocsView markdown rendering
2. **Short-term**: Replace `{@html}` in NetworkLegend with native Svelte
3. **Short-term**: Add clipboard timeout for seed phrase copying
4. **Medium-term**: Audit i18n content loading for injection risks
5. **Medium-term**: Create error message sanitization utility
6. **Long-term**: Consider secure enclave pattern for key storage

---

## Appendix: Grep Commands Used

```bash
# Find {@html} usage
grep -rn '{@html' frontend/src/lib/

# Find innerHTML usage
grep -rn 'innerHTML' frontend/src/lib/

# Find autocomplete settings
grep -rn 'autocomplete' frontend/src/lib/
```
