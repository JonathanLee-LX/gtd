/**
 * Generate a VAPID key pair for web push (#123).
 * Print lines for .dev.vars. Do not commit the private key.
 *
 *   node scripts/generate-vapid.mjs
 *
 * Local: paste into .dev.vars
 * Prod:  wrangler secret put VAPID_PUBLIC_KEY
 *        wrangler secret put VAPID_PRIVATE_KEY
 *        wrangler secret put VAPID_SUBJECT   (optional, mailto: or https:)
 */
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
let binary = "";
for (const byte of raw) binary += String.fromCharCode(byte);
const publicKey = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${JSON.stringify(jwk)}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");
