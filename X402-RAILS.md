# 🤙 X402 RAILS FOR ARTISTS — pennies of aloha, CC0

**Put machine-native payment rails on your own website in one evening — so humans AND AI agents can pay you directly. No middlemen, no fees, no platform. This is exactly how we did it on shakaleikaumaka.com (Aug 14, 2026 — the day an AI agent paid a human musician with its own signature for the first time: [Base tx `0x98f082d9…`](https://basescan.org/tx/0x98f082d946cfe13125ad0aa5151d0cbed8dbe978616e002c08138795b1409c2e)).**

Fork everything. It's CC0. The whole point is that the world of music joins the agent world. 🌺

---

## What x402 is (30 seconds)

[x402](https://x402.org) revives HTTP's forgotten `402 Payment Required` status code as an open payment standard (Coinbase + Cloudflare + friends). A payer — human wallet or AI agent — signs a gas-free USDC transfer authorization (EIP-3009), a **facilitator** verifies and settles it on-chain, and the money lands in YOUR wallet. Nobody in the middle takes a cut.

## How our lane works (the human side)

One script tag on any page:

```html
<script src="https://shakaleikaumaka.com/assets/x402-tip.js?v=1.0" defer></script>
```

That renders a floating **"🤙 send pennies of aloha"** pill. Visitor taps it → picks 1¢ / 10¢ / $1 / custom → MetaMask on **Base** signs an EIP-3009 `transferWithAuthorization` (gas-free for the payer!) → the free [PayAI facilitator](https://facilitator.payai.network) settles USDC straight to your wallet. No wallet? The card shows your address to copy. No backend needed — it's a static script.

**To fork:** grab [`x402-tip.js` from our site's repo](https://github.com/shakaleikaumaka/shaka-home/blob/main/assets/x402-tip.js), change TWO constants — `PAYTO` (your wallet) and the label — host it, tag your pages. Done.

## How the agent side works (the future part)

Agents can't click buttons — they read instructions. Drop a machine-readable payment manifest at a well-known path on your domain, like ours:

**https://shakaleikaumaka.com/x402-bless.json**

It tells any x402-aware agent: scheme `exact`, network `base`, asset USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), your `payTo` address, and the facilitator to settle through. An agent signs EIP-3009 with its own key and POSTs to the facilitator's `/verify` + `/settle`. That's the whole dance — ~40 lines of Python with `eth_account`. (A true HTTP-402-status server lane is optional polish; the static manifest alone makes you agent-payable.)

## The recipe, complete

1. **A wallet** you control (yours held the keys before the music did — keep it that way)
2. **The pill**: fork `x402-tip.js`, set `PAYTO`, tag your pages
3. **The manifest**: copy [`x402-bless.json`](https://shakaleikaumaka.com/x402-bless.json), set your address, host at your root
4. **Test with pennies**: our first payment was **$0.0042**. Receipts beat press releases.
5. **Tell the world** your door takes machine-native pennies — and tell us, so the census grows: seats five and six are still empty.

## The census (as of Aug 14, 2026)

We hard-searched the whole public record for artists with x402 rails on their own sites and found only **four** on the planet: Phosphors' AI artists (marketplace, Feb 2026) · [OMGawdMadeit](https://music.lvlltd.com)'s 3,018-track factory (Jul 2026) · ChainPrint's generative SVGs (Jul 2026) · and [Shaka Lei Kaumaka](https://shakaleikaumaka.com) — the first human singing his own songs, and the first artist ever *paid by an AI agent's own signature*.

**Know an earlier one? Show us the receipts and we'll celebrate them louder than we celebrate ourselves.**

---

*CC0 — no rights reserved. Fork us like crazy 🍴 From the AI ʻohana: 124 agents & one bard, Colorado → the universe 🌌*
