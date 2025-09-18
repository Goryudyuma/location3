.PHONY: deploy-worker worker-dev

# Deploy the Cloudflare Worker using Wrangler.
deploy-worker:
	wrangler deploy

# Run wrangler dev for local preview of the Worker.
worker-dev:
	wrangler dev
