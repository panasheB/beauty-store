# Petal & Pestle — beauty store with EcoCash payments

## Run it
1. Install Node.js 18 or newer.
2. `npm install`
3. Copy `.env.example` to `.env` and fill in `ECOCASH_USERNAME`, `ECOCASH_PASSWORD` and `ADMIN_KEY`.
4. `npm start`
5. Store: http://localhost:3000  ·  Refunds: http://localhost:3000/admin.html

## How it works
| Step | What happens | EcoCash API |
|---|---|---|
| Customer pays | Enters their EcoCash number; they get a PIN prompt on their phone | Charge |
| Page waits | Polls every 3 s until the payment is PAID or FAILED | Transaction lookup |
| You refund | Open /admin.html, enter your admin key, click Refund on a PAID order | Refund |

Your EcoCash username and password stay on the server (`server.js`). The browser never sees them.
Prices are checked on the server, so customers can't change what they pay.
Orders are saved in `data/orders.json`.

## Things to check against the real sandbox
- Every EcoCash response is printed in the terminal (`[charge]`, `[refund]`) and stored on the order. If the status words differ from what `interpret()` in `server.js` expects, adjust that one function.
- The refund needs the `ecocashReference` from the charge/lookup response. If it isn't captured automatically, the admin page shows a box to paste it.
- Each refund uses a fresh `clientCorrelator`. Your sample reused the charge's one; if the sandbox demands that, change `rid` in the refund route to `order.id`.
- Before going live: switch `ECOCASH_BASE_URL` to the production URL, use real merchant details, and serve over HTTPS.
