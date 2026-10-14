# What's Inside

Printable QR labels for storage bins. Scan a bin's label with your phone camera to see what's in it; edit contents from the admin page.

- `/` — fuzzy search across every bin and item
- `/bin/12` — what's in bin 12 (this is what the QR code opens)
- `/admin` — password-protected: create, edit and delete bins, select bins to print
- `/print?bins=1,2,3` — printable sheet of 2"×2" QR labels, 9 per letter page

Plain HTML/CSS/JS, one Netlify Function (`netlify/functions/api.mjs`) and [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/) for storage. No build step.

## Deploy

1. Push this repo to GitHub and import it in Netlify (**Add new site → Import an existing project**). The settings in `netlify.toml` are picked up automatically.
2. In **Site configuration → Environment variables**, add `ADMIN_PASSWORD` with the password you want for `/admin`. Redeploy after adding it.
3. Go to `/admin`, log in, and add bins.

Pick your final domain (custom domain or `*.netlify.app` name) **before printing labels** — the QR codes contain the full URL. Codes always use the site's main URL, even when printed from a deploy preview.

Changing `ADMIN_PASSWORD` logs out every device.

## Printing

Select bins in the admin list and click **Print labels** (or **Print label** while editing a bin). In the print dialog, set scale to **100% / Actual size** (not "Fit to page") so the codes come out at exactly 2". Cut along the dashed lines and tape on.

## Local development

```bash
npm install
echo "ADMIN_PASSWORD=pick-something" > .env
npm run dev
```

Opens at http://localhost:8888. Local bin data is stored under `.netlify/` and is separate from the live site's data.
