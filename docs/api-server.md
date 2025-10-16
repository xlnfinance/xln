# XLN Comparative Analysis API

Simple Bun server for collecting crowdsourced AI model evaluations of XLN.

## Usage

### Start the API server

```bash
bun api-server.ts
```

Server runs on `http://localhost:3001`

### Endpoints

- `POST /api/submit` - Submit new evaluation
- `GET /api/results` - Get approved results
- `GET /api/pending` - Get pending submissions (admin)
- `POST /api/approve/:id` - Approve submission (admin)

### Data Files

- `data/pending-submissions.json` - Moderation queue
- `data/comparative-results.json` - Approved results
- `frontend/static/comparative-results.json` - Published results (auto-synced on approval)

## Workflow

1. User runs superprompt in ChatGPT/Claude/Gemini
2. User submits via landing page form (paste response + optional share link)
3. API validates format and adds to pending queue
4. Admin reviews at `/api/pending`
5. Admin approves via `/api/approve/:id`
6. Results auto-sync to `frontend/static/comparative-results.json`
7. Charts update on next page load

## Production Deployment

Add to systemd service or PM2:

```bash
# Using PM2
pm2 start api-server.ts --name xln-api --interpreter bun

# Or systemd
/etc/systemd/system/xln-api.service
```

Then add nginx proxy in production config:

```nginx
location /api/ {
    proxy_pass http://localhost:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

## Security Notes

- Currently no authentication on /api/submit (rate limiting recommended)
- Admin endpoints (/api/pending, /api/approve) need auth before production
- Consider adding IP-based rate limiting
- Validate submission length (<10MB)
