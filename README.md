# 🌩️ Cloudflare DDNS for UniFi OS

[![Code Coverage](https://github.com/jalaziz/unifi-cloudflare-ddns/actions/workflows/coverage.yml/badge.svg)](https://github.com/jalaziz/unifi-cloudflare-ddns/actions/workflows/coverage.yml)

Fork of [willswire/unifi-ddns](https://github.com/willswire/unifi-ddns).

A Cloudflare Worker script that enables UniFi devices (e.g., UDM-Pro, USG) to dynamically update DNS A/AAAA records on Cloudflare.

## Why Use This?

> **Note:** UniFi Network Application 9.1.92+ includes native Cloudflare DDNS support. If your gateway runs this firmware or newer, you may not need this worker. However, the native implementation does not support multi-hostname updates, dual-stack (IPv4 + IPv6), or preserving proxy status — this worker remains useful for those use cases and for older firmware.

UniFi devices running older firmware do not natively support Cloudflare as a DDNS provider. This script bridges that gap, allowing your UniFi device to keep your DNS records updated with your public IP address.

## 🚀 **Setup Overview**

### 1. **Deploy the Cloudflare Worker**

#### **Option 1: Workers Builds (deploy from Git)**
1. Fork this repository.
2. In the Cloudflare Dashboard, go to **Workers & Pages > Create > Import a repository** and select your fork.
3. Keep the Worker name equal to `name` in `wrangler.jsonc` (`unifi-cloudflare-ddns`).
4. Leave the build command empty; the deploy command defaults to `npx wrangler deploy`.
5. Every push to `main` now deploys automatically. Note the `*.workers.dev` route.

#### **Option 2: Deploy with Wrangler CLI**
1. Clone this repository.
2. Install [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/).
3. Run:
   ```sh
   npm i
   wrangler login
   wrangler deploy
   ```
4. Note the `*.workers.dev` route.

### 2. **Generate a Cloudflare API Token**

1. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Create either kind of token:
   - **Account API Token** (recommended; not tied to a user): **Manage Account > Account API Tokens**
   - **User API Token**: **Profile > API Tokens**
3. Use the **Edit zone DNS** template (Zone — Zone: Read, Zone — DNS: Edit).
4. Scope the token to the zone(s) containing your hostnames. One token can cover multiple domains.
5. Save the token securely.

### 3. **Configure UniFi OS**

1. Log in to your [UniFi OS Controller](https://unifi.ui.com/).
2. Go to **Settings > Internet > WAN > Dynamic DNS**.
3. Create New Dynamic DNS with the following information:
   - **Service:** `custom`
   - **Hostname:** `subdomain.example.com` or `example.com`
   - **Username:** Any non-empty value, e.g. your Cloudflare email *(not used by the worker)*
   - **Password:** Cloudflare API Token (Account or User)
   - **Server:** `<worker-name>.<worker-subdomain>.workers.dev/update?ip=%i&hostname=%h`
     *(Omit `https://`)*

## 🛠️ **Testing & Troubleshooting**

Using this script with various Ubiquiti devices and different UniFi software versions can introduce unique challenges. If you encounter issues, start by checking the FAQ in `/docs/faq.md`. If you don’t find a solution, you can ask a question on the [discussions page](https://github.com/willswire/unifi-ddns/discussions/new?category=q-a). If the problem persists, please raise an issue [here](https://github.com/willswire/unifi-ddns/issues).
